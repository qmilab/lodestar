/**
 * True when a `Bun.SQL` error is a Postgres unique-constraint violation
 * (SQLSTATE `23505`).
 *
 * Bun surfaces the SQLSTATE on `errno` in the versions we target (verified
 * against postgres:16 on Bun 1.3.x, where `code` is the generic
 * `ERR_POSTGRES_SERVER_ERROR`). We also accept it on `code` so the check keeps
 * working on Bun builds that place the SQLSTATE there instead.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { errno?: unknown; code?: unknown }
  return e.errno === "23505" || e.code === "23505"
}
