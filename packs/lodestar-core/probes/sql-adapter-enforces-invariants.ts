#!/usr/bin/env bun
/**
 * Probe: sql_adapter_enforces_invariants
 *
 * Locks the governance invariants of the native SQL tools
 * (`@qmilab/lodestar-adapter-sql`: `sql.query` / `sql.execute`) by driving the
 * REAL adapter tools through the REAL Action Kernel
 * (propose → arbitrate → resolve → execute) against a REAL Postgres database.
 * SQL is the first native adapter whose headline teeth is an INJECTION boundary
 * rather than (only) egress, so these are the things that MUST hold:
 *
 *   1. **L1 read returns rows.** A `sql.query` (read) at L1 auto-approves and
 *      returns the seeded rows as (untrusted) inbound content.
 *   2. **Result-row cap.** A query that returns more than the cap is trimmed to
 *      the cap and flagged `truncated` — a huge result cannot inflate an
 *      observation.
 *   2b. **Bounded fetch (#101).** The cap bounds the FETCH, not just the captured
 *      slice: a hundred-million-row `generate_series` capped at 2 completes via a
 *      server-side cursor that pulls at most `maxRows+1` rows — so the host never
 *      buffers the full result. A regression to materialize-then-slice would time
 *      out / exhaust memory / crash instead of returning 2 rows + `truncated`.
 *   3. **Read-only enforcement.** A write attempted through `sql.query` fails and
 *      mutates nothing — BOTH an obvious `DELETE` (lexical guard) AND a
 *      data-modifying CTE (`WITH … DELETE … RETURNING`) that the lexical guard
 *      waves through but the `READ ONLY` transaction makes the database itself
 *      refuse. This is what makes the L1/L3 read-vs-mutation split real.
 *   4. **Mutation holds at L3.** A `sql.execute` (INSERT) parks at
 *      `pending_approval` under a holding policy and writes NOTHING to the
 *      database while it waits. Only after `resolve(granted)` + `execute` does the
 *      row land.
 *   5. **Parameterized-only beats injection (the headline).** A `sql.execute`
 *      whose parameter value is `Robert'); DROP TABLE …;--` stores that string
 *      LITERALLY — the table still exists and the value round-trips verbatim. The
 *      value was bound, never interpreted as SQL.
 *   6. **No statement stacking — both protocol paths.** A `sql.execute` carrying
 *      two statements (`INSERT …; DROP TABLE …`) fails before touching the database
 *      — the table survives and the insert did not happen — tested BOTH with bound
 *      params (the extended protocol rejects it) AND parameterless (where
 *      `sql.unsafe(stmt, [])` falls back to the simple protocol that WOULD permit
 *      stacking, so the lexical single-statement guard is the sole structural
 *      defence).
 *   7. **Credentials never leak.** The connection password never surfaces in the
 *      recorded action inputs or the emitted observations (the agent never
 *      supplies it), and a connection error from a bad-credential connection is
 *      redacted of its distinctive password before it reaches the failed-action
 *      audit.
 *   8. **Non-Postgres URL fails clearly (#101 ride-along).** A `mysql://` connection
 *      fails fast with a message that names Postgres as the requirement — not a
 *      confusing generic mid-query error — and never leaks the password it carries.
 *
 * If any of these regress, a Lodestar-wrapped agent could SQL-inject through a
 * bound parameter, mutate the database through the read tool, write without a
 * human in the loop, stack a destructive second statement, or leak the database
 * password into the log — so this probe is spec, not test scaffolding.
 *
 * Persistence requirement:
 *   This probe needs a real Postgres database (Bun's native `Bun.SQL`). It reads
 *   `LODESTAR_TEST_DATABASE_URL`; when that is unset it SKIPS with a loud banner
 *   and exits 0, exactly like the memory-firewall Postgres tests and the
 *   tool-poisoning-cross-session probe. CI sets the variable against a
 *   `postgres:16` service, so the real path runs there.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { registerSqlTools } from "@qmilab/lodestar-adapter-sql"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"
import { SQL } from "bun"

interface ProbeResult {
  passed: boolean
  skipped?: boolean
  details: string[]
}

const DB_ENV = "LODESTAR_TEST_DATABASE_URL"

const BOBBY_TABLES = (table: string) => `Robert'); DROP TABLE ${table};--`

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-sql" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  const databaseUrl = process.env[DB_ENV]
  if (databaseUrl === undefined || databaseUrl === "") {
    return {
      passed: true,
      skipped: true,
      details: [
        `${DB_ENV} is not set — skipping. This probe needs a real Postgres database`,
        "to exercise the parameterized-injection boundary and the READ ONLY transaction.",
        "Point the var at a throwaway postgres:16 to run it (CI sets it against a",
        "postgres:16 service, so the real path is exercised there).",
      ],
    }
  }

  _resetToolsForTests()
  const details: string[] = []

  // A run-unique table so concurrent CI runs against the same database never
  // collide (the suffix keys the table name; only [0-9a-f] from a UUID).
  const table = `lodestar_sqlprobe_${crypto.randomUUID().replace(/-/g, "")}`

  // The probe's OWN connection, used to seed and to inspect the database
  // independently of the adapter — so "the row did/didn't land" is observed
  // through a different connection than the one the tool wrote on.
  const db = new SQL(databaseUrl)

  const observations: Observation[] = []
  const observationSink = async (obs: Observation): Promise<void> => {
    observations.push(obs)
  }
  // Three-valued gate: L3+ holds for human approval; below auto-approves.
  const policyGate: PolicyGate = async (action) => {
    if (action.contract.required_level >= 3) {
      return {
        approved: false,
        requires_human_approval: true,
        reason: "mutation requires human approval",
        approver_id: "probe.policy",
      }
    }
    return { approved: true, reason: "read auto-approved", approver_id: "probe.policy" }
  }
  const preconditionChecker: PreconditionChecker = async () => ({ holds: true, observed: null })

  // The adapter under test owns its OWN pool over the same database (so it
  // resolves the password itself, exercising the credential path). Small row cap
  // so the cap case trips while the seeded reads do not.
  const adapter = registerSqlTools({
    connection: { url: databaseUrl },
    query: { maxRows: 2 },
    execute: {},
  })

  const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
    useStubsForTests: true,
  })
  const propose = (tool: string, inputs: unknown, contract: ActionContract) =>
    kernel.propose({ intent: `probe ${tool}`, tool, inputs, contract, proposed_by: "probe.sql" })
  const grant = (action: { id: string }, reqId: string) => ({
    kind: "granted" as const,
    action_id: action.id,
    request_id: reqId,
    approver_id: "probe.human",
  })
  const READ = () => contractFor(1, "session", "reversible")
  const WRITE = () => contractFor(3, "project", "irreversible")
  const outputOf = (id: string): Record<string, unknown> | undefined =>
    observations.find((o) => o.source.invocation_id === id)?.payload as
      | Record<string, unknown>
      | undefined
  const countRows = async (id: number): Promise<number> => {
    const rows = (await db.unsafe(`select count(*)::int as c from ${table} where id = $1`, [
      id,
    ])) as Array<{ c: number }>
    return rows[0]?.c ?? 0
  }

  try {
    // Seed: a tiny table with two rows.
    await db.unsafe(`create table ${table} (id int primary key, name text not null)`)
    await db.unsafe(`insert into ${table} (id, name) values ($1, $2), ($3, $4)`, [
      1,
      "alice",
      2,
      "bob",
    ])

    // ---- 1. L1 read auto-approves and returns rows ------------------------
    const readAction = await kernel.execute(
      await kernel.arbitrate(
        propose("sql.query", { statement: `select id, name from ${table} order by id` }, READ()),
      ),
    )
    if (readAction.phase !== "completed") {
      return {
        passed: false,
        details: [
          `L1 read FAILED: sql.query did not complete (phase=${readAction.phase}); audit: ${JSON.stringify(readAction.audit.at(-1))}`,
        ],
      }
    }
    const readOut = outputOf(readAction.id)
    const readRows = (readOut?.rows ?? []) as Array<{ id?: number; name?: string }>
    if (readRows.length !== 2 || readRows[0]?.name !== "alice" || readRows[1]?.name !== "bob") {
      return {
        passed: false,
        details: [
          `L1 read FAILED: expected 2 seeded rows alice/bob, got ${JSON.stringify(readRows)}`,
        ],
      }
    }
    if (JSON.stringify(readOut?.columns) !== JSON.stringify(["id", "name"])) {
      return {
        passed: false,
        details: [
          `L1 read FAILED: expected columns [id,name], got ${JSON.stringify(readOut?.columns)}`,
        ],
      }
    }
    // The at-cap result (2 rows, cap 2) must NOT be flagged truncated — pins the
    // cap boundary as `>` not `>=`, so case 2's `truncated === true` is meaningful.
    if (readOut?.truncated !== false) {
      return {
        passed: false,
        details: [
          `L1 read FAILED: an at-cap (2 of 2) result was wrongly flagged truncated=${JSON.stringify(readOut?.truncated)} — off-by-one in the row cap.`,
        ],
      }
    }
    details.push("L1 read: sql.query auto-approved and returned the two seeded rows")

    // ---- 2. Result-row cap ------------------------------------------------
    const capAction = await kernel.execute(
      await kernel.arbitrate(
        propose("sql.query", { statement: "select n from generate_series(1, 5) as n" }, READ()),
      ),
    )
    const capOut = outputOf(capAction.id)
    if (capAction.phase !== "completed" || capOut?.row_count !== 2 || capOut?.truncated !== true) {
      return {
        passed: false,
        details: [
          `row cap FAILED: a 5-row result was not trimmed to the cap of 2 and flagged truncated (phase=${capAction.phase}, out=${JSON.stringify(capOut)})`,
        ],
      }
    }
    details.push("row cap: a 5-row result was trimmed to 2 and flagged truncated")

    // ---- 2b. Bounded fetch — the cap bounds the FETCH, not just the slice ---
    // #101: a SELECT-family read runs through a server-side cursor and FETCHes at
    // most maxRows+1 rows, so the host buffers a bounded number of rows REGARDLESS
    // of how large the full result is. We ask for a hundred-million-row series with
    // a cap of 2: the cursor FETCHes 3 rows (a few bytes, ~tens of ms — it streams
    // exactly like a SeqScan of a huge table) and returns 2 + truncated. A
    // regression to the old materialize-then-slice path would instead try to buffer
    // 100M rows into the host process before trimming — it would exhaust memory or
    // trip statement_timeout and end 'failed' (or crash the probe), never completing
    // with 2 rows. So a clean PASS here IS the proof the fetch is bounded. (The SRF
    // sits in the target list so it streams via ProjectSet; no ORDER BY/GROUP BY,
    // which would force a blocking sort of the whole series before the first row.)
    const boundedAction = await kernel.execute(
      await kernel.arbitrate(
        propose("sql.query", { statement: "select generate_series(1, 100000000) as g" }, READ()),
      ),
    )
    const boundedOut = outputOf(boundedAction.id)
    if (
      boundedAction.phase !== "completed" ||
      boundedOut?.row_count !== 2 ||
      boundedOut?.truncated !== true
    ) {
      return {
        passed: false,
        details: [
          ...details,
          `bounded fetch FAILED: a 100,000,000-row generate_series capped at 2 did not complete with exactly 2 rows + truncated (phase=${boundedAction.phase}, out=${JSON.stringify(boundedOut)}). The server-side cursor must bound the FETCH — a regression that materializes the full result before trimming would time out, exhaust memory, or crash here.`,
        ],
      }
    }
    details.push(
      "bounded fetch: a 100M-row generate_series capped at 2 completed instantly via the server-side cursor (FETCH bounded, host memory not ballooned)",
    )

    // ---- 3. Read-only enforcement (lexical + READ ONLY transaction) -------
    // 3a: an obvious DELETE through the read tool is rejected lexically.
    const delDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "sql.query",
          { statement: `delete from ${table} where id = $1`, params: [1] },
          READ(),
        ),
      ),
    )
    if (delDone.phase !== "failed" || (await countRows(1)) !== 1) {
      return {
        passed: false,
        details: [
          `read-only (lexical) FAILED: a DELETE through sql.query did not end 'failed' or mutated a row (phase=${delDone.phase}, row1Present=${await countRows(1)}).`,
        ],
      }
    }
    // 3b: a data-modifying CTE leads with WITH (lexical guard passes) but the
    // READ ONLY transaction makes the database itself refuse it.
    const cteDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "sql.query",
          {
            statement: `with d as (delete from ${table} where id = $1 returning id) select id from d`,
            params: [2],
          },
          READ(),
        ),
      ),
    )
    if (cteDone.phase !== "failed" || (await countRows(2)) !== 1) {
      return {
        passed: false,
        details: [
          `read-only (CTE) FAILED: a data-modifying CTE through sql.query did not end 'failed' or mutated a row (phase=${cteDone.phase}, row2Present=${await countRows(2)}). The READ ONLY transaction did not hold.`,
        ],
      }
    }
    details.push(
      "read-only: both a DELETE (lexical) and a data-modifying CTE (READ ONLY transaction) failed and mutated nothing",
    )

    // ---- 4. Mutation holds at L3, touches nothing while held --------------
    const heldInsert = await kernel.arbitrate(
      propose(
        "sql.execute",
        {
          statement: `insert into ${table} (id, name) values ($1, $2)`,
          params: [10, "held-insert"],
        },
        WRITE(),
      ),
    )
    if (heldInsert.phase !== "pending_approval") {
      return {
        passed: false,
        details: [
          `L3 hold FAILED: sql.execute did not park at pending_approval (phase=${heldInsert.phase}).`,
        ],
      }
    }
    if ((await countRows(10)) !== 0) {
      return {
        passed: false,
        details: [
          "L3 hold FAILED: the row was inserted while the action was only pending_approval — a held mutation touched the database.",
        ],
      }
    }
    const insertDone = await kernel.execute(
      kernel.resolve(heldInsert, grant(heldInsert, "req-ins")),
    )
    if (insertDone.phase !== "completed" || (await countRows(10)) !== 1) {
      return {
        passed: false,
        details: [
          `L3 mutation FAILED: the approved insert did not complete or land (phase=${insertDone.phase}, row10Present=${await countRows(10)}).`,
        ],
      }
    }
    // Pin the reported rows_affected (the driver's `.count`) — a regression that
    // lost the count would report 0 affected for a successful single-row insert.
    if (outputOf(insertDone.id)?.rows_affected !== 1) {
      return {
        passed: false,
        details: [
          `L3 mutation FAILED: rows_affected was ${JSON.stringify(outputOf(insertDone.id)?.rows_affected)}, expected 1 — the driver row count was lost.`,
        ],
      }
    }
    details.push(
      "L3 mutation: the insert parked at pending_approval, touched nothing, then landed (rows_affected=1) only after approval",
    )

    // ---- 5. Parameterized-only beats injection (Bobby Tables) -------------
    const inj = await kernel.arbitrate(
      propose(
        "sql.execute",
        {
          statement: `insert into ${table} (id, name) values ($1, $2)`,
          params: [20, BOBBY_TABLES(table)],
        },
        WRITE(),
      ),
    )
    const injDone = await kernel.execute(kernel.resolve(inj, grant(inj, "req-inj")))
    if (injDone.phase !== "completed") {
      return {
        passed: false,
        details: [
          `injection FAILED: the parameterized insert did not complete (phase=${injDone.phase}); audit: ${JSON.stringify(injDone.audit.at(-1))}`,
        ],
      }
    }
    // The table must still exist (the DROP did NOT execute) and the value must
    // round-trip LITERALLY.
    const storedRows = (await db.unsafe(`select name from ${table} where id = $1`, [20])) as Array<{
      name?: string
    }>
    if (storedRows[0]?.name !== BOBBY_TABLES(table)) {
      return {
        passed: false,
        details: [
          `injection FAILED: the hostile value was not stored literally (got ${JSON.stringify(storedRows[0]?.name)}). The parameter may have been interpreted as SQL.`,
        ],
      }
    }
    details.push(
      "parameterized-only: a `'); DROP TABLE …;--` parameter was stored as a literal string; the table survived",
    )

    // ---- 6. No statement stacking ----------------------------------------
    const stack = await kernel.arbitrate(
      propose(
        "sql.execute",
        {
          statement: `insert into ${table} (id, name) values ($1, $2); drop table ${table}`,
          params: [30, "x"],
        },
        WRITE(),
      ),
    )
    const stackDone = await kernel.execute(kernel.resolve(stack, grant(stack, "req-stk")))
    // countRows throws if the table was dropped, so guard it: row30 stays -1 (≠ 0)
    // if either the DROP ran (table gone) or the INSERT landed — both are failures.
    let row30 = -1
    try {
      row30 = await countRows(30)
    } catch {
      /* table dropped — handled by the row30 !== 0 check below */
    }
    if (stackDone.phase !== "failed" || row30 !== 0) {
      return {
        passed: false,
        details: [
          `stacking FAILED: a stacked 'INSERT …; DROP TABLE …' (bound params) did not end 'failed' or partially executed (phase=${stackDone.phase}, row30=${row30} — -1 means the table was dropped).`,
        ],
      }
    }
    details.push(
      "no stacking (bound params): a stacked 'INSERT …; DROP TABLE …' failed; the table survived and the insert did not happen",
    )

    // ---- 6b. No statement stacking — the PARAMETERLESS path ---------------
    // With NO bound parameters, `sql.unsafe(stmt, [])` falls back to Postgres's
    // SIMPLE protocol, which DOES permit `;`-separated commands — so the extended-
    // protocol backstop does NOT apply and the lexical single-statement guard is
    // the SOLE structural defence. Sub-case 6 used bound params (where the protocol
    // also rejects), so it never exercised this path; this one does.
    const stackNp = await kernel.arbitrate(
      propose(
        "sql.execute",
        { statement: `insert into ${table} (id, name) values (41, 'np'); drop table ${table}` },
        WRITE(),
      ),
    )
    const stackNpDone = await kernel.execute(kernel.resolve(stackNp, grant(stackNp, "req-stk-np")))
    let row41 = -1
    try {
      row41 = await countRows(41)
    } catch {
      /* table dropped — handled by the row41 !== 0 check below */
    }
    if (stackNpDone.phase !== "failed" || row41 !== 0) {
      return {
        passed: false,
        details: [
          ...details,
          `stacking (parameterless) FAILED: a stacked statement with NO bound params — where the simple protocol WOULD permit it — was not rejected (phase=${stackNpDone.phase}, row41=${row41} — -1 means the table was dropped). The lexical single-statement guard is the sole defence here and it must hold.`,
        ],
      }
    }
    details.push(
      "no stacking (parameterless): a stacked statement with NO bound params — the simple-protocol path the extended protocol does NOT guard — was rejected by the lexical guard; the table survived",
    )

    // ---- 7a. Credentials never leak (valid connection) -------------------
    const password = (() => {
      try {
        return new URL(databaseUrl).password
      } catch {
        return ""
      }
    })()
    if (password.length >= 4) {
      const haystack = JSON.stringify({
        observations,
        inputs: [readAction.inputs, insertDone.inputs, injDone.inputs, stackDone.inputs],
      })
      if (haystack.includes(password)) {
        return {
          passed: false,
          details: [
            ...details,
            "credential leak FAILED: the connection password surfaced in a recorded action input or observation.",
          ],
        }
      }
    }

    // ---- 7b. A bad-credential connection error is redacted ---------------
    // Reset tools and register a query tool over a connection that cannot be
    // reached, carrying a DISTINCTIVE password. The connection error must be
    // scrubbed of that password before it reaches the failed-action audit.
    // NOTE: this is a real-error-path smoke test; whether the driver echoes the
    // connection string is outside our control, so the redaction MECHANISM itself
    // is the unit test's job (sql.test.ts, "extracts and redacts the password").
    _resetToolsForTests()
    const DISTINCTIVE_PW = "PROBE_DB_SECRET_deadbeefcafef00d"
    const badAdapter = registerSqlTools({
      // Port 1 has no server: the connection fails fast.
      connection: { url: `postgres://probeuser:${DISTINCTIVE_PW}@127.0.0.1:1/nope` },
      execute: false,
      query: { timeoutMs: 3000 },
    })
    try {
      const badDone = await kernel.execute(
        await kernel.arbitrate(propose("sql.query", { statement: "select 1 as one" }, READ())),
      )
      // Positive control: the unreachable connection MUST end the action 'failed'
      // (otherwise the redaction check below is over an empty/irrelevant audit).
      if (badDone.phase !== "failed") {
        return {
          passed: false,
          details: [
            ...details,
            `credential redaction setup FAILED: a query over an unreachable connection did not end 'failed' (phase=${badDone.phase}) — the redaction check would be vacuous.`,
          ],
        }
      }
      const badHaystack = JSON.stringify({
        audit: badDone.audit,
        observations: observations.filter((o) => o.source.invocation_id === badDone.id),
      })
      if (badHaystack.includes(DISTINCTIVE_PW)) {
        return {
          passed: false,
          details: [
            ...details,
            "credential redaction FAILED: a bad-connection error carried the distinctive password into the failed-action audit unredacted.",
          ],
        }
      }
      details.push(
        "credentials: the password never surfaced in inputs/observations, and a failed bad-connection action was redacted of its distinctive password",
      )
    } finally {
      await badAdapter.close()
    }

    // ---- 8. A non-Postgres connection URL fails early with a clear error ---
    // #101 ride-along: the tools are Postgres-shaped (READ ONLY transactions,
    // SET LOCAL statement_timeout, server-side cursors), so a mysql:// / sqlite://
    // connection cannot work. It must fail FAST with a message that names the
    // problem (Postgres-only) — not a confusing generic "sql.query failed" mid-query
    // — and must NOT leak the connection password it carries.
    _resetToolsForTests()
    const MYSQL_PW = "PROBE_MYSQL_SECRET_feedfacecafebeef"
    const mysqlAdapter = registerSqlTools({
      connection: { url: `mysql://probeuser:${MYSQL_PW}@127.0.0.1:1/nope` },
      execute: false,
      query: { timeoutMs: 3000 },
    })
    try {
      const mysqlDone = await kernel.execute(
        await kernel.arbitrate(propose("sql.query", { statement: "select 1 as one" }, READ())),
      )
      if (mysqlDone.phase !== "failed") {
        return {
          passed: false,
          details: [
            ...details,
            `non-Postgres URL FAILED: a mysql:// connection did not end 'failed' (phase=${mysqlDone.phase}).`,
          ],
        }
      }
      const mysqlAudit = JSON.stringify(mysqlDone.audit)
      if (!/postgres/i.test(mysqlAudit)) {
        return {
          passed: false,
          details: [
            ...details,
            `non-Postgres URL FAILED: the failure did not clearly name Postgres as the cause — a confusing generic error instead. audit: ${JSON.stringify(mysqlDone.audit.at(-1))}`,
          ],
        }
      }
      if (mysqlAudit.includes(MYSQL_PW)) {
        return {
          passed: false,
          details: [
            ...details,
            "non-Postgres URL FAILED: the connection password leaked into the failed-action audit.",
          ],
        }
      }
      details.push(
        "non-Postgres URL: a mysql:// connection scheme failed early with a clear 'only Postgres' error, password not leaked",
      )
    } finally {
      await mysqlAdapter.close()
    }

    return { passed: true, details }
  } finally {
    await adapter.close()
    try {
      await db.unsafe(`drop table if exists ${table}`)
    } finally {
      await db.end()
    }
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: sql_adapter_enforces_invariants")
console.log("─".repeat(72))
const status = result.skipped ? "SKIP ⊘" : result.passed ? "PASS ✓" : "FAIL ✗"
console.log(`status: ${status}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
