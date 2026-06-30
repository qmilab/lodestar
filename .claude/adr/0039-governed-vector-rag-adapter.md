# ADR-0039: Governed Vector/RAG retrieval adapter

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Nandan, Claude
- **Related:** #78 (Vector / RAG retrieval), #74 (native-adapter epic), ADR-0005
  (demand-pulled adapters), ADR-0013 (the SQL adapter whose Postgres connection
  this reuses), ADR-0032/#157 (the cross-belief join + the auto-observation gate),
  the `doc.read` / `DocAwareEvidenceLinker` split (the cognition-placement
  precedent), `packages/adapters/vector/`, `packages/cognitive-core/`

## Context

Retrieval-augmented generation is the dominant agent memory pattern: embed a
query, pull the nearest chunks from a vector index, feed them to the planner. But
**a vector index is a poisoning surface** — the chunks it returns are arbitrary
stored text, and an attacker who can write to the index (a shared knowledge base,
a scraped corpus, a user-contributed collection) controls what a similarity
search surfaces for a chosen query. This is exactly the threat the Memory
Firewall's Round 5 auto-observation gate exists to contain: content read from an
external document must not auto-promote to a `supported` belief. No native
adapter exercised that gate over *retrieval* yet — the existing adapters defend
egress (git/nostr/http/messaging), an injection boundary (sql), or a write
(fs.write). #78 is the inbound-retrieval governance surface, the strongest fit
for the thesis in epic #74's backlog.

Three design questions shaped the adapter:

1. **Backend.** Lodestar's stack invariant is "PostgreSQL for structured state …
   optional pgvector for memory embeddings." A remote vector DB (Pinecone/Qdrant)
   would mean a new HTTP transport; pgvector keeps the adapter inside the existing
   Postgres + `Bun.SQL` machinery the SQL adapter already hardened.
2. **Who embeds the query.** Embedding needs a provider model + key. Lodestar
   ships no model client anywhere else (the #163 generic extractor keeps the LLM
   in the consumer); the governance value here is the *retrieved chunks*, not the
   embedding.
3. **Where the cognition lives.** The teeth — "a retrieved chunk cannot
   auto-promote" — come from stamping the chunk `external_document`, which is an
   evidence-linker concern, not an adapter concern. `doc.read` already set the
   precedent: the tool lives in a light adapter (`adapter-filesystem`, core +
   action-kernel only), and the `DocumentationExtractor` + `DocAwareEvidenceLinker`
   live in `cognitive-core`, decoupled by the schema-key string.

## Decision

Ship **`@qmilab/lodestar-adapter-vector`** with one tool, **`vector.query`** (L1
read), plus a matching **`VectorRetrievalExtractor` + `VectorAwareEvidenceLinker`**
in `@qmilab/lodestar-cognitive-core`.

**Backend = pgvector over Postgres.** `vector.query` runs a parameterized
similarity `SELECT` through the SQL adapter's `SqlConnection` (reused, not
re-derived — so the connection lifecycle, password redaction, and `assertPostgresUrl`
are inherited, per the "port the whole invariant set on reuse" lesson). The adapter
depends on `@qmilab/lodestar-adapter-sql` and so publishes after it.

**Input = a pre-computed query embedding** (`number[]`). The consumer embeds the
query; Lodestar ships no embedding model. The tool also accepts an optional
`namespace` (allowlisted) and `top_k` (capped).

**The teeth:**

- **Pinned index + namespace.** The table (the index), the columns, and the
  queryable `namespaces` are **operator config**, never agent input. The agent may
  pick only from the operator's namespace allowlist; an un-allowlisted namespace is
  refused, and a namespace supplied to an un-namespaced index is refused.
- **Parameterized values.** The query embedding (`$1::vector`), the namespace
  (`$2`), and the `LIMIT` (`$N`) are always **bound**, never concatenated. Only
  operator-config identifiers (table/columns) are interpolated, each validated
  against a strict identifier grammar and double-quoted at tool-build time.
- **Top-k cap, bounded server-side.** `LIMIT topK + 1` bounds the fetch in the
  database (one row past the cap, to set `truncated`), so a huge index cannot
  inflate an observation or balloon host memory — the natural analogue of the SQL
  adapter's #101 cursor, reached more simply because the query already carries a
  `LIMIT`.
- **Read-only.** Runs inside a `READ ONLY` transaction with a `statement_timeout`.
- **Credential scoping.** The connection password is operator config, never in the
  agent's inputs, and redacted from any captured error.

**The cognition (the headline).** The `VectorRetrievalExtractor` mints an
**envelope** claim (the record of the query — `tool_result` quality, allowed to
promote) and **one content claim per retrieved chunk**, each with a chunk-specific
subject (`vector_chunk:<table>:<ns>:<id>`, components encoded) so a chunk never
cross-joins (ADR-0032's
`crossBeliefItems`) onto an unrelated belief and inherits a promote-grade quality.
The `VectorAwareEvidenceLinker` (the consumer of `guard.wrap()`'s
`evidenceLinkerFactory` seam, exactly like `DocAwareEvidenceLinker`) stamps each
chunk `external_document` with per-chunk provenance (`independence_group:
vector:<table>:<ns>:<id>`, `notes` naming the index/namespace + distance). That downgrade
trips the auto-observation gate, so **a retrieved chunk can never auto-promote a
belief to `supported`** — even at promote-grade aggregate strength and even when
multiple chunks corroborate (two `external_document` chunks stay `external_document`;
Parallax holds). Non-vector claims fall through to the base linker unchanged.

## Consequences

- A Lodestar-wrapped RAG agent records retrieved chunks faithfully and keeps them
  out of its trusted (`supported`) belief set — a poisoned chunk surfaced by a
  crafted query stays `unverified`, visible to a reviewer with its source, but
  unable to drive a decision through the auto-observation path. The read/content
  split is preserved: the *record that a query ran* (`tool_result`) may promote;
  the *chunk text* (`external_document`) may not.
- The adapter stays dependency-light in the adapter sense (core + action-kernel +
  zod) plus the one `adapter-sql` reuse edge; the cognitive code lives beside
  `Doc`/`Generic`-aware linkers in `cognitive-core`, keyed on the
  `vector.retrieval_result@1` string (no adapter→cognitive-core dependency).
- Two probes: **`vector-retrieval-cannot-auto-promote`** (in-memory, always runs)
  drives the real extractor + linker through `guard.wrap()` with-and-without the
  seam and pins the no-auto-promote contrast; **`vector-adapter-enforces-invariants`**
  (DB-gated like the SQL probe — `LODESTAR_TEST_DATABASE_URL`, skip-loud) drives the
  real `vector.query` through the kernel against real pgvector and pins index/
  namespace pinning, the top-k cap, parameterized-namespace-as-literal, the
  dimension guard, and credential redaction.
- **CI change (unlike ADR-0013):** the DB-gated probe needs the `vector` extension,
  which stock `postgres:16` lacks, so the CI Postgres service moves to
  `pgvector/pgvector:pg16` (postgres:16 + pgvector — the SQL adapter and
  cross-session store tests are unaffected).
- Still a **TS-level governance boundary, not database containment** (ADR-0004):
  the query reaches the real index; DB-side privileges are the operator's defence
  in depth. No `packages/core` schema change, no new event.

## Alternatives considered

- **A remote vector-DB HTTP seam (Pinecone/Qdrant/Weaviate) first.** Rejected for
  v0: it means a new HTTP transport with its own SSRF/credential surface for a
  backend the stack does not already run, where pgvector reuses the hardened SQL
  connection. A remote backend can land later behind the same `vector.query` tool.
- **Embed the query inside the adapter (text input + a model seam).** Rejected:
  Lodestar ships no model client by policy; embedding is non-deterministic and
  provider-specific, and it is not the governance surface. A pre-computed vector
  keeps the adapter deterministic and probe-testable, with a `text + EmbeddingModel`
  seam available as a future extension.
- **Put the extractor + linker in the adapter package.** Rejected: it would force
  `cognitive-core` + `memory-firewall` deps into an adapter, breaking the
  light-adapter norm. The `doc.read` split (tool in the adapter, cognition in
  cognitive-core) is the established precedent.
- **Metadata-filter the query (a `WHERE metadata @> …` from agent input).**
  Deferred: an agent-supplied structured filter is a second injection surface
  (operators compose it from a fixed allowlist if needed). v0 pins by namespace
  only; metadata columns are surfaced read-only as per-chunk provenance.
