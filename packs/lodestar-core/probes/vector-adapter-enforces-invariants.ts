#!/usr/bin/env bun
/**
 * Probe: vector_adapter_enforces_invariants
 *
 * Locks the governance invariants of the native Vector/RAG tool
 * (`@qmilab/lodestar-adapter-vector`: `vector.query`) by driving the REAL
 * adapter tool through the REAL Action Kernel (propose → arbitrate → execute)
 * against a REAL Postgres + pgvector index. Vector retrieval is the first native
 * adapter whose governance surface is INBOUND retrieval (the RAG poisoning
 * surface), so these are the things that MUST hold:
 *
 *   1. **L1 read returns nearest chunks.** A `vector.query` at L1 auto-approves
 *      and returns the nearest seeded chunks (untrusted inbound content), ordered
 *      by distance.
 *   2. **Top-k cap (bounded server-side).** A query whose index has more matches
 *      than the cap returns exactly the cap and flags `truncated` — the `LIMIT`
 *      bounds the fetch in the database, so a huge index cannot inflate an
 *      observation.
 *   3. **Pinned namespace allowlist.** A query to a namespace the operator did
 *      not allowlist FAILS — never silently widened to the whole index.
 *   4. **Namespace isolation.** A query in one namespace never returns another
 *      namespace's rows (the `WHERE ns = $2` filter binds).
 *   5. **Parameterized values beat injection.** A namespace value containing
 *      `'); DROP TABLE …;--` is BOUND (matched as a literal) — it returns its
 *      seeded row and the table still exists; the embedding is bound `$1::vector`.
 *   6. **Dimension guard.** A query embedding of the wrong dimensionality FAILS
 *      with a clear error rather than a confusing mid-query failure.
 *   7. **NULL embeddings are filtered, not fatal.** A namespace with an
 *      unembedded row (NULL embedding → NULL/NaN distance) still completes and
 *      returns only the real rows — the `embedding IS NOT NULL` filter excludes
 *      the bad row instead of failing output validation on a NaN.
 *   8. **Per-chunk content cap.** An oversized chunk is trimmed to the cap (in
 *      SQL) and flagged `content_truncated`, so a poisoned/oversized row cannot
 *      balloon the observation — bounded capture per chunk, not just per row.
 *   9. **Content round-trips faithfully + credentials never leak.** The chunk
 *      text is returned verbatim (within the cap) as untrusted content; the
 *      connection password never surfaces in the recorded inputs/observations,
 *      and a bad-connection error is redacted before it reaches the audit.
 *
 * If any of these regress, a Lodestar-wrapped RAG agent could read an
 * un-allowlisted namespace, leak rows across namespaces, inflate an observation
 * with a huge result, or leak the database password into the log.
 *
 * Persistence requirement:
 *   Needs a real Postgres with the `pgvector` extension (Bun's native `Bun.SQL`).
 *   Reads `LODESTAR_TEST_DATABASE_URL`; when unset it SKIPS with a loud banner and
 *   exits 0, exactly like the SQL probe. It also skips (loudly) if the database
 *   has no `pgvector` extension available. CI runs it against a
 *   `pgvector/pgvector:pg16` service.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { registerVectorTools } from "@qmilab/lodestar-adapter-vector"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"
import { SQL } from "bun"

interface ProbeResult {
  passed: boolean
  skipped?: boolean
  details: string[]
}

const DB_ENV = "LODESTAR_TEST_DATABASE_URL"
const INJ_NS = (table: string) => `r0b'); DROP TABLE ${table};--`

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-vector" },
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
        `${DB_ENV} is not set — skipping. This probe needs a real Postgres + pgvector`,
        "index to exercise namespace pinning, the top-k cap, and parameterized binding.",
        "Point the var at a throwaway pgvector/pgvector:pg16 to run it (CI sets it",
        "against a pgvector service, so the real path is exercised there).",
      ],
    }
  }

  const db = new SQL(databaseUrl)
  // pgvector availability gate: a plain postgres:16 has no `vector` type. Skip
  // loudly rather than fail when the extension is unavailable.
  try {
    await db.unsafe("create extension if not exists vector")
  } catch (err) {
    await db.end()
    return {
      passed: true,
      skipped: true,
      details: [
        "the connected database has no `pgvector` extension available — skipping.",
        `(create extension vector failed: ${err instanceof Error ? err.message : String(err)})`,
        "Use a pgvector/pgvector:pg16 image (CI does) to run the real path.",
      ],
    }
  }

  _resetToolsForTests()
  const details: string[] = []
  const table = `lodestar_vecprobe_${crypto.randomUUID().replace(/-/g, "")}`

  const observations: Observation[] = []
  const observationSink = async (obs: Observation): Promise<void> => {
    observations.push(obs)
  }
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

  // The adapter under test owns its own pool over the same database (so it
  // resolves the password itself). Cap of 2 so the top-k case trips.
  const adapter = registerVectorTools({
    connection: { url: databaseUrl },
    query: {
      table,
      idColumn: "id",
      contentColumn: "content",
      embeddingColumn: "embedding",
      namespaceColumn: "ns",
      namespaces: ["docs", "wiki", "sparse", "big", "longid", INJ_NS(table)],
      metadataColumns: ["ns"],
      metric: "cosine",
      dimensions: 3,
      maxTopK: 2,
      maxChunkChars: 16,
      maxIdChars: 36,
      timeoutMs: 5000,
    },
  })

  const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
    useStubsForTests: true,
  })
  const propose = (tool: string, inputs: unknown, contract: ActionContract) =>
    kernel.propose({ intent: `probe ${tool}`, tool, inputs, contract, proposed_by: "probe.vector" })
  const READ = () => contractFor(1, "session", "reversible")
  const outputOf = (id: string): Record<string, unknown> | undefined =>
    observations.find((o) => o.source.invocation_id === id)?.payload as
      | Record<string, unknown>
      | undefined
  const queryVec = async (embedding: number[], namespace?: string, top_k?: number) =>
    kernel.execute(
      await kernel.arbitrate(propose("vector.query", { embedding, namespace, top_k }, READ())),
    )
  const tableExists = async (): Promise<boolean> => {
    const rows = (await db.unsafe("select to_regclass($1) as t", [table])) as Array<{ t: unknown }>
    return rows[0]?.t !== null && rows[0]?.t !== undefined
  }

  try {
    // Seed: a 3-dim pgvector index across namespaces.
    await db.unsafe(
      `create table ${table} (id text primary key, ns text not null, content text not null, embedding vector(3))`,
    )
    await db.unsafe(
      `insert into ${table} (id, ns, content, embedding) values ('d1','docs','alpha doc','[1,0,0]'),('d2','docs','beta doc','[0,1,0]'),('d3','docs','gamma doc','[0,0,1]'),('w1','wiki','wiki alpha','[1,0,0]'),($1,$2,'injection canary','[1,0,0]')`,
      ["inj1", INJ_NS(table)],
    )
    // A namespace whose only-other row has a NULL embedding (valid — the column
    // has no NOT NULL), a row with content longer than the per-chunk cap, and a
    // namespace with one short-id row + one oversized-id row (> maxIdChars).
    await db.unsafe(
      `insert into ${table} (id, ns, content, embedding) values ('s1','sparse','sparse real','[1,0,0]'),('s2','sparse','no embedding here',NULL),('big1','big',$1,'[1,0,0]'),('l1','longid','short id ok','[1,0,0]'),($2,'longid','oversized id','[1,0,0]')`,
      ["Z".repeat(200), `L${"o".repeat(60)}ng`],
    )

    // ---- 1. L1 read returns nearest chunks --------------------------------
    const read = await queryVec([1, 0, 0], "docs")
    if (read.phase !== "completed") {
      return {
        passed: false,
        details: [`L1 read FAILED: vector.query did not complete (phase=${read.phase}).`],
      }
    }
    const readOut = outputOf(read.id)
    const readMatches = (readOut?.matches ?? []) as Array<{ id?: string; content?: string }>
    if (readMatches[0]?.id !== "d1") {
      return {
        passed: false,
        details: [
          `L1 read FAILED: nearest chunk to [1,0,0] should be 'd1', got ${JSON.stringify(readMatches.map((m) => m.id))}`,
        ],
      }
    }
    // Content round-trips verbatim (assertion 7).
    if (readMatches[0]?.content !== "alpha doc") {
      return {
        passed: false,
        details: [
          `content FAILED: retrieved chunk text was not returned verbatim (got ${JSON.stringify(readMatches[0]?.content)})`,
        ],
      }
    }
    details.push(
      "L1 read: vector.query auto-approved and returned the nearest chunk 'd1' with verbatim content",
    )

    // ---- 2. Top-k cap (3 docs rows, cap 2) --------------------------------
    if (readOut?.match_count !== 2 || readOut?.truncated !== true) {
      return {
        passed: false,
        details: [
          `top-k cap FAILED: 3 docs rows capped at 2 should give match_count=2, truncated=true (got count=${readOut?.match_count}, truncated=${readOut?.truncated}).`,
        ],
      }
    }
    details.push(
      "top-k cap: a 3-match namespace capped at 2 returned 2 + truncated (LIMIT bounds the fetch server-side)",
    )

    // ---- 3. Pinned namespace allowlist ------------------------------------
    const denied = await queryVec([1, 0, 0], "secrets")
    if (denied.phase !== "failed") {
      return {
        passed: false,
        details: [
          ...details,
          `namespace allowlist FAILED: a query to the un-allowlisted 'secrets' namespace did not fail (phase=${denied.phase}).`,
        ],
      }
    }
    details.push(
      "namespace allowlist: a query to a non-allowlisted namespace failed (no silent widening)",
    )

    // ---- 4. Namespace isolation -------------------------------------------
    // A docs query must never surface the wiki row 'w1' (same embedding as d1).
    const isolatedMatches = (outputOf(read.id)?.matches ?? []) as Array<{ id?: string }>
    if (isolatedMatches.some((m) => m.id === "w1")) {
      return {
        passed: false,
        details: [
          ...details,
          "namespace isolation FAILED: a docs query returned a wiki-namespace row — the WHERE ns=$2 filter did not bind.",
        ],
      }
    }
    details.push("namespace isolation: a docs query never returned the wiki row (filter bound)")

    // ---- 5. Parameterized values beat injection ---------------------------
    const inj = await queryVec([1, 0, 0], INJ_NS(table))
    if (inj.phase !== "completed") {
      return {
        passed: false,
        details: [
          ...details,
          `injection FAILED: the query to the metacharacter namespace did not complete (phase=${inj.phase}).`,
        ],
      }
    }
    const injMatches = (outputOf(inj.id)?.matches ?? []) as Array<{ id?: string }>
    if (injMatches[0]?.id !== "inj1") {
      return {
        passed: false,
        details: [
          ...details,
          `injection FAILED: the metacharacter namespace did not match its seeded row (got ${JSON.stringify(injMatches.map((m) => m.id))}). The namespace may have been concatenated.`,
        ],
      }
    }
    if (!(await tableExists())) {
      return {
        passed: false,
        details: [
          ...details,
          "injection FAILED: the table was dropped — a `'); DROP TABLE …;--` namespace was interpreted as SQL rather than bound as a literal.",
        ],
      }
    }
    details.push(
      "parameterized values: a `'); DROP TABLE …;--` namespace matched as a literal; the table survived",
    )

    // ---- 6. Dimension guard -----------------------------------------------
    const badDim = await queryVec([1, 0], "docs")
    if (badDim.phase !== "failed") {
      return {
        passed: false,
        details: [
          ...details,
          `dimension guard FAILED: a 2-dim embedding against a 3-dim index did not fail (phase=${badDim.phase}).`,
        ],
      }
    }
    details.push("dimension guard: a wrong-dimension embedding failed with a clear error")

    // ---- 7. NULL embeddings are filtered, not fatal -----------------------
    // The 'sparse' namespace has one real row + one NULL-embedding row. pgvector
    // returns a NULL (→ NaN) distance for the unembedded row, which would fail
    // z.number() output validation; the `embedding IS NOT NULL` filter excludes
    // it. The query must complete and return only the real row.
    const sparse = await queryVec([1, 0, 0], "sparse")
    const sparseMatches = (outputOf(sparse.id)?.matches ?? []) as Array<{ id?: string }>
    if (
      sparse.phase !== "completed" ||
      sparseMatches.length !== 1 ||
      sparseMatches[0]?.id !== "s1"
    ) {
      return {
        passed: false,
        details: [
          ...details,
          `NULL-embedding handling FAILED: a namespace with a NULL-embedding row did not complete with exactly the real row (phase=${sparse.phase}, matches=${JSON.stringify(sparseMatches.map((m) => m.id))}). The IS NOT NULL filter must exclude unembedded rows, not fail the query on a NaN distance.`,
        ],
      }
    }
    details.push(
      "NULL embeddings: an unembedded row is filtered out, not a NaN that fails the query",
    )

    // ---- 8. Per-chunk content cap (bounded untrusted capture) -------------
    // The 'big' namespace holds a 200-char chunk; with maxChunkChars=16 the
    // returned content is trimmed to the cap and flagged, so a poisoned/oversized
    // row cannot balloon the observation.
    const big = await queryVec([1, 0, 0], "big")
    const bigMatch = (
      (outputOf(big.id)?.matches ?? []) as Array<{
        content?: string
        content_truncated?: boolean
      }>
    )[0]
    if (
      big.phase !== "completed" ||
      (bigMatch?.content?.length ?? 0) !== 16 ||
      bigMatch?.content_truncated !== true
    ) {
      return {
        passed: false,
        details: [
          ...details,
          `content cap FAILED: a 200-char chunk capped at 16 did not return 16 chars + content_truncated (phase=${big.phase}, len=${bigMatch?.content?.length}, truncated=${bigMatch?.content_truncated}).`,
        ],
      }
    }
    details.push(
      "content cap: a 200-char untrusted chunk was trimmed to 16 chars and flagged content_truncated",
    )

    // ---- 8b. Oversized ids are filtered (bounded, not truncated) ----------
    // The 'longid' namespace has a short-id row + a >maxIdChars-id row. The
    // oversized id is FILTERED (an id can't be truncated without colliding), so
    // only the short-id row returns — bounding the id transfer.
    const longid = await queryVec([1, 0, 0], "longid")
    const longidMatches = (outputOf(longid.id)?.matches ?? []) as Array<{ id?: string }>
    if (
      longid.phase !== "completed" ||
      longidMatches.length !== 1 ||
      longidMatches[0]?.id !== "l1"
    ) {
      return {
        passed: false,
        details: [
          ...details,
          `oversized-id filter FAILED: a namespace with a >maxIdChars id row did not return only the short-id row (phase=${longid.phase}, matches=${JSON.stringify(longidMatches.map((m) => m.id))}). An oversized id must be filtered, not truncated.`,
        ],
      }
    }
    details.push(
      "oversized id: a chunk whose id exceeds the cap was filtered (id transfer bounded, identity not truncated)",
    )

    // ---- 9a. Credentials never leak (valid connection) --------------------
    const password = (() => {
      try {
        return new URL(databaseUrl).password
      } catch {
        return ""
      }
    })()
    if (password.length >= 4) {
      const haystack = JSON.stringify({ observations })
      if (haystack.includes(password)) {
        return {
          passed: false,
          details: [
            ...details,
            "credential leak FAILED: the connection password surfaced in a recorded observation.",
          ],
        }
      }
    }

    // ---- 9b. A bad-credential connection error is redacted ----------------
    _resetToolsForTests()
    const DISTINCTIVE_PW = "PROBE_VEC_SECRET_deadbeefcafef00d"
    const badAdapter = registerVectorTools({
      connection: { url: `postgres://probeuser:${DISTINCTIVE_PW}@127.0.0.1:1/nope` },
      query: { table: "embeddings", dimensions: 3, timeoutMs: 3000 },
    })
    try {
      const badDone = await queryVec([1, 0, 0])
      // Positive control: the unreachable connection MUST end the action 'failed'
      // (otherwise the redaction check below is over an empty/irrelevant audit).
      if (badDone.phase !== "failed") {
        return {
          passed: false,
          details: [
            ...details,
            `credential redaction setup FAILED: a query over an unreachable connection did not end 'failed' (phase=${badDone.phase}).`,
          ],
        }
      }
      // The redacted connection error lands in the FAILED action's audit (no
      // observation is emitted on failure), so inspect the audit — like the SQL probe.
      const badHaystack = JSON.stringify({
        audit: badDone.audit,
        observations: observations.filter((o) => o.source.invocation_id === badDone.id),
      })
      if (badHaystack.includes(DISTINCTIVE_PW)) {
        return {
          passed: false,
          details: [
            ...details,
            "credential redaction FAILED: a bad-connection error carried the distinctive password into an observation.",
          ],
        }
      }
      details.push(
        "credentials: the password never surfaced in observations, and a failed bad-connection action was redacted",
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
console.log("probe: vector_adapter_enforces_invariants")
console.log("─".repeat(72))
const status = result.skipped ? "SKIP ⊘" : result.passed ? "PASS ✓" : "FAIL ✗"
console.log(`status: ${status}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
