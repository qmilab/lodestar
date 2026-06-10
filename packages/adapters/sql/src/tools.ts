import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import { SqlConnection, type SqlConnectionConfig } from "./connection.js"
import { assertReadOnly, assertSingleStatement } from "./statement.js"

/**
 * Native SQL/database tools — `sql.query` (L1 read) and `sql.execute` (L3
 * mutation). P2 follow-on adapter (ADR-0005 / ADR-0013).
 *
 * The headline is the **injection boundary**: the agent never builds SQL by
 * concatenating values. Every value is supplied separately in `params` and bound
 * by the driver (`sql.unsafe(statement, params)` → Postgres's extended/prepared
 * protocol), so a hostile value like `Robert'); DROP TABLE students;--` is stored
 * as a literal string, never interpreted as SQL.
 *
 * The teeth (mirroring the egress slices, ADR-0006/0007/0008/0009):
 *
 *   - **Parameterized-only.** No string-SQL path is exposed; values bind as
 *     `$1..$N`. Passing the params array forces the extended protocol, which also
 *     forbids multiple statements; a lexical single-statement guard rejects obvious
 *     stacking early.
 *   - **Read / mutation split.** `sql.query` is L1 and runs inside a `READ ONLY`
 *     transaction, so even a data-modifying CTE is refused by the database — its
 *     rows are UNTRUSTED inbound content. A mutation must go through `sql.execute`,
 *     which sits at the L3 floor (operator-raisable to L4) and so parks at
 *     `pending_approval` until a human approves under a holding policy.
 *   - **Credential scoping.** The connection password is operator config, never in
 *     the agent's inputs, and redacted from any captured error. (`connection.ts`.)
 *   - **Bounded capture.** A row cap on what enters the observation and a
 *     per-statement `statement_timeout`, so a huge or slow result cannot inflate or
 *     hang an observation.
 *
 * A **TS-level governance boundary, not database containment**: the query reaches
 * the real database by design, and DB-side privileges (a least-privileged role) are
 * the operator's defence in depth, not this adapter's claim. Targets Postgres
 * (Bun's native `Bun.SQL`).
 */

const DEFAULT_MAX_ROWS = 1000
const DEFAULT_TIMEOUT_MS = 15_000

// -----------------------------------------------------------------------------
// Output schemas
// -----------------------------------------------------------------------------

export const SqlQueryOutputSchema = z
  .object({
    rows: z.array(z.unknown()).describe("the result rows — UNTRUSTED external content"),
    row_count: z.number().int().describe("number of rows returned (after the cap)"),
    truncated: z.boolean().describe("true if the result exceeded the row cap and was trimmed"),
    columns: z.array(z.string()).describe("column names, derived from the first row"),
    command: z.string().describe("the SQL command tag the driver reported (e.g. SELECT)"),
    summary: z.string(),
  })
  .describe("sql.query output: rows read from the database (untrusted inbound)")

export type SqlQueryOutput = z.infer<typeof SqlQueryOutputSchema>

export const SqlExecuteOutputSchema = z
  .object({
    rows_affected: z.number().int().describe("rows the mutation reported affected"),
    command: z
      .string()
      .describe("the SQL command tag the driver reported (INSERT/UPDATE/DELETE/…)"),
    returned_rows: z
      .array(z.unknown())
      .describe(
        "rows from a RETURNING clause, if any — UNTRUSTED external content (after the cap)",
      ),
    returned_truncated: z.boolean().describe("true if the RETURNING rows exceeded the cap"),
    summary: z.string(),
  })
  .describe("sql.execute output: the result of a governed mutation")

export type SqlExecuteOutput = z.infer<typeof SqlExecuteOutputSchema>

if (!registry.has("sql.query@1")) registry.register("sql.query@1", SqlQueryOutputSchema)
if (!registry.has("sql.execute@1")) registry.register("sql.execute@1", SqlExecuteOutputSchema)

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Column names from the first object row; `[]` for empty or non-object rows. */
function deriveColumns(rows: unknown[]): string[] {
  const first = rows[0]
  return first !== null && typeof first === "object" ? Object.keys(first as object) : []
}

/** A validated, positive statement timeout in whole milliseconds, or `null` to
 * leave the server default in place. Interpolated into `SET LOCAL` (which takes no
 * bound parameters), so it MUST be a trusted integer — never caller input. */
function timeoutLiteral(timeoutMs: number): number | null {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null
}

const SqlStatementInput = z.object({
  statement: z
    .string()
    .min(1)
    .describe(
      "exactly one SQL statement; use $1,$2,… placeholders for every value and pass the values via params — never string-concatenate untrusted values into the statement",
    ),
  params: z
    .array(z.unknown())
    .optional()
    .describe("bound values for the statement's $1..$N placeholders"),
})

// -----------------------------------------------------------------------------
// sql.query — read, L1 (untrusted inbound)
// -----------------------------------------------------------------------------

export interface SqlQueryToolOptions {
  /** The operator connection. */
  connection: SqlConnection
  /** Cap on rows that enter the observation. Default 1000. */
  maxRows?: number
  /** Per-statement timeout (ms). Default 15s. */
  timeoutMs?: number
  /** Trust floor. Default L1 — a read whose rows are untrusted external content. */
  trust?: TrustLevel
}

export function makeSqlQueryTool(
  opts: SqlQueryToolOptions,
): Tool<z.infer<typeof SqlStatementInput>, SqlQueryOutput> {
  const conn = opts.connection
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: "sql.query",
    inputs: SqlStatementInput,
    output_schema_key: "sql.query@1",
    effects: [{ kind: "external_call", description: "run a read-only query against the database" }],
    reversibility: "reversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 1,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      // Lexical fast-fail: one statement, and an obvious write is rejected before
      // it reaches the driver. The structural guarantees are below.
      assertSingleStatement(inputs.statement, "sql.query")
      assertReadOnly(inputs.statement, "sql.query")
      const params = inputs.params ?? []
      const timeout = timeoutLiteral(timeoutMs)
      try {
        const sql = await conn.handle()
        // READ ONLY transaction: a data-modifying CTE is refused by the database
        // itself, so the read tool cannot mutate even via a clever statement.
        // Capture command + rows INSIDE the transaction and return a plain object.
        const out = await sql.begin("read only", async (tx) => {
          if (timeout !== null) await tx.unsafe(`set local statement_timeout = ${timeout}`)
          const r = await tx.unsafe(inputs.statement, params)
          const meta = r as unknown as { command?: string }
          return {
            rows: Array.isArray(r) ? [...(r as unknown[])] : [],
            command: typeof meta.command === "string" ? meta.command : "SELECT",
          }
        })
        const truncated = out.rows.length > maxRows
        const rows = truncated ? out.rows.slice(0, maxRows) : out.rows
        return {
          rows,
          row_count: rows.length,
          truncated,
          columns: deriveColumns(rows),
          command: out.command,
          summary: `sql.query: ${out.command} returned ${rows.length}${truncated ? `+ row(s) (capped at ${maxRows})` : " row(s)"}`,
        }
      } catch (err) {
        throw new Error(conn.redact(`sql.query failed: ${errMessage(err)}`))
      }
    },
  }
}

// -----------------------------------------------------------------------------
// sql.execute — mutation, L3 (operator-raisable to L4)
// -----------------------------------------------------------------------------

export interface SqlExecuteToolOptions {
  /** The operator connection. */
  connection: SqlConnection
  /** Cap on RETURNING rows that enter the observation. Default 1000. */
  maxReturnedRows?: number
  /** Per-statement timeout (ms). Default 15s. */
  timeoutMs?: number
  /** Trust floor. Default L3 — a state-changing mutation; raise to L4 for a
   * production database so every write is held for human approval. */
  trust?: TrustLevel
}

const MUTATION_EFFECTS: Effect[] = [
  { kind: "world_state_change", description: "insert/update/delete rows in the database" },
]

export function makeSqlExecuteTool(
  opts: SqlExecuteToolOptions,
): Tool<z.infer<typeof SqlStatementInput>, SqlExecuteOutput> {
  const conn = opts.connection
  const maxReturnedRows = opts.maxReturnedRows ?? DEFAULT_MAX_ROWS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: "sql.execute",
    inputs: SqlStatementInput,
    output_schema_key: "sql.execute@1",
    effects: MUTATION_EFFECTS,
    reversibility: "irreversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 3,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      assertSingleStatement(inputs.statement, "sql.execute")
      const params = inputs.params ?? []
      const timeout = timeoutLiteral(timeoutMs)
      try {
        const sql = await conn.handle()
        const out = await sql.begin(async (tx) => {
          if (timeout !== null) await tx.unsafe(`set local statement_timeout = ${timeout}`)
          const r = await tx.unsafe(inputs.statement, params)
          const meta = r as unknown as { count?: number; command?: string }
          const returned = Array.isArray(r) ? [...(r as unknown[])] : []
          return {
            returned,
            command: typeof meta.command === "string" ? meta.command : "EXECUTE",
            rows_affected: typeof meta.count === "number" ? meta.count : returned.length,
          }
        })
        const returnedTruncated = out.returned.length > maxReturnedRows
        const returnedRows = returnedTruncated
          ? out.returned.slice(0, maxReturnedRows)
          : out.returned
        return {
          rows_affected: out.rows_affected,
          command: out.command,
          returned_rows: returnedRows,
          returned_truncated: returnedTruncated,
          summary: `sql.execute: ${out.command} affected ${out.rows_affected} row(s)${
            returnedRows.length > 0
              ? `, returned ${returnedRows.length}${returnedTruncated ? "+" : ""}`
              : ""
          }`,
        }
      } catch (err) {
        throw new Error(conn.redact(`sql.execute failed: ${errMessage(err)}`))
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors defineHttpTools / defineMessagingTools, with a
// connection lifecycle the egress adapters do not have).
// -----------------------------------------------------------------------------

export interface SqlToolsConfig {
  /** The operator connection — a connection string (adapter-owned pool) or a
   * pre-opened `Bun.SQL` handle (operator-owned). */
  connection: SqlConnectionConfig
  /** Enable `sql.query` (L1 read). Default true. */
  query?: boolean | Omit<SqlQueryToolOptions, "connection">
  /** Enable `sql.execute` (L3 mutation). Default true. */
  execute?: boolean | Omit<SqlExecuteToolOptions, "connection">
}

export interface SqlAdapter {
  /** The configured tools, ready to register with the Action Kernel. */
  tools: Tool[]
  /** The connection (exposed for explicit lifecycle control). */
  connection: SqlConnection
  /** Close the connection if the adapter owns it (a no-op for an operator handle). */
  close(): Promise<void>
}

/** Build the configured SQL tools over one operator connection. Does NOT register
 * them — call `registerSqlTools` for that, or register `adapter.tools` yourself. */
export function createSqlTools(config: SqlToolsConfig): SqlAdapter {
  const connection = new SqlConnection(config.connection)
  const tools: Tool[] = []
  if (config.query !== false) {
    const o = typeof config.query === "object" ? config.query : {}
    tools.push(makeSqlQueryTool({ connection, ...o }) as Tool)
  }
  if (config.execute !== false) {
    const o = typeof config.execute === "object" ? config.execute : {}
    tools.push(makeSqlExecuteTool({ connection, ...o }) as Tool)
  }
  return { tools, connection, close: () => connection.close() }
}

/** Build AND register the configured SQL tools. Returns the adapter (for `close()`). */
export function registerSqlTools(config: SqlToolsConfig): SqlAdapter {
  const adapter = createSqlTools(config)
  for (const tool of adapter.tools) registerTool(tool)
  return adapter
}
