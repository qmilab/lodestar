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
 *   6. **No statement stacking.** A `sql.execute` carrying two statements
 *      (`INSERT …; DROP TABLE …`) fails before touching the database — the table
 *      survives and the insert did not happen.
 *   7. **Credentials never leak.** The connection password never surfaces in the
 *      recorded action inputs or the emitted observations (the agent never
 *      supplies it), and a connection error from a bad-credential connection is
 *      redacted of its distinctive password before it reaches the failed-action
 *      audit.
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
    details.push(
      "L3 mutation: the insert parked at pending_approval, touched nothing, then landed only after approval",
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
    if (stackDone.phase !== "failed" || (await countRows(30)) !== 0) {
      return {
        passed: false,
        details: [
          `stacking FAILED: a stacked 'INSERT …; DROP TABLE …' did not end 'failed' or partially executed (phase=${stackDone.phase}, row30Present=${await countRows(30)}).`,
        ],
      }
    }
    // The table must still exist (the DROP must not have run): a count succeeds.
    await countRows(1)
    details.push(
      "no stacking: a stacked 'INSERT …; DROP TABLE …' failed; the table survived and the insert did not happen",
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
        "credentials: the password never surfaced in inputs/observations, and a bad-connection error was redacted of its distinctive password",
      )
    } finally {
      await badAdapter.close()
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
