# ADR-0029: Memory-firewall observability via stable events, not a stable store interface

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Nandan, Claude
- **Related:** issue #137 (epic #140 — public-API stability ledger), ADR-0014 (the "every read-side surface is a pure projection over `EventEnvelope[]`" principle), docs/reference/public-api.md

## Context

Epic #140 closes the gaps where the stability ledger's promise — *"the event
log is the source of truth; every read-side surface is a pure projection over
`EventEnvelope[]`"* — isn't yet kept. Its last child, #137, named the
memory-firewall: `docs/reference/public-api.md` listed "the firewall store
interfaces" as experimental, so an external integrator wanting to observe the
firewall (lifecycle axes, promotion/transition decisions) had to bind to the
store directly, against an API with no stability contract.

The issue offered two paths: **(A)** declare a firewall **store read
interface** stable, or **(B)** emit firewall decisions as durable **envelope
events** and stabilize that wire shape, the way `sentinel.alerted@1` /
`calibration.computed@1` were stabilized.

A scoping pass surfaced the load-bearing fact: **option B's mechanism already
existed.** `MemoryFirewall` already routes every decision (`claim.accepted`,
`belief.adopted`, `belief.transitioned`) to an `auditSink`; all three hosts
(`guard.wrap()`, the MCP proxy, the runtime gate) already wrote those to the
log as `firewall.<kind>`; and `@qmilab/lodestar-trace`'s `projectChain()`
already projected them (`type.startsWith("firewall.")`). The events were in
committed logs and exercised by several probes. What was missing was only the
**stability contract**: the payload type lived in `-memory-firewall` (not
`-core`), the emitters stamped the generic default `schema_version "0.1.0"`
rather than a dedicated version, and nothing was pinned in the
`public-api-surface` probe or the ledger.

## Decision

Take **option B**. Graduate the firewall audit events into a versioned,
ledger-stable `firewall.*@1` contract; **leave the store interfaces
experimental** on purpose.

1. **`@qmilab/lodestar-core` owns the wire shape.** New `schemas/firewall.ts`
   defines `FirewallAuditPayloadSchema` (a `kind`-discriminated union of the
   three payloads), `FirewallLifecycleAxisSchema`, the three
   `FIREWALL_*_EVENT_TYPE` constants + a shared `FIREWALL_EVENT_SCHEMA_VERSION =
   "1"`, and `firewallEventType(kind)` (the single `kind → type` mapping every
   emitter shares).
2. **The core payload is a structural supertype of the producer type.** `axis`
   is the locked four-value enum; `by_authority` / `from_value` / `to_value`
   are opaque strings (open value sets — additive-safe, and the trace
   projection already treats them as opaque). So `-memory-firewall`'s richer
   internal `FirewallAuditEvent` (with `by_authority: TransitionAuthority`) is
   assignable to the core type and is left **unchanged** — no ripple into the
   reflection producers.
3. **Hosts validate + stamp at the emit boundary.** Each of the three emitters
   now `FirewallAuditPayloadSchema.parse(event)`, emits under
   `firewallEventType(kind)`, and stamps `FIREWALL_EVENT_SCHEMA_VERSION`. The
   arbiter feed is preserved (a `belief.adopted` still populates
   `observedBeliefIds`).
4. **The three envelope `type` strings are kept verbatim** (two-segment,
   `firewall.claim.accepted` etc.) so existing logs and the trace projection
   keep working. Only the `schema_version` moves `"0.1.0" → "1"`.
5. Pinned in the `public-api-surface` probe and promoted in the ledger; the
   store interfaces' experimental note now states *why* they stay experimental.

## Consequences

- **Easier:** an external read surface observes the firewall through the same
  event-projection path as everything else — the ledger's pure-projection
  promise now holds for the firewall too. The version is a real contract
  (`"1"`), so consumers can validate by type + version.
- **Harder / accepted:** `firewall.*@1` is now an additive-only surface — a
  field can be added, never removed/re-typed without a version bump. New logs
  carry `schema_version "1"` while pre-existing fixture logs carry `"0.1.0"`;
  the tolerant reader projects both, so this is a non-event for consumers (the
  `event-log-canonical-hash` probe already used `"1"` for a hand-built
  `firewall.belief.adopted`, confirming `"1"` was the latent expectation).
- The store interfaces remain free to evolve with the probe surface.

## Alternatives considered

- **Option A — stabilize a store read interface.** Rejected: `ClaimStore` /
  `BeliefStore` / `EvidenceStore` are mutable read+**write** APIs (`put`,
  `transition`, `setSupersededBy`, `history`). Declaring them stable would
  couple integrators to the store implementation and contradict the ledger's
  own pure-projection principle. The issue itself called the event path "the
  more consistent of the two."
- **Both (A + B).** Rejected for #137: two contracts to maintain for one need;
  the event stream alone covers the read use case.
- **Consolidate to one `firewall.transition@1` type.** Rejected: would change
  the envelope `type` strings already in committed logs and in the trace
  projection. Three types under one shared version preserves the wire while
  still versioning as one family.
