import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { SqlConnection, type SqlConnectionConfig } from "@qmilab/lodestar-adapter-sql"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * Native Vector/RAG retrieval tool — `vector.query` (L1 read). P2 follow-on
 * adapter (ADR-0005 / ADR-0039), the first native adapter whose governance
 * surface is **inbound retrieval** rather than egress or an injection boundary.
 *
 * The headline is the **retrieval-poisoning surface**: the chunks a similarity
 * search returns are arbitrary stored text an attacker may have written into the
 * index. So `vector.query` surfaces them as UNTRUSTED `external_document`
 * content — the kernel records them faithfully, and the paired
 * `VectorAwareEvidenceLinker` (in `@qmilab/lodestar-cognitive-core`) stamps each
 * chunk `external_document`, so the firewall's auto-observation (Parallax) gate
 * keeps a retrieved chunk from ever auto-promoting a belief to
 * `truth_status: supported`.
 *
 * The teeth (mirroring the SQL adapter, ADR-0013, whose Postgres connection this
 * reuses):
 *
 *   - **Pinned index + namespace.** The table (the index) and the queryable
 *     namespaces are OPERATOR config — never agent input. The agent supplies a
 *     query embedding and may pick only from the operator's namespace allowlist;
 *     an un-allowlisted namespace is refused.
 *   - **Parameterized values.** The query embedding, the namespace, and the
 *     `LIMIT` are always BOUND (`$1::vector`, `$2`, `$3`), never concatenated.
 *     Only operator-config identifiers (table/columns) are interpolated, each
 *     validated against a strict identifier grammar and double-quoted.
 *   - **Top-k cap.** `LIMIT` bounds the fetch SERVER-SIDE (the database returns
 *     at most `topK + 1` rows — one past the cap, to flag `truncated`), so a
 *     huge index cannot inflate an observation or balloon host memory.
 *   - **Read-only.** Runs inside a `READ ONLY` transaction with a
 *     `statement_timeout` — a retrieval can never mutate the index.
 *   - **Credential scoping.** The connection password is operator config, never
 *     in the agent's inputs, and redacted from any captured error (reused from
 *     `@qmilab/lodestar-adapter-sql`).
 *
 * A **TS-level governance boundary, not database containment**: the query reaches
 * the real pgvector index by design; DB-side privileges are the operator's
 * defence in depth. Targets Postgres + the `pgvector` extension via Bun's native
 * `Bun.SQL`.
 */

const DEFAULT_MAX_TOP_K = 20
const DEFAULT_TOP_K = 5
const DEFAULT_TIMEOUT_MS = 15_000
/** Per-chunk content cap (characters). Retrieved chunk text is untrusted, so it
 * is bounded server-side; the operator raises it for genuinely larger chunks. */
const DEFAULT_MAX_CHUNK_CHARS = 4000

/** Postgres `statement_timeout` is an integer-millisecond GUC capped at INT_MAX. */
const PG_MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647

// -----------------------------------------------------------------------------
// Distance metric → pgvector operator
// -----------------------------------------------------------------------------

/** The three pgvector distance operators. The agent never picks the metric — it
 * is operator config, so the index and the query agree on a distance. */
export type VectorMetric = "cosine" | "l2" | "ip"

const METRIC_OPERATOR: Record<VectorMetric, string> = {
  cosine: "<=>",
  l2: "<->",
  ip: "<#>",
}

// -----------------------------------------------------------------------------
// Identifier safety (operator config — validated + quoted, never agent input)
// -----------------------------------------------------------------------------

const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * Validate and double-quote a (possibly schema-qualified) SQL identifier.
 * Table/column names cannot be bound as parameters, so they are interpolated —
 * but only from OPERATOR config, and only after passing a strict grammar
 * (letters/digits/underscore/`$`, optionally one `schema.name` dot). Each part
 * is double-quoted so a reserved word or mixed case is safe; the grammar forbids
 * an embedded quote, so quoting cannot be escaped. A bad identifier throws at
 * tool-build time (misconfiguration), never at query time.
 */
function quoteIdentifier(raw: string, what: string): string {
  const parts = raw.split(".")
  if (parts.length > 2) {
    throw new Error(`vector: ${what} '${raw}' has too many qualifiers (max schema.name)`)
  }
  for (const part of parts) {
    if (!IDENTIFIER_PART.test(part)) {
      throw new Error(
        `vector: ${what} '${raw}' is not a valid SQL identifier (letters, digits, _ , $; optional one schema. qualifier)`,
      )
    }
  }
  return parts.map((p) => `"${p}"`).join(".")
}

/** A positive integer top-k, clamped to the operator's ceiling. */
function clampTopK(requested: number | undefined, def: number, max: number): number {
  const base = requested === undefined ? def : requested
  const n = Number.isFinite(base) ? Math.floor(base) : def
  return Math.min(Math.max(1, n), Math.max(1, Math.floor(max)))
}

function timeoutLiteral(timeoutMs: number): number | null {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null
  return Math.min(Math.floor(timeoutMs), PG_MAX_STATEMENT_TIMEOUT_MS)
}

/** A positive integer or the fallback — for a content cap interpolated into
 * `left(col, N)`, which must never render as a float or a non-positive count. */
function positiveIntOr(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Render a query embedding as a pgvector text literal (`[1,2,3]`). The value is
 * BOUND as a parameter and cast `$1::vector`, so it is never interpreted as SQL;
 * each element is already validated finite by the input schema. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// -----------------------------------------------------------------------------
// Output schema
// -----------------------------------------------------------------------------

export const VectorMatchSchema = z
  .object({
    id: z.string().describe("the chunk's stable id from the index"),
    content: z.string().describe("the retrieved chunk text — UNTRUSTED external_document content"),
    distance: z.number().describe("the pgvector distance to the query (smaller = nearer)"),
    content_truncated: z
      .boolean()
      .describe("true if the chunk text exceeded the per-chunk character cap and was trimmed"),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("operator-selected metadata columns for the chunk, if any"),
  })
  .describe("one retrieved chunk — its text is UNTRUSTED and must not self-promote to a belief")

export const VectorRetrievalOutputSchema = z
  .object({
    table: z.string().describe("the operator-pinned index (table) queried"),
    namespace: z.string().describe("the namespace queried, or '(none)' for an un-namespaced index"),
    metric: z.string().describe("the distance metric used (cosine/l2/ip)"),
    match_count: z.number().int().describe("number of chunks returned (after the top-k cap)"),
    truncated: z
      .boolean()
      .describe("true if more chunks matched than the top-k cap and were trimmed"),
    matches: z
      .array(VectorMatchSchema)
      .describe("the retrieved chunks — UNTRUSTED external content (external_document)"),
    summary: z.string(),
  })
  // The shape is mirrored by VECTOR_RETRIEVAL_SCHEMA_KEY's parse schema in
  // @qmilab/lodestar-cognitive-core (decoupled by the shared key string, exactly
  // as documentation.source@1 is).
  .describe("vector.query output: chunks retrieved from a pinned vector index (untrusted inbound)")

export type VectorRetrievalOutput = z.infer<typeof VectorRetrievalOutputSchema>

if (!registry.has("vector.retrieval_result@1")) {
  registry.register("vector.retrieval_result@1", VectorRetrievalOutputSchema)
}

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const VectorQueryInput = z.object({
  embedding: z
    .array(z.number().finite())
    .min(1)
    .describe(
      "the query embedding vector; the consumer embeds the query (Lodestar ships no model)",
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "which operator-allowlisted namespace to search; omit when the index has a single namespace",
    ),
  top_k: z.number().int().positive().optional().describe("how many chunks to retrieve (capped)"),
})

// -----------------------------------------------------------------------------
// vector.query — retrieval, L1 (untrusted inbound)
// -----------------------------------------------------------------------------

export interface VectorQueryToolOptions {
  /** The operator connection (a Postgres + pgvector database). */
  connection: SqlConnection
  /** The pinned index — the table holding the embeddings. Operator config. */
  table: string
  /** Column holding the `vector` embedding. Default `embedding`. */
  embeddingColumn?: string
  /** Column holding each chunk's stable id. Default `id`. */
  idColumn?: string
  /** Column holding each chunk's text. Default `content`. */
  contentColumn?: string
  /** Column the namespace filter compares against. Omit for an un-namespaced
   * index (then a query that supplies a `namespace` is refused). */
  namespaceColumn?: string
  /** The queryable namespaces — the operator's allowlist (the "pinned
   * namespace"). Required when `namespaceColumn` is set; a single entry is also
   * the default when a query omits `namespace`. */
  namespaces?: string[]
  /** Extra columns to surface as per-chunk `metadata`. Operator config. */
  metadataColumns?: string[]
  /** Distance metric. Default `cosine`. */
  metric?: VectorMetric
  /** The required embedding dimensionality; a query of the wrong length is
   * refused. Optional but recommended. */
  dimensions?: number
  /** Cap on chunks returned. Default 20. */
  maxTopK?: number
  /** Default chunks when a query omits `top_k`. Default 5. */
  defaultTopK?: number
  /** Per-chunk content cap in characters — retrieved chunk text is untrusted, so
   * it is bounded (in SQL) before it is captured. Default 4000. */
  maxChunkChars?: number
  /** Per-query timeout (ms). Default 15s. */
  timeoutMs?: number
  /** Trust floor. Default L1 — a read whose chunks are untrusted external content. */
  trust?: TrustLevel
}

const RETRIEVAL_EFFECTS: Effect[] = [
  {
    kind: "external_call",
    description: "run a read-only similarity search against a vector index",
  },
]

export function makeVectorQueryTool(
  opts: VectorQueryToolOptions,
): Tool<z.infer<typeof VectorQueryInput>, VectorRetrievalOutput> {
  const conn = opts.connection
  const metric = opts.metric ?? "cosine"
  const op = METRIC_OPERATOR[metric]
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTopK = opts.maxTopK ?? DEFAULT_MAX_TOP_K
  const defaultTopK = opts.defaultTopK ?? DEFAULT_TOP_K
  const maxChunkChars = positiveIntOr(
    opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
    DEFAULT_MAX_CHUNK_CHARS,
  )

  // Validate + quote every operator identifier ONCE at build time, so a
  // misconfiguration fails loudly here rather than at query time.
  const table = quoteIdentifier(opts.table, "table")
  const idCol = quoteIdentifier(opts.idColumn ?? "id", "idColumn")
  const contentCol = quoteIdentifier(opts.contentColumn ?? "content", "contentColumn")
  const embeddingCol = quoteIdentifier(opts.embeddingColumn ?? "embedding", "embeddingColumn")
  const nsColRaw = opts.namespaceColumn
  const nsCol = nsColRaw !== undefined ? quoteIdentifier(nsColRaw, "namespaceColumn") : undefined
  const metadataCols = (opts.metadataColumns ?? []).map((c) => ({
    raw: c,
    quoted: quoteIdentifier(c, "metadataColumn"),
  }))
  const namespaces = opts.namespaces ?? []
  // namespaceColumn and namespaces are a paired requirement: configure both
  // (a filtered, allowlisted index) or neither (an un-namespaced index). A
  // half-configured guard is a footgun in either direction —
  if (nsCol !== undefined && namespaces.length === 0) {
    throw new Error(
      "vector: a namespaceColumn is configured but `namespaces` (the queryable allowlist) is empty",
    )
  }
  // — and an allowlist with no column to filter on would be SILENTLY IGNORED: a
  // query that omitted `namespace` would run with no WHERE clause and search the
  // whole index, defeating the allowlist the operator supplied. Fail closed.
  if (nsCol === undefined && namespaces.length > 0) {
    throw new Error(
      "vector: `namespaces` (an allowlist) is configured but no `namespaceColumn` — retrieval would search the whole index unfiltered; set a namespaceColumn or drop the allowlist",
    )
  }

  return {
    name: "vector.query",
    inputs: VectorQueryInput,
    output_schema_key: "vector.retrieval_result@1",
    effects: RETRIEVAL_EFFECTS,
    reversibility: "reversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 1,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      // Dimension guard: a query of the wrong length cannot match anything and
      // would error mid-query; reject it with a clear message.
      if (opts.dimensions !== undefined && inputs.embedding.length !== opts.dimensions) {
        throw new Error(
          `vector.query: embedding has ${inputs.embedding.length} dimensions, index expects ${opts.dimensions}`,
        )
      }

      // Namespace pinning: resolve the effective namespace against the operator
      // allowlist, BEFORE any query runs.
      let namespace: string | undefined
      if (nsCol !== undefined) {
        const requested = inputs.namespace ?? (namespaces.length === 1 ? namespaces[0] : undefined)
        if (requested === undefined) {
          throw new Error(
            `vector.query: this index is namespaced; supply one of [${namespaces.join(", ")}]`,
          )
        }
        if (!namespaces.includes(requested)) {
          throw new Error(`vector.query: namespace '${requested}' is not allowlisted`)
        }
        namespace = requested
      } else if (inputs.namespace !== undefined) {
        throw new Error("vector.query: this index is not namespaced; do not supply a namespace")
      }

      const topK = clampTopK(inputs.top_k, defaultTopK, maxTopK)
      const timeout = timeoutLiteral(timeoutMs)
      const vectorLiteral = toVectorLiteral(inputs.embedding)

      // Build the parameterized similarity query. Identifiers are operator
      // config (validated + quoted above); every VALUE is bound: the embedding
      // ($1::vector), the namespace ($2 when present), and the LIMIT ($N) — which
      // bounds the fetch SERVER-SIDE to topK + 1 rows (one past the cap, to set
      // `truncated`). Distinct param indexes so adding the namespace filter does
      // not renumber the others.
      const params: unknown[] = [vectorLiteral]
      // Cap each metadata column the SAME way as content: cast to text and
      // `left(..., maxChunkChars + 1)` in SQL, so a large/user-writable column
      // (a JSONB `metadata` blob, or a misconfigured `content`/embedding column)
      // can't balloon the transfer/observation through the metadata channel.
      // Alias to a fixed `meta_<i>` so a metadata column named `id`/`content`/
      // `distance` (or schema-qualified) can't collide with the other outputs.
      const metaSelect = metadataCols
        .map((c, i) => `, left(${c.quoted}::text, ${maxChunkChars + 1}) as meta_${i}`)
        .join("")
      // Always filter NULL embeddings: an unembedded row has a NULL distance,
      // which would become NaN and fail the kernel's `z.number()` output
      // validation (and is not a real match). Combine with the optional namespace
      // filter. Both conditions reference operator-config identifiers only.
      const conditions: string[] = [`${embeddingCol} is not null`]
      if (namespace !== undefined && nsCol !== undefined) {
        params.push(namespace)
        conditions.push(`${nsCol} = $${params.length}`)
      }
      const whereClause = ` where ${conditions.join(" and ")}`
      params.push(topK + 1)
      const limitParam = `$${params.length}`
      // Cap each chunk's content in SQL with `left(...)` (maxChunkChars is a
      // trusted, clamped operator integer — never agent input) so the host never
      // *transfers* an unbounded untrusted string: bounded capture is per CHUNK,
      // not just per row, the same posture as the HTTP adapter's body cap. Fetch
      // one char past the cap to detect per-chunk truncation.
      const cappedContent = `left(${contentCol}, ${maxChunkChars + 1})`
      const statement =
        `select ${idCol} as id, ${cappedContent} as content, ` +
        `${embeddingCol} ${op} $1::vector as distance${metaSelect} ` +
        `from ${table}${whereClause} ` +
        `order by ${embeddingCol} ${op} $1::vector ` +
        `limit ${limitParam}`

      try {
        const sql = await conn.handle()
        const fetched = await sql.begin("read only", async (tx) => {
          if (timeout !== null) await tx.unsafe(`set local statement_timeout = ${timeout}`)
          return await tx.unsafe(statement, params)
        })
        const fetchedRows = Array.isArray(fetched)
          ? (fetched as Array<Record<string, unknown>>)
          : []
        // Defensive: drop any row whose distance isn't a finite number. The
        // `IS NOT NULL` filter makes this practically unreachable, but it
        // guarantees the output never carries a NaN that fails validation.
        const allRows = fetchedRows.filter((r) => Number.isFinite(r.distance as number))
        const truncated = allRows.length > topK
        const rows = truncated ? allRows.slice(0, topK) : allRows
        const matches = rows.map((r, i) => {
          const rawContent = typeof r.content === "string" ? r.content : String(r.content ?? "")
          const contentTruncated = rawContent.length > maxChunkChars
          const match: VectorRetrievalOutput["matches"][number] = {
            id: r.id === null || r.id === undefined ? `#${i}` : String(r.id),
            content: contentTruncated ? rawContent.slice(0, maxChunkChars) : rawContent,
            content_truncated: contentTruncated,
            distance: r.distance as number,
          }
          if (metadataCols.length > 0) {
            const metadata: Record<string, unknown> = {}
            metadataCols.forEach((c, j) => {
              const v = r[`meta_${j}`]
              // The DB caps to maxChunkChars+1; trim the overflow char. Values
              // are the column's text form (bounded) — a number/JSONB column
              // surfaces as its bounded text, by design.
              metadata[c.raw] =
                typeof v === "string" && v.length > maxChunkChars ? v.slice(0, maxChunkChars) : v
            })
            match.metadata = metadata
          }
          return match
        })
        return {
          table: opts.table,
          namespace: namespace ?? "(none)",
          metric,
          match_count: matches.length,
          truncated,
          matches,
          summary: `vector.query: ${matches.length}${truncated ? `+ (capped at ${topK})` : ""} chunk(s) from ${opts.table}${namespace !== undefined ? `/${namespace}` : ""} by ${metric} distance`,
        }
      } catch (err) {
        throw new Error(conn.redact(`vector.query failed: ${errMessage(err)}`))
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors createSqlTools, with the same connection
// lifecycle — a database handle is a real, pooled resource).
// -----------------------------------------------------------------------------

export interface VectorToolsConfig {
  /** The operator connection — a connection string (adapter-owned pool) or a
   * pre-opened `Bun.SQL` handle (operator-owned). */
  connection: SqlConnectionConfig
  /** `vector.query` options (everything except the resolved `connection`). */
  query: Omit<VectorQueryToolOptions, "connection">
}

export interface VectorAdapter {
  /** The configured tools, ready to register with the Action Kernel. */
  tools: Tool[]
  /** The connection (exposed for explicit lifecycle control). */
  connection: SqlConnection
  /** Close the connection if the adapter owns it (a no-op for an operator handle). */
  close(): Promise<void>
}

/** Build the configured Vector tools over one operator connection. Does NOT
 * register them — call `registerVectorTools`, or register `adapter.tools`. */
export function createVectorTools(config: VectorToolsConfig): VectorAdapter {
  const connection = new SqlConnection(config.connection)
  const tools: Tool[] = [makeVectorQueryTool({ connection, ...config.query }) as Tool]
  return { tools, connection, close: () => connection.close() }
}

/** Build AND register the configured Vector tools. Returns the adapter (for `close()`). */
export function registerVectorTools(config: VectorToolsConfig): VectorAdapter {
  const adapter = createVectorTools(config)
  for (const tool of adapter.tools) registerTool(tool)
  return adapter
}
