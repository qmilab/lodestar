/**
 * @qmilab/lodestar-adapter-sql — governed SQL/database tools for the Lodestar
 * Action Kernel. P2 follow-on adapter (ADR-0013).
 *
 * - `sql.query` (L1) — run a single read-only statement; rows are UNTRUSTED
 *   inbound content. Runs inside a `READ ONLY` transaction.
 * - `sql.execute` (L3, operator-raisable to L4) — run a single mutation; held
 *   until approved under a holding policy.
 *
 * The headline is the **parameterized-only injection boundary**: values are always
 * bound as `$1..$N` (never string-concatenated), so a hostile value cannot become
 * SQL. Governance also covers the read/mutation trust split, operator-scoped
 * credentials (redacted from errors), and bounded capture (row cap + statement
 * timeout). A TS-level governance boundary, not database containment; targets
 * Postgres via Bun's native `Bun.SQL`.
 */
export {
  makeSqlQueryTool,
  makeSqlExecuteTool,
  createSqlTools,
  registerSqlTools,
  SqlQueryOutputSchema,
  SqlExecuteOutputSchema,
  type SqlQueryOutput,
  type SqlExecuteOutput,
  type SqlQueryToolOptions,
  type SqlExecuteToolOptions,
  type SqlToolsConfig,
  type SqlAdapter,
} from "./tools.js"
export {
  SqlConnection,
  type SqlConnectionConfig,
  type SecretValue,
} from "./connection.js"
export {
  redactionVariants,
  applyRedactions,
  connectionRedactions,
} from "./redact.js"
export {
  assertSingleStatement,
  assertReadOnly,
  isMultiStatement,
  stripLeadingNoise,
} from "./statement.js"
