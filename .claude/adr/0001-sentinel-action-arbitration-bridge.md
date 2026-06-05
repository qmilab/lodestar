# ADR-0001: Sentinel→action wiring via a stream-driven, host-side arbitration bridge

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Nandan, Claude
- **Related:** ADR-0002, `docs/architecture/policy-kernel.md`, `docs/architecture/sentinels.md`, `packages/policy-kernel/src/gate.ts`

## Context

The Policy Kernel's arbitrate hook (PR #45) was built to let sentinel alerts and
calibration flags *gate* an action: `compile(policy, { arbitration: { resolveContext } })`
makes the gate call `resolveContext(action) → ArbitrationContext { beliefs, alerts,
calibration }` on every `arbitrate`, and a landed alert scoped to the action's
backing beliefs strengthens the verdict (`allow → hold → deny`). The mechanism is
real and probed *at the gate level* (`sentinel-alert-gates-dependent-action`,
`calibration-flag-escalates-action`) — but **no host wires it**. `git grep` finds
zero `SentinelRunner` references in `guard`, `guard-mcp`, or `cli`. So in production
sentinels still only observe; "a sentinel can gate an action" is mechanically
possible but never realised end-to-end.

Three constraints shape the fix:

1. **`arbitration` is a *compile-time* option of the gate.** A host cannot inject a
   resolver into an already-compiled gate; the resolver must be bound when the
   policy is compiled.
2. **The load-bearing sentinels only fire at `decision.made`.** Both
   `suspicious-memory-origin` (fires its `belief`-subject alert when an
   external_document-rooted belief enters a decision's `belief_dependencies`) and
   `low-confidence-action` (maps an action to its beliefs via
   `decision_id → belief_dependencies`) need a `decision.made` event. **Neither
   guard nor the proxy emits one today** — guard threads an opaque `decision_id`
   and skips the Decision link in the chain entirely. Without `decision.made` the
   hook has nothing to consume.
3. **Layering must not invert.** `@qmilab/lodestar-policy-kernel` deliberately does
   not import `@qmilab/lodestar-harness` (the calibrator/sentinel *measure*, the
   kernel *reads* their structural output — `CalibrationSnapshot`, `BackingBelief`).
   The harness's stated boundary is "sentinels alert; they never block." Whatever
   bridges the two must not move that boundary.

Package edges today: `harness → {core, event-log}`; `policy-kernel → {core,
action-kernel}`; `guard → {…, policy-kernel}` (no harness); `guard-mcp → guard`.

## Decision

Introduce a **stream-driven `SentinelArbiter`** — a host-side bridge that turns the
event stream a host already emits into the `ArbitrationContext` the gate consumes.

- It is fed every emitted event via `observe(event)`. Internally it (a) runs a
  `SentinelRunner` over the stream and **buffers the alerts that land**, and (b)
  projects `decision.made → belief_dependencies` and `belief.adopted →
  { calibration_class, confidence, truth_status }` from the *same* stream, using the
  harness's tolerant views — exactly as the sentinels do. It therefore needs **no
  store injection**; it is self-contained from the stream.
- It exposes `resolveContext(action) → ArbitrationContext`:
  `alerts` = the buffered landed payloads; `beliefs` = `action.decision_id →
  belief_dependencies → BackingBelief` from its own belief cache; `calibration` =
  an optional injected snapshot.
- It lives in the **host layer (`@qmilab/lodestar-guard`)**, adding a new
  `guard → harness` edge; `guard-mcp` reuses it through its existing `→ guard`
  dependency. Because it lives in guard — which already depends on policy-kernel —
  the arbiter imports the `ArbitrationContext` / `BackingBelief` *types* directly;
  the layering constraint it must honour is the other direction: **the harness
  stays free of policy-kernel** (it produces alerts and calibration reports; the
  *projection of those into enforcement input* is host glue, which is why the
  bridge sits in the host, not in harness). The harness keeps its "observe-only"
  boundary.
- **Wiring contract:** the caller constructs the arbiter, compiles the policy with
  `arbitration.resolveContext = a => arbiter.resolveContext(a)`, and passes the
  arbiter into the host. The host binds it to the session and calls
  `arbiter.observe(envelope)` for every event it emits. A resulting hold flows
  through the host's existing approval-resolver seam.

The *source* of the `decision.made` link is host-specific and is the subject of
ADR-0002.

## Consequences

- Closes the observe→enforce gap without moving the harness boundary or adding a
  blocking path from a sentinel. The kernel still only *reads*; the arbiter only
  *projects*.
- One reusable bridge serves every host; the only per-host difference is where the
  decision link comes from (ADR-0002).
- Hosts must now emit `decision.made`. This is a genuine improvement — guard
  currently skips the Decision link, so the epistemic chain is incomplete; P1
  completes it.
- The compile-time nature of `arbitration` forces a two-step wiring (build arbiter →
  compile with it → hand both to the host). Accepted: it keeps the gate pure and the
  resolver's session state owned by the host.
- Scoping precision is only as good as the decision link the host can produce —
  which is exactly why the host sequencing is its own decision (ADR-0002).

## Alternatives considered

- **Bridge in `@qmilab/lodestar-harness`.** Rejected: even though it would type the
  context structurally without importing policy-kernel, it nudges the harness from
  "observe" toward "feed enforcement." Keeping the bridge in the host preserves a
  clean narrative and an honest dependency graph.
- **Inject the belief/decision stores into the arbiter.** Rejected: stream
  projection is simpler, matches how the sentinels already work, and avoids
  coupling the arbiter to a store backend.
- **Coarse "all session beliefs back every action" scoping.** Rejected for the
  precise (agent-declared) host; reserved as a deliberately conservative fallback
  for the opaque-agent host (see ADR-0002).
