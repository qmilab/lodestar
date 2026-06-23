# @qmilab/lodestar-memory-firewall — CLAUDE.md

This package governs the lifecycle of claims and beliefs. It is the gate between "an agent extracted something" and "the agent has adopted this as a belief it acts on."

## What lives here

- **Stores** (`src/stores/`) — abstract interfaces for claim, belief, and evidence storage, with two implementations behind each: an in-memory one (`InMemory*Store`) and a Postgres one (`Postgres*Store`). Both satisfy the same interface, so the firewall, retrieval, and sentinels are agnostic to which backend is in use.
- **Firewall** (`src/firewall.ts`) — the promotion gate. Decides whether a candidate claim can become a belief, and whether a belief can be promoted across lifecycle states. Every decision is routed to the constructor's `auditSink` as a `FirewallAuditEvent` (`claim.accepted` / `belief.adopted` / `belief.transitioned`). That internal producer type is **richer** than its on-wire contract: the firewall is made *observable* through these as the stable `firewall.*@1` events, whose wire shape (`FirewallAuditPayloadSchema`) lives in `@qmilab/lodestar-core` (ADR-0029, #137). The core payload is a **structural supertype** of `FirewallAuditEvent` (`by_authority` opaque-string vs `TransitionAuthority`, `axis` the locked four-value enum), so the hosts that wire the sink to the log (`-guard`, `-guard-mcp`, `-runtime-core`) `parse()` + stamp `schema_version "1"` at the emit boundary without this package depending on those constants or weakening its own types. The **store interfaces stay experimental by design** — an external integrator observes the firewall through those events (a pure projection over the log), not by binding to the mutable store.
- **Retrieval** (`src/retrieval.ts`) — gated retrieval. Respects ContextPolicy. Returns only beliefs that pass the lifecycle and sensitivity filters.

## Invariants

1. **No self-promotion.** An agent's own success does not promote a belief from `unverified` to `supported` or from `restricted` to `normal`. Promotion requires user confirmation, probe verification, or a narrow auto-promotion policy with logged evidence.

2. **Lifecycle axes are independent.** A change to `freshness_status` does not change `truth_status`. A change to `security_status` does not change `freshness_status`. Each axis has its own transition rules.

3. **Quarantine is one-way without explicit clearance.** A belief that enters `security_status: quarantined` does not return to `clean` without an explicit clearance event from an authorised actor.

4. **Retrieval respects ContextPolicy or refuses.** No retrieval path bypasses the policy gate. If a caller wants beliefs that the policy excludes, it must request `privileged_only` retrieval explicitly and be authorised for it.

5. **Every state transition produces an Explanation.** The firewall does not silently mutate state. Every promotion, demotion, quarantine, or supersession event carries a structured rationale.

6. **Contradiction routing is subject-related (Round 5).** Both the standard planner path (`GatedRetrieval.retrieve()` → `result.contradictions`) and the standalone surface (`GatedRetrieval.retrieveContradictions()` / `MemoryFirewall.retrieveContradictions()` — a thin delegate) return ONLY contradicted beliefs whose claim shares the same `structured_predicate.{subject, relation}` as one of the accepted-set beliefs the standard retrieval would return under the same policy.

   Design choices:
   - **(subject, relation) join, not subject-only.** Contradiction is meaningful when two beliefs assert different objects for the same proposition (`branch.current = main` vs `branch.current = release/foo`). Subject-only would lump unrelated relations together.
   - **Collision-free composite key.** Encoded as `JSON.stringify([subject, relation])`, not a delimiter-joined string — the Predicate schema allows free-form strings, so a delimiter byte can appear in either component (e.g. via mem0 / Letta / Zep imports of arbitrary user text).
   - **Same acceptance gates as `retrieve()`.** Freshness and uncertainty post-filters apply BEFORE predicate keys are extracted from the accepted set, and apply again to contradicted candidates. A stale supported belief that wouldn't actually be in the planner's context cannot drag in contradictions for itself; a stale contradiction cannot surface either.
   - **Claims without `structured_predicate` are excluded.** They cannot be subject-joined; the channel surfaces only what we can prove related.

   Subject-filtering implementation lives in `GatedRetrieval` (single source of truth — see `src/retrieval.ts`); `MemoryFirewall.retrieveContradictions` is a thin firewall-level surface that delegates to it. Sensitivity, scope, security, and retrieval gates still apply.

## What does not live here

- Claim extraction from observations: see `@qmilab/lodestar-cognitive-core/extractors`.
- Belief retrieval into model context: see `@qmilab/lodestar-cognitive-core` planner.
- Reflection that proposes promotions: see `@qmilab/lodestar-cognitive-core/reflection`.
- Sentinel hooks that flag suspicious beliefs: see `@qmilab/lodestar-harness/sentinels`.

## File layout

```
src/
├── index.ts                  # public exports
├── firewall.ts               # MemoryFirewall class
├── retrieval.ts              # gated retrieval
├── stores/
│   ├── claim-store.ts        # interface + in-memory impl
│   ├── belief-store.ts       # interface + in-memory impl
│   ├── evidence-store.ts     # interface + in-memory impl
│   ├── memory-store.ts       # interface + in-memory impl (typed memories)
│   ├── postgres-schema.ts    # DDL + ensureSchema / dropSchema / truncateAll
│   ├── postgres-errors.ts    # isUniqueViolation (shared 23505 detection)
│   ├── postgres-belief-store.ts    # PostgresBeliefStore
│   ├── postgres-claim-store.ts     # PostgresClaimStore
│   ├── postgres-evidence-store.ts  # PostgresEvidenceStore
│   ├── postgres.ts           # createPostgresStores() factory (subpath export)
│   └── postgres-stores.test.ts     # env-gated integration tests
└── transitions.ts            # allowed state transitions per axis
```

## Postgres backend (v0.2)

`Postgres{Belief,Claim,Evidence}Store` implement the same interfaces as the
in-memory stores, backed by Bun's native `Bun.SQL` (zero npm dependencies).
They exist so state survives a single session: two `MCPProxy` sessions pointed
at the same database see each other's claims/beliefs/evidence, which is what
cross-session provenance checks (e.g. the `tool-poisoning-cross-session` probe)
require.

- **Import from the `/postgres` subpath**, not the package root:
  `import { createPostgresStores } from "@qmilab/lodestar-memory-firewall/postgres"`.
  The subpath is deliberate — these stores depend on Bun's native `bun:sql`, so
  keeping them off the root export means Node/npm consumers who only use the
  in-memory stores never transitively `import "bun"`.
- **Wire it up** with `createPostgresStores(connectionString)` → `{ sql, claims,
  beliefs, evidence, ensureSchema, close }`. Call `await stores.ensureSchema()`
  once at startup (idempotent `create table if not exists`), then hand the three
  stores to `new MemoryFirewall(...)` exactly as you would the in-memory ones.
  `close()` only ends connections the factory opened (from a string); a
  caller-supplied `SQL` handle is left to its owner.
- **Storage model**: each row keeps the full Zod-validated object as `data
  jsonb` (re-parsed on read) plus mirrored scalar columns for the `*Filter`
  dimensions; mirrored columns and `data` are always written together, and
  `transition()` runs under `select … for update` so concurrent sessions can't
  tear a transition. Semantics match the in-memory stores exactly (same
  duplicate-`put` and `from_value` mismatch errors) — the probes that treat the
  in-memory store as spec hold here too.
- **Additive**: the proxy and `guard.wrap()` still default to the in-memory
  stores. The Postgres backend is now wired into both — the proxy via
  `MCPProxyOverrides.stores` (config-driven through `persistence` +
  resolved by the `lodestar guard mcp-proxy` CLI) and `guard.wrap()` via
  `GuardConfig.stores`. The `tool-poisoning-cross-session` probe
  (`packs/coding-agent-safety/`) exercises that wiring end to end.
- **Tests**: `postgres-stores.test.ts` is gated on `LODESTAR_TEST_DATABASE_URL`
  (skipped when unset). CI runs them against a `postgres:16` service; locally,
  point the var at a throwaway `postgres:16` container.

## When adding a new lifecycle state

Don't. The four axes (truth, retrieval, security, freshness) are stable. If you need a new dimension, add it as a separate attribute on the Belief schema with explicit transition rules. Do not silently add values to the existing enums.

## When adding a new transition rule

1. Update `transitions.ts` with the new allowed pair (from, to, authority required).
2. Add a test in `packs/lodestar-core/probes/` (declared in the pack manifest) that exercises both the allowed transition and a rejected one.
3. Document the rule in this CLAUDE.md.
