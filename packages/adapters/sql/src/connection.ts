import { SQL } from "bun"
import { applyRedactions, connectionRedactions, redactionVariants } from "./redact.js"

/**
 * The operator's database connection for the SQL adapter.
 *
 * Unlike the per-request egress adapters (HTTP/messaging), a database connection
 * is a long-lived, pooled resource, so the connection is resolved ONCE and the
 * `Bun.SQL` handle (itself a pool) is reused across queries. The credential — the
 * password in the connection string — is operator config: the agent never
 * supplies, sees, or names it.
 *
 *   - **No silent default.** The operator supplies the connection explicitly.
 *   - **Resolver seam.** A connection string may be a `() => Promise<string>` so a
 *     production host fetches it from a secret store at startup rather than
 *     persisting it in config. It is resolved at most once (memoised).
 *   - **Redacted.** The password (and its encoded forms) are scrubbed from any
 *     caught driver/connection error before it can reach an observation or the
 *     event log.
 *   - **Ownership.** A connection STRING is owned by the adapter — `close()` ends
 *     the pool. A pre-opened `SQL` handle belongs to the operator — `close()`
 *     leaves it open (mirrors `createPostgresStores`).
 */

export type SecretValue = string | (() => string | Promise<string>)

export type SqlConnectionConfig =
  | {
      /** A connection string, or a resolver that returns one. The adapter opens
       * and owns the pool. */
      url: SecretValue
    }
  | {
      /** A pre-opened `Bun.SQL` handle the operator owns and closes. */
      sql: SQL
      /** Extra literal secrets to redact from caught errors (e.g. the password,
       * when it is not recoverable from a handle the adapter did not open). */
      redactions?: string[]
    }

export class SqlConnection {
  private readonly owned: boolean
  private opening: Promise<SQL> | undefined
  private redactions: string[]

  constructor(private readonly config: SqlConnectionConfig) {
    this.owned = "url" in config
    this.redactions =
      "sql" in config ? (config.redactions ?? []).flatMap((s) => redactionVariants(s)) : []
  }

  /** Resolve (once) and return the pooled handle. */
  handle(): Promise<SQL> {
    if (!this.opening) this.opening = this.open()
    return this.opening
  }

  private async open(): Promise<SQL> {
    if ("sql" in this.config) return this.config.sql
    let url: string
    try {
      url = typeof this.config.url === "function" ? await this.config.url() : this.config.url
    } catch {
      // The resolver threw. Its message may embed secret material we never
      // obtained (so cannot add to the redaction set). Do NOT propagate it.
      throw new Error("sql: connection resolution failed")
    }
    // Derive the redaction set BEFORE opening, so it is in place for any error
    // the first query surfaces.
    this.redactions = connectionRedactions(url)
    return new SQL(url)
  }

  /** Scrub the connection password from arbitrary text. */
  redact(text: string): string {
    return applyRedactions(text, this.redactions)
  }

  /** Close the pool, but only if the adapter opened it. */
  async close(): Promise<void> {
    if (!this.owned || !this.opening) return
    const sql = await this.opening
    await sql.end()
  }
}
