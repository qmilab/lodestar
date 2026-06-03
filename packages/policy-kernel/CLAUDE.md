# @qmilab/lodestar-policy-kernel — CLAUDE.md

The component that turns the *declared* trust ladder and action contract into
an *enforced* decision. It compiles a declarative `Policy` document
(`@qmilab/lodestar-core`) into the Action Kernel's `PolicyGate`, gives the gate
a third outcome — **hold** — and owns the approval-request lifecycle.

Design lock: `docs/architecture/policy-kernel.md`. Read it first.

## What lives here

- `src/gate.ts` — `compile(policy, options) → CompiledPolicy`. A `CompiledPolicy`
  is `{ gate, evaluate }`: `gate` is the `PolicyGate` the Action Kernel calls;
  `evaluate(action)` is the pure, richer verdict the host re-runs on a hold to
  learn the matched rule's `required_authority`. Inside: the **trust-ladder
  floor** (applied before any rule), the ordered **first-decisive** rule list
  over a **structural deny default**, and policy **signature verification** at
  compile time.
- `src/approval.ts` — the approval lifecycle: `openApprovalRequest()` builds the
  `ApprovalRequest` for a held action (mapping the action's `data_sensitivity`
  into the 4-value clearance via the Action Kernel's `sensitivityForContract`);
  `authorizeResolution()` matches a resolver's `Actor` against the request's
  `required_authority` and produces the `ApprovalOutcome` the Action Kernel's
  `resolve()` applies; `expireRequest()` produces the deadline-passed outcome.
- `src/presets.ts` — `autoApprovePolicy` / `autoApprovePolicyDocument`, the
  graduated "ceiling" constructor. It is the one-rule policy
  `[{ match: { required_level_lte: N }, effect: allow }]` over the deny default.
  **Its ceiling caps at L3** — auto-approving L4 is not expressible, by design
  (the ladder floor always holds L4).
- `src/hash.ts` — the canonical hash used for the policy signature's
  `payload_hash` (deterministic JSON over `{ id, version, rules }`).
- `src/index.ts` — public exports.

## Invariants

1. **The trust-ladder floor is non-overridable and runs before the rules.**
   `required_level === 5 → deny`; `required_level === 4 → hold` (require
   approval). No rule can lift the floor — a broad earlier `allow` (e.g.
   `git.* → allow`) still yields a hold for an L4 action. This is why
   `autoApprovePolicy` caps at L3.
2. **The deny default is structural, not a field.** Rules are evaluated in
   document order; the first whose `match` holds is decisive. An action matching
   no rule is denied. There is no `default: allow`, no silent allow.
3. **An active policy must be signed.** `compile()` rejects an unsigned or
   tampered policy (signature absent, or `signature.payload_hash` ≠ the
   recomputed canonical hash, or an injected `verifySignature` returns false),
   *unless* the caller passes an explicit, logged `allow_unsigned: true`
   development opt-in. Security-relevant → no silent default.
4. **The kernel decides; the Action Kernel applies.** `authorizeResolution()`
   decides whether a resolver may grant/deny (the `required_authority` match);
   the resulting `ApprovalOutcome` is handed to `ActionKernel.resolve()`, which
   performs the phase transition. This package never performs a phase
   transition itself and never imports the Action Kernel's runtime state.
5. **`hold` is surfaced through the existing seam.** A held verdict becomes
   `{ approved: false, requires_human_approval: true, reason }` — the
   forward-planned `PolicyDecision` field the Action Kernel already carries.
   No new `PolicyGate` type; the package ships an implementation of it.
6. **Wire formats stay in core.** `Policy`, `PolicyRule`, `ApprovalRequest`, the
   `approval.*` events, and the `pending_approval` phase live in
   `@qmilab/lodestar-core`. This package is behaviour only.

## What does NOT live here yet (deliberate deferrals — `policy-kernel.md`)

- **The arbitrate hook** that consumes `sentinel.alerted@1` alerts and a
  `CalibrationReport` to escalate/deny an action. Sentinels observe and the
  calibrator measures today; the hook that gives them teeth is the next slice.
  Do not add a blocking path from a sentinel here until it lands.
- **Host wiring.** The `guard.wrap()` `ApprovalResolver` seam and the MCP
  proxy's deadline / `approval_required` / `approval_timeout` hold path are host
  integrations (`@qmilab/lodestar-guard`, `@qmilab/lodestar-guard-mcp`), built
  on top of this engine in a follow-up. `autoApprovePolicy` is **not yet**
  re-exported from guard (graduating guard's preset flips L4 from reject to
  hold and must land with the host wiring + probe updates).
- **OS-level sandbox enforcement.** The Policy Kernel *decides* a
  `SandboxProfile`; a separate sandbox runtime enforces it (graduates with the
  shell adapter).

## When changing the gate

1. The floor is load-bearing. If you touch it, the `ladder-floor-overrides-allow-rule`,
   `l4-action-requires-approval`, and `unmatched-action-defaults-to-deny` probes
   are the spec — run them.
2. Keep `evaluate()` pure (no I/O, no clock) so a host can re-run it
   deterministically after `arbitrate()` parks an action.
3. New policy fields go in `@qmilab/lodestar-core` first (additive), then here.
