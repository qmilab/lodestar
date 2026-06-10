# @qmilab/lodestar-adapter-sql — CLAUDE.md

Governed SQL/database tools for the Action Kernel — a P2 follow-on adapter
(ADR-0013), pulled from epic #74's governance-rich backlog. The first native
adapter whose headline governance surface is an **injection boundary** rather than
(only) egress: the five ordered P2 adapters (shell → git → nostr → http →
messaging) defend destination pinning and credential scoping; SQL must additionally
make it structurally impossible for an agent-supplied value to become executable
SQL.

- **`sql.query`** — L1 read. Run one read-only statement; its rows are UNTRUSTED
  inbound content. Runs inside a `READ ONLY` transaction.
- **`sql.execute`** — L3 mutation (operator-raisable to L4). Run one mutation; held
  until approved under a holding policy.

Targets Postgres via Bun's native `Bun.SQL` (the same dependency-free driver the
memory-firewall Postgres stores use — no new runtime dep).

## What lives here

- `src/statement.ts` — the **lexical** layer of the injection boundary:
  `assertSingleStatement` (a quote-, dollar-quote-, and comment-aware scanner that
  rejects statement stacking) and `assertReadOnly` (the read tool's statement must
  lead with `SELECT`/`WITH`/`TABLE`/`VALUES`/`EXPLAIN`/`SHOW`). Honest scope: a
  fast-fail with clear errors, not a full SQL parser — correctness does not rest on
  it.
- `src/connection.ts` — the operator connection (`SqlConnection`): a connection
  string (resolved once, the adapter owns and pools the handle, `close()` ends it)
  or a pre-opened `Bun.SQL` handle (operator-owned, `close()` is a no-op — mirrors
  `createPostgresStores`). Parses the password from the string for redaction.
- `src/redact.ts` — `connectionRedactions` / `redactionVariants` / `applyRedactions`
  (raw + URL-encoded forms, longest-first). The git/Nostr/HTTP/messaging redaction
  rule specialised to a database password echoed in a driver error.
- `src/tools.ts` — the `sql.query@1` / `sql.execute@1` output schemas, the two
  `Tool`s, the `make*Tool` builders, and the `createSqlTools` / `registerSqlTools`
  config factory (which, unlike the egress adapters, returns an adapter with a
  `close()` because a database connection is a real, pooled resource).
- `src/sql.test.ts` — Bun unit tests for the DB-free layers (statement guards +
  redaction). The structural boundary (bound parameters + the `READ ONLY`
  transaction) needs a database and is the probe's job.

The headline invariants are locked by the harness probe
`packs/lodestar-core/probes/sql-adapter-enforces-invariants.ts`, which drives the
real tools through the real kernel against a real Postgres. It is DB-gated: it reads
`LODESTAR_TEST_DATABASE_URL`, skips loudly when unset, and runs against the
`postgres:16` service already wired into CI's `probes:ci` step.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not database containment** (same framing as
ADR-0004/0006/0007/0008/0009). It enforces, in-process:

1. **Parameterized-only (the injection boundary).** No string-SQL path is exposed.
   Values are always bound via `sql.unsafe(statement, params)` (the
   extended/prepared protocol), never concatenated, so a hostile value cannot become
   SQL. Passing the params array also forces one-statement-only at the protocol; the
   lexical guard rejects obvious stacking early.
2. **Read / mutation split with teeth.** `sql.query` is L1 and runs in a `READ ONLY`
   transaction — the DEFINITIVE read-only enforcement: a data-modifying CTE (`WITH d
   AS (DELETE … RETURNING …) SELECT …`) leads with `WITH` and slips the lexical
   check but is refused by the database itself. A mutation must go through
   `sql.execute` at the L3 floor (raise to L4), held for approval.
3. **Scoped credentials.** The connection is operator config (no silent default),
   resolved once, never in the agent's inputs, and the password is redacted from any
   caught driver error before it reaches an observation or the log.
4. **Bounded capture.** A row cap on what enters the observation and a per-statement
   `statement_timeout`. The cap bounds what enters the *observation*, not what the
   database computes — set a conservative `statement_timeout` and point the adapter
   at a least-privileged role for the rest.

**What it does NOT claim:** no OS/network sandbox of the database, no table/column/
row authorization (that is the DB role's job), and Postgres only in v0 (the `READ
ONLY` transaction + `statement_timeout` mechanics are Postgres-shaped). Dynamic
identifiers (table/column names) cannot be bound and must be composed from a fixed
allowlist in host code, never from the agent.

## Trust contracts

| Tool | Trust | reversibility | effects | sandbox | permissions |
|------|-------|---------------|---------|---------|-------------|
| `sql.query` | **L1** | `reversible` | `external_call` | `controlled-network` | `network.egress` |
| `sql.execute` | **L3** (→ L4) | `irreversible` | `world_state_change` | `controlled-network` | `network.egress` |

`blast_radius` is set by the proposer's `ActionContract`, not the `Tool`.
`sql.execute` at L3 parks at `pending_approval` only under a *holding* policy; raise
its `trust` to L4 for a production database so the trust-ladder floor holds every
write regardless of policy. Do **not** lower the floor to make a demo pass. Neither
tool spawns a subprocess, so the honest sandbox is `controlled-network` (ADR-0007).

## When you extend this

- Keep it **parameterized-only.** Never add a path that concatenates an
  agent-supplied value into SQL. If a host needs a dynamic identifier, it composes
  it from a fixed allowlist in host code and passes a fixed statement.
- Keep `sql.query` read-only at BOTH layers — the lexical prefix check AND the
  `READ ONLY` transaction. The transaction is load-bearing; the lexical check is the
  clear early error.
- Keep credentials operator-supplied and redacted; the agent must never see, name,
  or supply a connection string.
- Declare real `effects` / `reversibility` / `required_trust_level` / `sandbox`. No
  silent defaults for security-relevant settings.
- The `sql-adapter-enforces-invariants` probe is spec. If a change makes it pass
  without exercising the L3 hold, the parameterized boundary, both read-only paths,
  statement-stacking rejection, the row cap, or credential redaction, that's a probe
  bug, not an improvement.
