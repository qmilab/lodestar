# ADR-0013: governed SQL/database adapter (parameterized-only)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Nandan, Claude
- **Related:** issue #77 (child of epic #74), `packages/adapters/sql/`,
  ADR-0004 (TS-level boundary), ADR-0005 (native-adapter prioritization),
  ADR-0006–0009 (the shipped egress-adapter pattern), ADR-0012 (fs.write)

## Context

Epic #74 (native adapters) ships each new domain as "its own
`@qmilab/lodestar-adapter-*` package + a `*-enforces-*-invariants` probe + an
ADR." Issue #77 asks for a governed SQL/database adapter: a query path (L1,
untrusted rows → `external_document`) and a mutation path (L3/L4),
**parameterized-only** (no string SQL), scoped credentials never in argv/output,
and a result-row cap.

SQL is a new domain — there is no existing database adapter — so unlike `fs.write`
(ADR-0012) it gets its own package. It is also the first native adapter whose
headline governance surface is an **injection boundary** rather than (only)
egress: the five P2 adapters (shell/git/nostr/http/messaging) defend destination
pinning and credential scoping; SQL must additionally make it structurally
impossible for an agent-supplied value to become executable SQL.

## Decision

Ship **`@qmilab/lodestar-adapter-sql`** with two tools over one operator
connection, targeting Postgres via Bun's native `Bun.SQL` (the same dependency-free
driver the memory-firewall Postgres stores already use — no new runtime dep).

**`sql.query` — L1 read (untrusted inbound).** A single read-only statement; its
rows are untrusted external content (an `external_call` effect, `reversible`,
`controlled-network`, `network.egress`). Two layers enforce read-only:
- a *lexical* fast-fail that rejects an obvious write (the statement must lead with
  `SELECT`/`WITH`/`TABLE`/`VALUES`/`EXPLAIN`/`SHOW`), and
- the *definitive* enforcement — the query runs inside a `READ ONLY` transaction,
  so even a data-modifying CTE (`WITH d AS (DELETE … RETURNING …) SELECT …`), which
  leads with `WITH` and slips the lexical check, is **refused by the database
  itself**. This is what makes the L1/L3 read-vs-mutation split real rather than
  cosmetic.
A row cap trims what enters the observation; a per-statement `statement_timeout`
bounds wall-clock.

**`sql.execute` — L3 mutation (operator-raisable to L4).** A single mutation
(`world_state_change`, `irreversible`). It sits at the **L3 floor** so a holding
policy parks it at `pending_approval` until a human approves and it touches the
database only after `execute` — operators raise it to **L4** for a production
database so every write is held. Returns `rows_affected` and any `RETURNING` rows
(also capped, also untrusted).

**The injection boundary (the headline).** No string-SQL path is exposed. The
agent supplies `{ statement, params }`; every value is bound via
`sql.unsafe(statement, params)` — Postgres's extended/prepared protocol when
parameters are present — never string-concatenated. So `Robert'); DROP TABLE
students;--` passed as a parameter is stored as a literal string, never interpreted
as SQL. Single-statement enforcement is layered: with bound parameters the extended
protocol rejects multiple commands; for a PARAMETERLESS statement —
`sql.unsafe(stmt, [])` falls back to the *simple* protocol, which permits
`;`-separated commands — the lexical single-statement guard (quote-, dollar-quote-,
and comment-aware, and erring toward over-rejection) is the authoritative defence
that stacking never reaches the driver, backed for `sql.query` by the READ ONLY
transaction and for `sql.execute` by the human-approval gate (the approver sees the
full statement text).

**Credentials.** The connection is operator config — a connection string (resolved
once; the adapter owns and pools the handle and `close()`s it) or a pre-opened
`Bun.SQL` handle the operator owns (`close()` leaves it open, mirroring
`createPostgresStores`). The agent never supplies, sees, or names it. The password
is parsed from the connection string and, with its URL-encoded variants, redacted
from any caught driver error before it can reach a failed-action audit or the
event log.

Like every shipped adapter, this is a **TS-level governance boundary, not database
containment** (ADR-0004): the query reaches the real database by design, and
DB-side privileges (pointing the adapter at a least-privileged role) are the
operator's defence in depth, not this adapter's claim.

The invariants are locked by `sql-adapter-enforces-invariants` in
`packs/lodestar-core/`, which drives the real tools through the real kernel against
a real Postgres — the L1 read, the row cap, both read-only paths (lexical DELETE +
data-modifying CTE), the L3 two-phase hold (a held mutation touches nothing), the
Bobby-Tables parameter, statement-stacking rejection, and credential redaction. It
needs a database, so — like `tool-poisoning-cross-session` — it reads
`LODESTAR_TEST_DATABASE_URL`, skips loudly when unset, and runs against the
`postgres:16` service already wired into the CI `probes:ci` step (no `ci.yml`
change needed).

## Consequences

- A governed SQL surface any `guard.wrap()` / MCP-proxy host can register, with the
  parameterized-injection boundary, the read/mutation trust split, scoped
  credentials, and bounded capture enforced in-process.
- One new package: `publish.yml` (both PUBLISH_ORDER lists), root `tsconfig.json`
  references, and root `devDependencies` gain `@qmilab/lodestar-adapter-sql`
  (the last is what lets the root-run probe resolve it). No new runtime dependency
  (Bun.SQL is built in).
- `lodestar-core` grows to **45 probes (49 across both packs)**; the new
  `sql_injection_boundary` invariant and `sql_adapter` coverage area are declared
  in the pack manifest.
- The adapter exposes a connection **lifecycle** (`createSqlTools` /
  `registerSqlTools` return an adapter with `close()`) that the stateless
  per-request egress adapters do not — because a database connection is a
  long-lived, pooled resource.

## Alternatives considered

- **A raw-string query path (operator opt-in).** Rejected: the whole point is that
  no string-SQL path exists. An operator who needs dynamic identifiers (table/column
  names, which cannot be bound) should compose them from a fixed allowlist in their
  own host code, not hand a concatenated string to the agent's tool.
- **Lexical read-only enforcement only.** Rejected as the sole mechanism: a
  data-modifying CTE leads with `WITH` and passes a prefix check. The `READ ONLY`
  transaction is the load-bearing guarantee; the lexical check is a fast, clear
  error on top.
- **Extend an existing package (as fs.write extended adapter-filesystem).**
  Rejected: there is no existing database domain to extend; SQL is a genuinely new
  domain, so the one-package-per-domain convention says it gets its own package.
- **A generic ORM / query-builder dependency.** Rejected: adds a runtime dependency
  and an abstraction the governance does not need. Bun.SQL's bound-parameter
  `unsafe(statement, params)` is exactly the parameterized primitive the boundary
  rests on.
- **MySQL/SQLite support in v0.** Deferred: the `READ ONLY` transaction and
  `statement_timeout` mechanics are written for Postgres (matching the rest of
  Lodestar's Bun.SQL usage). Other engines are an additive follow-up.
