# @qmilab/lodestar-adapter-sql

Governed SQL/database tools for the Lodestar Action Kernel — part of
**Lodestar**, the trust layer for AI agents.

Two tools over one operator connection:

| Tool | Trust | Direction | What it does |
|------|-------|-----------|--------------|
| `sql.query` | **L1** | read | Run one read-only statement; rows are untrusted inbound content. Runs inside a `READ ONLY` transaction. |
| `sql.execute` | **L3** (→ L4) | mutation | Run one mutation (INSERT/UPDATE/DELETE). Held until a human approves under a holding policy. |

The headline is the **injection boundary**: the agent never builds SQL by
concatenating values. It supplies a statement with `$1..$N` placeholders and a
separate `params` array, and every value is *bound* by the driver — so a value
supplied by an untrusted caller is stored as a literal string, never interpreted
as SQL. Targets Postgres via Bun's native `Bun.SQL` (no runtime
dependency).

## Install

```sh
bun add @qmilab/lodestar-adapter-sql
```

## Use

```ts
import { registerSqlTools } from "@qmilab/lodestar-adapter-sql"

const sql = registerSqlTools({
  // The operator connection. A function is resolved once so a host can fetch the
  // connection string from a secret store. Never the agent's; the password is
  // redacted from any error. (Or pass a pre-opened Bun.SQL handle: { sql }.)
  connection: { url: () => secrets.get("APP_DATABASE_URL") },
  // sql.query — L1 read. maxRows caps what enters the observation (default 1000).
  query: { maxRows: 500 },
  // sql.execute — L3 mutation. Raise to L4 for a production database so every
  // write is held for human approval.
  execute: { trust: 4 },
})

// …later, on shutdown — closes the pool if the adapter opened it (a no-op for a
// connection you passed in as { sql }).
await sql.close()
```

The tools register into the Action Kernel's tool registry. Drive them through the
kernel (`propose → arbitrate → execute`) like any governed tool; a host (Guard, the
MCP proxy, an example) supplies the policy gate and `KernelContext`. `sql.execute`
sits at the L3 floor, so a holding policy parks it at `pending_approval` until a
human resolves the hold — and it touches the database only then.

### The agent's inputs

```ts
// sql.query — exactly one read-only statement; bind every value via params.
{ statement: "select id, email from users where org_id = $1 limit 50", params: ["org_42"] }

// sql.execute — exactly one mutation; bind every value via params.
{ statement: "update users set last_seen = now() where id = $1", params: ["user_7"] }
```

Use a placeholder for **every value** and pass it in `params` — never
string-concatenate a value into the statement. A write through `sql.query`, a
second stacked statement, or a parameter that tries to be SQL all fail the action.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not database containment** (the same honesty as
the shell / git / Nostr / HTTP / messaging adapters, ADR-0004/0006–0009). It
enforces, in-process:

1. **Parameterized-only (the injection boundary).** Values are always bound as
   `$1..$N`, never concatenated. Single-statement is enforced by the extended
   protocol when parameters are present and by a quote-/comment-/dollar-quote-aware
   lexical guard when they are not (a parameterless statement falls back to the
   simple protocol) — so stacking never reaches the driver either way.
2. **Read / mutation split.** `sql.query` (L1) runs inside a `READ ONLY`
   transaction, so even a data-modifying CTE is refused by the database itself — its
   rows are untrusted inbound content. A mutation must go through `sql.execute`,
   which sits at the L3 floor (raise to L4) and is held for approval.
3. **Scoped credentials.** The connection is operator config (no silent default),
   resolved once, never in the agent's inputs, and the password is redacted from any
   caught error before it can reach an observation or the log.
4. **Bounded capture.** `sql.query` reads through a server-side cursor — it DECLAREs
   a `NO SCROLL` cursor inside the `READ ONLY` transaction and FETCHes at most one
   row past the cap — so the host buffers a bounded number of rows no matter how
   large the full result is. The cap bounds the *fetch*, not merely the captured
   slice, so a fast huge scan (`SELECT * FROM huge`) cannot OOM the process (#101).
   `EXPLAIN`/`SHOW` (whose output is inherently small) take a direct read; a
   per-statement `statement_timeout` bounds wall-clock on top.

**What it does NOT claim:** it does not OS- or network-sandbox the database, and it
does not enforce table/column/row-level authorization. The query reaches the real
database by design — that is the governed action. DB-side privileges (point the
adapter at a **least-privileged role**) are your defence in depth, not this
adapter's claim. Dynamic identifiers (table/column names, which cannot be bound)
must be composed from a fixed allowlist in your host code, never handed in from the
agent.

Design/scope lock: ADR-0013.

## License

Apache-2.0
