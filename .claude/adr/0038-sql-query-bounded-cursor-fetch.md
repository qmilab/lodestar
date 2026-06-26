# ADR-0038: `sql.query` bounds the fetch with a server-side cursor

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** Nandan, Claude
- **Related:** #101 (deferred hardening from the #100 / ADR-0013 adapter review),
  ADR-0013 (the governed SQL adapter this hardens), `packages/adapters/sql/`

## Context

`@qmilab/lodestar-adapter-sql`'s `sql.query` (L1 read) applied its `maxRows` cap
**after** the driver materialized the whole result set: it ran
`await tx.unsafe(statement, params)`, buffered every row into a JS array, then
`slice(0, maxRows)`. So the cap bounded what entered the *observation*, not what the
host process **buffered**. `statement_timeout` bounds wall-clock but not result
size, so a *fast* large scan (`SELECT * FROM huge` returning millions of small rows
within the timeout) is buffered in full before the cap trims it — and can OOM the
host. This is reachable at **L1** (`sql.query` auto-approves below the mutation
floor). ADR-0013 documented it as a known limitation; #101 is the fix.

Two complications shaped the design:

1. **Bun's `Bun.SQL` (pinned 1.3.14) exposes no JS-level cursor.** Its `Query`
   interface is a `Promise` with `.simple()/.execute()/.raw()/.values()` — no
   `.cursor()`, no async iteration. So "stream with `for await` / `.cursor()`" (the
   issue's first suggestion) is not available in-version. The in-version primitive
   is the **SQL-level server-side cursor**: `DECLARE … CURSOR` + `FETCH`.
2. A non-Postgres connection URL (`mysql://`, `sqlite://`) fails confusingly
   mid-query, because every tool is Postgres-shaped (`begin("read only")`,
   `SET LOCAL statement_timeout`, now `DECLARE … CURSOR`).

## Decision

**Read `sql.query` through a Postgres server-side cursor.** Inside the existing
`READ ONLY` transaction, `sql.query` now:

- `DECLARE`s a `NO SCROLL` cursor for the (already single-statement, already
  read-only) statement — the trusted statement text is interpolated into the
  `DECLARE`, exactly as the direct path interpolated it into `unsafe`; every
  `$1..$N` value still rides in `params` and binds (the extended protocol carries
  parameters through `DECLARE CURSOR`, the same mechanism psycopg's named cursors
  rely on), so the **parameterized-only injection boundary is unchanged**;
- `FETCH FORWARD maxRows + 1` — one row past the cap, to learn `truncated` — so the
  host buffers at most `maxRows + 1` rows regardless of how large the full result
  is;
- `CLOSE`s the cursor (best-effort; the transaction's commit/rollback closes it
  anyway).

The cursor name is a **fixed identifier-safe constant**: each `sql.query` runs in
its own `begin("read only")` transaction, which reserves a dedicated connection, so
the cursor namespace is never shared across concurrent queries.

**Routing / graceful degradation.** Only the SELECT-family statements
(`SELECT`/`WITH`/`VALUES`/`TABLE`) are cursorable — Postgres `DECLARE … CURSOR`
accepts only a `SELECT`/`VALUES` query. `EXPLAIN`/`SHOW` are read-only but **not**
cursorable; they take the prior direct read (their output is inherently small, so
bounding the fetch buys nothing). The route is decided by the leading keyword
(`isCursorable`, comment/whitespace-tolerant), deterministically and before any
statement touches the database — no error-and-rollback dance, no savepoint overhead
on the hot path. A data-modifying CTE (`WITH d AS (DELETE …) …`) leads with `WITH`
so it routes to the cursor, where Postgres refuses to `DECLARE` a cursor over a
data-modifying statement — the **same refusal** the `READ ONLY` transaction gives,
reached one step earlier; the read tool still cannot mutate.

The output shape (`rows`, `row_count`, `truncated`, `columns`, `command`) is
unchanged. `command` for a cursor read is reported as `SELECT` — its true command
tag (the `FETCH`'s own tag is the transport, not the query); the direct path keeps
reporting the driver's tag (so `EXPLAIN`/`SHOW` are faithful).

**Ride-along — non-Postgres URL clear error.** `assertPostgresUrl` runs on the
`{ url }` path before opening: a URL whose scheme is not `postgres(ql)://` throws a
clear "only Postgres connections are supported" error naming **only the scheme**
(never the connection string — no credential leak). A schemeless libpq DSN
(`host=… password=…`) carries no `scheme://` to inspect, so it is left to the driver
(best-effort, as #101 scopes it); the `{ sql }` handle path has no URL at all.

## Consequences

- `sql.query`'s host-memory footprint is bounded by `maxRows`, not by the result
  size — a fast huge scan at L1 can no longer OOM the host before the cap trims it.
  This closes the deferred ADR-0013 limitation.
- A cursorable read now costs three extra round-trips (`DECLARE`/`FETCH`/`CLOSE`)
  over the direct path's one. Correctness over micro-latency: the whole point is to
  not materialize an unbounded result. `EXPLAIN`/`SHOW` keep the single round-trip.
- The boundary stays a **TS-level governance boundary, not database containment**
  (ADR-0004): the query still reaches the real database; a least-privileged role and
  server-side limits remain the operator's defence in depth.
- The `sql-adapter-enforces-invariants` probe gains two sub-cases — a bounded-fetch
  case (a 100M-row `generate_series` capped at 2 completes via the cursor; a
  regression to materialize-then-slice times out / exhausts memory instead of
  returning 2 rows + `truncated`) and a non-Postgres-URL clear-error case. Both run
  under the same DB gate (`LODESTAR_TEST_DATABASE_URL`, skip-loud, `postgres:16` in
  CI). Probe count is unchanged (same probe, new sub-cases). DB-free unit tests
  cover `isCursorable` and `assertPostgresUrl`.
- No `packages/core` schema change, no new event, no new package.

## Alternatives considered

- **Wrap the statement as `SELECT * FROM (<stmt>) LIMIT maxRows+1`.** Rejected: a
  derived table fails on duplicate output columns (`SELECT id, id …`), cannot wrap
  `EXPLAIN`/`SHOW`, and needs trailing-semicolon stripping — it breaks legitimate
  reads. The cursor wraps any cursorable statement without rewriting it.
- **A savepoint-protected runtime fallback** (attempt the cursor, roll back to a
  savepoint and retry directly on any failure). Rejected for v0: it adds a
  `SAVEPOINT`/`RELEASE` round-trip pair to *every* read for a fallback that prefix
  routing already covers (the only non-cursorable read statements are
  `EXPLAIN`/`SHOW`, routed directly up front). A SELECT that succeeds directly but
  cannot be a cursor inside a `READ ONLY` transaction does not realistically exist.
- **Wait for a Bun `.cursor()` / async-iteration API.** Rejected: not present in the
  pinned Bun, and the SQL-level cursor is the canonical, driver-agnostic Postgres
  mechanism regardless.
- **A short `statement_timeout` as the sole mitigation** (the ADR-0013 stopgap).
  Rejected as the fix: it bounds wall-clock, not result size — a fast large scan
  buffers in full within the timeout.
