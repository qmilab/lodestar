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

/** Postgres URL schemes Bun.SQL understands. */
const POSTGRES_SCHEME = /^postgres(ql)?$/i

/**
 * Best-effort early guard for the `{ url }` path: if the connection string is a URL
 * with a NON-Postgres scheme (`mysql://`, `sqlite://`, …) fail fast with a clear
 * message instead of a confusing mid-query error, because every tool here uses
 * Postgres-specific machinery (`begin("read only")`, `SET LOCAL statement_timeout`,
 * server-side `DECLARE … CURSOR`, the `.command`/`.count` result shape).
 *
 * It inspects ONLY the scheme: a schemeless libpq key/value DSN (`host=…
 * password=…`) carries no `scheme://` to test, so it is left to the driver (the
 * `{ sql }` handle path has no URL at all). The thrown message names ONLY the
 * scheme — never the connection string — so no credential can leak through it.
 */
export function assertPostgresUrl(connectionString: string): void {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(connectionString)
  if (m && !POSTGRES_SCHEME.test(m[1] as string)) {
    const scheme = (m[1] as string).toLowerCase()
    throw new Error(
      `sql: only Postgres connections are supported, but the connection scheme is '${scheme}://'. This adapter relies on Postgres features (READ ONLY transactions, statement_timeout, server-side cursors).`,
    )
  }
}

export type SqlConnectionConfig =
  | {
      /** A connection string, or a resolver that returns one. The adapter opens
       * and owns the pool. */
      url: SecretValue
      /** Extra literal secrets to redact from caught errors — use when the
       * connection string is a non-URL DSN whose password the adapter cannot parse
       * out (e.g. a libpq `host=… password=…` string). Merged with the password
       * the adapter does manage to recover. */
      redactions?: string[]
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
    // Seed from any operator-supplied redactions (both config variants); the
    // `url` variant augments this with the parsed password in `open()`.
    this.redactions = (config.redactions ?? []).flatMap((s) => redactionVariants(s))
  }

  /** Resolve (once) and return the pooled handle. A FAILED open is not memoised —
   * a transient resolver/connection error clears the slot so the next call retries
   * instead of bricking the connection for the process lifetime. */
  handle(): Promise<SQL> {
    if (!this.opening) {
      this.opening = this.open().catch((err) => {
        this.opening = undefined
        throw err
      })
    }
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
    // Augment (not replace) the operator-supplied redactions with the password
    // parsed from the connection string, BEFORE opening, so the set is in place
    // for any error the first query surfaces. A non-URL DSN yields none here, so
    // the operator's explicit `redactions` are the fallback.
    this.redactions = [...new Set([...this.redactions, ...connectionRedactions(url)])]
    // Fail fast on a non-Postgres scheme (mysql://, sqlite://, …) with a clear
    // message rather than a confusing redacted error mid-query. Redactions are
    // already in place above (the message itself names only the scheme).
    assertPostgresUrl(url)
    return new SQL(url)
  }

  /** Scrub the connection password from arbitrary text. */
  redact(text: string): string {
    return applyRedactions(text, this.redactions)
  }

  /** Close the pool, but only if the adapter opened it. A rejected open leaves
   * nothing to close, and `close()` must never re-throw the connection error from
   * a caller's `finally`. */
  async close(): Promise<void> {
    if (!this.owned || !this.opening) return
    const sql = await this.opening.catch(() => undefined)
    if (sql) await sql.end()
  }
}
