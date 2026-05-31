import { SQL } from "bun"
import { PostgresBeliefStore } from "./postgres-belief-store.js"
import { PostgresClaimStore } from "./postgres-claim-store.js"
import { PostgresEvidenceStore } from "./postgres-evidence-store.js"
import { ensureSchema } from "./postgres-schema.js"

export { ensureSchema, dropSchema, truncateAll, TABLES } from "./postgres-schema.js"
export { PostgresBeliefStore } from "./postgres-belief-store.js"
export { PostgresClaimStore } from "./postgres-claim-store.js"
export { PostgresEvidenceStore } from "./postgres-evidence-store.js"

/** The three firewall stores backed by one shared Postgres connection. */
export interface PostgresStores {
  /** The underlying Bun.SQL handle, exposed for `ensureSchema`/`close`/admin. */
  sql: SQL
  claims: PostgresClaimStore
  beliefs: PostgresBeliefStore
  evidence: PostgresEvidenceStore
  /** Create the tables/indexes if absent (idempotent). */
  ensureSchema(): Promise<void>
  /** Close the connection pool. */
  close(): Promise<void>
}

/**
 * Wire the three Postgres-backed firewall stores onto a single connection.
 *
 * This is the entry point the cross-session probe and (later) the MCP proxy
 * use to give a session durable, shared belief/claim/evidence state instead of
 * the per-session in-memory maps. Two processes pointed at the same
 * `connectionString` see each other's writes.
 *
 * Accepts either a connection string (a new `Bun.SQL` is created and owned by
 * the returned object) or an existing `SQL` handle (the caller retains
 * ownership; `close()` will still end it).
 *
 * @example
 * const stores = createPostgresStores(process.env.DATABASE_URL!)
 * await stores.ensureSchema()
 * const firewall = new MemoryFirewall(stores.claims, stores.beliefs, stores.evidence, sink)
 */
export function createPostgresStores(connection: string | SQL): PostgresStores {
  const sql = typeof connection === "string" ? new SQL(connection) : connection
  return {
    sql,
    claims: new PostgresClaimStore(sql),
    beliefs: new PostgresBeliefStore(sql),
    evidence: new PostgresEvidenceStore(sql),
    ensureSchema: () => ensureSchema(sql),
    close: () => sql.end(),
  }
}
