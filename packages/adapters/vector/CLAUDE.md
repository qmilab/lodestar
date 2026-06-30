# @qmilab/lodestar-adapter-vector — CLAUDE.md

Governed Vector/RAG retrieval for the Action Kernel — a P2 follow-on adapter
(ADR-0039), pulled from epic #74's governance-rich backlog. The first native
adapter whose headline governance surface is **inbound retrieval**: the chunks a
similarity search returns are arbitrary stored text an attacker may have written
into the index — the RAG poisoning surface.

- **`vector.query`** — L1 read. Embed a query in the consumer, pass the embedding
  here, and retrieve the nearest chunks from a pinned pgvector index. The chunks
  are UNTRUSTED `external_document` content. Runs inside a `READ ONLY` transaction.

Targets Postgres + the `pgvector` extension via Bun's native `Bun.SQL`, and reuses
`@qmilab/lodestar-adapter-sql`'s `SqlConnection` for the connection lifecycle +
password redaction (so a database credential is scoped and redacted exactly as the
SQL adapter scopes it — not re-derived).

## What lives here

- `src/tools.ts` — the `vector.retrieval_result@1` output schema, the `vector.query`
  `Tool`, the `makeVectorQueryTool` builder, and the `createVectorTools` /
  `registerVectorTools` config factory (which returns an adapter with a `close()`,
  because a database connection is a real, pooled resource — like the SQL adapter).
  Operator identifiers (table/columns) are validated against a strict grammar and
  double-quoted at build time; every agent-supplied value is bound.
- `src/index.ts` — re-exports the tool surface, plus `SqlConnection` from the SQL
  adapter for a consumer wiring an index without importing the SQL adapter directly.

The **cognition** that gives this adapter its teeth does NOT live here — it lives in
`@qmilab/lodestar-cognitive-core` (`src/vector-retrieval.ts`): the
`VectorRetrievalExtractor` + `VectorAwareEvidenceLinker`, keyed on the
`vector.retrieval_result@1` schema string. This is the same split `doc.read`
(adapter-filesystem) / `DocAwareEvidenceLinker` (cognitive-core) uses, so the
adapter stays dependency-light and the quality-downgrade logic lives beside the rest
of the cognitive core. A host wires the linker via `guard.wrap()`'s
`cognitive.evidenceLinkerFactory` seam.

The headline invariants are locked by two harness probes:
`vector-retrieval-cannot-auto-promote` (in-memory, the no-auto-promote contrast) and
`vector-adapter-enforces-invariants` (DB-gated against real pgvector — reads
`LODESTAR_TEST_DATABASE_URL`, skips loudly when unset, runs against the
`pgvector/pgvector:pg16` service in CI).

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not database containment** (same framing as
ADR-0004/0013). It enforces, in-process:

1. **Retrieved chunks are `external_document` (the headline).** A chunk surfaced by
   a similarity search is recorded faithfully but stamped `external_document` by the
   paired `VectorAwareEvidenceLinker`, so the firewall's Round 5 auto-observation
   (Parallax) gate keeps it from ever auto-promoting a belief to
   `truth_status: supported` — no matter how strong its aggregate evidence or how
   many chunks corroborate (two `external_document` chunks stay `external_document`).
   The *record that a query ran* (the `tool_result` envelope) may promote; the
   *chunk text* may not.
2. **Pinned index + namespace.** The table (the index), the columns, and the
   queryable namespaces are operator config — never agent input. The agent supplies
   only a query embedding and may pick only from the operator's namespace allowlist;
   an un-allowlisted namespace, or a namespace on an un-namespaced index, is refused.
3. **Parameterized values.** The query embedding, the namespace, and the `LIMIT` are
   always bound (`$1::vector` / `$2` / `$N`), never concatenated. Identifiers cannot
   be bound, so they come ONLY from operator config and are validated + double-quoted.
4. **Top-k cap, bounded server-side.** `LIMIT topK + 1` bounds the fetch in the
   database (one past the cap, to set `truncated`), so a huge index cannot inflate an
   observation or balloon host memory.
5. **Read-only + scoped credentials.** A `READ ONLY` transaction (a retrieval cannot
   mutate the index) with a `statement_timeout`; the connection password is operator
   config, never in the agent's inputs, and redacted from any caught error.

**What it does NOT claim:** no OS/network sandbox of the database, no table/column/
row authorization (that is the DB role's job), and Postgres + pgvector only in v0.
The adapter does not embed the query — the consumer does, and passes a pre-computed
vector (Lodestar ships no embedding model, the same posture as the generic LLM
extractor). Agent-supplied metadata filters are deliberately out of scope for v0 (a
second injection surface); metadata columns are surfaced read-only as per-chunk
provenance.

## Trust contracts

| Tool | Trust | reversibility | effects | sandbox | permissions |
|------|-------|---------------|---------|---------|-------------|
| `vector.query` | **L1** | `reversible` | `external_call` | `controlled-network` | `network.egress` |

`blast_radius` is set by the proposer's `ActionContract`, not the `Tool`. The tool
spawns no subprocess, so the honest sandbox is `controlled-network` (ADR-0007). Do
not lower the L1 floor or widen the namespace allowlist to make a demo pass.

## When you extend this

- Keep the chunk cognition in `cognitive-core` and keep retrieved chunks
  `external_document`. The whole point is that retrieval cannot launder trust.
- Keep it **operator-pinned + parameterized.** Never let the agent name the table,
  a column, or a namespace outside the allowlist, and never concatenate an
  agent-supplied value into SQL.
- Keep the fetch **bounded by `LIMIT`** server-side, not by a post-fetch slice.
- Keep credentials operator-supplied and redacted; the agent must never see, name,
  or supply a connection string.
- The two probes are spec. If a change makes them pass without exercising the
  no-auto-promote gate, index/namespace pinning, the top-k cap, parameterized
  binding, or credential redaction, that's a probe bug, not an improvement.
