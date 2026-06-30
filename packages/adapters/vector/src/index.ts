/**
 * @qmilab/lodestar-adapter-vector — governed Vector/RAG retrieval for the
 * Lodestar Action Kernel. P2 follow-on adapter (ADR-0039).
 *
 * - `vector.query` (L1) — a pgvector similarity search over a pinned index;
 *   the retrieved chunks are UNTRUSTED `external_document` content.
 *
 * The headline is the **retrieval-poisoning surface**: a similarity search
 * returns arbitrary stored text an attacker may have written into the index, so
 * the chunks are surfaced as `external_document` and the paired
 * `VectorAwareEvidenceLinker` (in `@qmilab/lodestar-cognitive-core`) keeps them
 * from auto-promoting a belief. Governance also covers index/namespace pinning
 * (operator config, never agent input), a top-k cap bounded SERVER-SIDE by
 * `LIMIT`, parameterized values (the embedding/namespace/limit are bound; only
 * validated operator identifiers are interpolated), a `READ ONLY` transaction,
 * and operator-scoped credentials redacted from errors (reused from
 * `@qmilab/lodestar-adapter-sql`). A TS-level governance boundary, not database
 * containment; targets Postgres + pgvector via Bun's native `Bun.SQL`.
 */
export {
  makeVectorQueryTool,
  createVectorTools,
  registerVectorTools,
  VectorRetrievalOutputSchema,
  VectorMatchSchema,
  type VectorRetrievalOutput,
  type VectorMetric,
  type VectorQueryToolOptions,
  type VectorToolsConfig,
  type VectorAdapter,
} from "./tools.js"
// The Postgres connection + credential redaction are reused from the SQL
// adapter (same Bun.SQL machinery); re-export for a consumer wiring a vector
// index without also importing the SQL adapter.
export {
  SqlConnection,
  assertPostgresUrl,
  type SqlConnectionConfig,
  type SecretValue,
} from "@qmilab/lodestar-adapter-sql"
