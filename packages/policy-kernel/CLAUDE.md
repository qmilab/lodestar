# @qmilab/lodestar-policy-kernel — CLAUDE.md

The component that turns the *declared* trust ladder and action contract into
an *enforced* decision. It compiles a declarative `Policy` document
(`@qmilab/lodestar-core`) into the Action Kernel's `PolicyGate`, gives the gate
a third outcome — **hold** — and owns the approval-request lifecycle.

Design lock: `docs/architecture/policy-kernel.md`. Read it first.

## What lives here

- `src/gate.ts` — `compile(policy, options) → CompiledPolicy`. A `CompiledPolicy`
  is `{ gate, evaluate, bindingToken? }`: `gate` is the `PolicyGate` the Action Kernel calls;
  `evaluate(action, context?)` is the pure, richer verdict the host re-runs on a
  hold to learn the matched rule's `required_authority`. Inside: the **trust-ladder
  floor** (applied before any rule), the ordered **first-decisive** rule list
  over a **structural deny default**, policy **signature verification** at
  compile time, and the **arbitrate hook** — when `options.arbitration` is wired,
  the gate consults a host-injected `ArbitrationContext` (recent
  `sentinel.alerted@1` payloads, a `CalibrationSnapshot`, the action's backing
  beliefs) and lets it *strengthen* (never weaken) the contract+rule verdict.
  `bindingToken` is an opaque value `options.arbitration.bindingToken` passes
  through (the kernel never reads it) so a host can verify a `{ gate, arbiter }`
  pair was compiled together — the guard-mcp proxy rejects a mismatch.
- `src/approval.ts` — the approval lifecycle: `openApprovalRequest()` builds the
  `ApprovalRequest` for a held action (mapping the action's `data_sensitivity`
  into the 4-value clearance via the Action Kernel's `sensitivityForContract`);
  `authorizeResolution()` matches a resolver's `Actor` against the request's
  `required_authority` and produces the `ApprovalOutcome` the Action Kernel's
  `resolve()` applies; `expireRequest()` produces the deadline-passed outcome;
  `holdEvaluationForParkedAction()` reconstructs a minimal hold
  `PolicyEvaluation` from a parked action's audit, so a host that holds only the
  bare `PolicyGate` (no `evaluate()` to re-run) can still feed
  `openApprovalRequest()`.
- `src/presets.ts` — `autoApprovePolicy` / `autoApprovePolicyDocument`, the
  graduated "ceiling" constructor. It is the one-rule policy
  `[{ match: { required_level_lte: N }, effect: allow }]` over the deny default.
  **Its ceiling caps at L3** — auto-approving L4 is not expressible, by design
  (the ladder floor always holds L4).
- `src/hash.ts` — the canonical hash used for the policy signature's
  `payload_hash` (deterministic JSON over `{ id, version, rules }`). Exports
  `stableStringify` (reused by the approval-signature canonical hash).
- `src/approval-signature.ts` — signed approval **resolutions** (P3, ADR-0010).
  `canonicalApprovalResolutionHash` + **real Ed25519** `signApprovalResolution` /
  `verifyApprovalSignature` / `generateApproverKeyPair`, over the canonical
  resolution document `{ request_id, action_id, kind, approver_id, reason?, at }`.
  Unlike the policy signature (a host-injected `verifySignature` seam, placeholder
  crypto in-repo), this is **real** `node:crypto` Ed25519 — the approval
  side-channel is a genuine cross-process forgery surface, so the verification must
  have teeth. Pure compute (no I/O); the host (proxy / `lodestar approve` CLI)
  supplies the pinned keys / private key. The reject set mirrors
  `verifyPolicySignature` plus the operator-pinned-signer check that is the whole
  point. `payload_hash` alone is *not* forgery-proof (an attacker recomputes it) —
  the signature bytes are. The MCP proxy enforces it on the side-channel; the
  in-process `guard.wrap()` resolver does not (same trusted process).
- `src/index.ts` — public exports.

## Invariants

1. **The trust-ladder floor is a non-overridable lower bound.**
   `required_level === 5 → deny` (always). For `required_level === 4` the floor
   is a *lower bound*, not a fixed verdict: the rule list is still consulted,
   but the floor blocks any downgrade to `allow`. A matching `deny` rule still
   denies, a matching `require_approval` rule's stricter `required_authority` is
   *preserved*, a matching `allow` rule is lifted to a hold, and an unmatched L4
   action holds (the baseline — not the deny default). Rules may strengthen the
   floor, never weaken it. This is why `autoApprovePolicy` caps at L3. (A naïve
   "L4 → hold, ignore rules" floor under-enforces — it drops a stricter rule's
   deny / authority. See `granted`/`l4-floor-preserves-stricter-rule` probes.)
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
7. **The arbitrate hook only ever strengthens.** A sentinel alert, calibration
   flag, or low-confidence belief may lift `allow → hold` or `→ deny`; it can
   never relax a verdict (the same lower-bound discipline as the L4 floor). It is
   off unless the host wires `options.arbitration`; when off, the gate is exactly
   its pre-slice-2 self (the deny default and floor are untouched). The hook
   reads only *landed* alerts (honest about the async-tail race — a not-yet-landed
   alert fails open on that one signal while the contract rules still apply), and
   it enforces the low-confidence condition **synchronously** from the action's
   backing beliefs rather than waiting on `low-confidence-action`'s same-event
   alert. Sentinels still only observe and the calibrator still only measures —
   the kernel *reads* their outputs; the harness boundary does not move.
8. **No dependency on the harness.** The gate consults only `flagged_classes`,
   typed as a structural `CalibrationSnapshot`, so `@qmilab/lodestar-policy-kernel`
   does not import `@qmilab/lodestar-harness`. A full harness `CalibrationReport`
   is structurally assignable; the layering (calibrator → its output → kernel
   reads it) is preserved by construction. Do not add a harness import.

## What does NOT live here yet (deliberate deferrals — `policy-kernel.md`)

- **Host wiring (landed).** All three hold-resolution paths are wired on top of
  this engine: the in-process `guard.wrap()` `ApprovalResolver` seam
  (`@qmilab/lodestar-guard` — `autoApprovePolicy` re-exported here, L4 holds, L5
  denies, ceiling caps at L3); the MCP proxy's deadline / `approval_timeout`
  out-of-band hold loop (`@qmilab/lodestar-guard-mcp` — waits up to
  `approval_timeout_ms` polling for a resolution, else expires); and the
  `lodestar approve` reference CLI resolver (`@qmilab/lodestar-cli` — the
  open-core writer that keeps the solo workflow ungated). The CLI runs as a
  *separate process*, so instead of appending the log directly (its seq counters
  are process-local and would collide) it drops a resolution in the proxy's
  side-channel; the proxy — the sole writer of its log — promotes it to the
  canonical `approval.granted@1` / `approval.denied@1`. The event-log writer was
  left untouched (no cross-process locking needed). The CLI honours the resolver
  authorisation contract: it runs `authorizeResolution` (this package) against
  the request's `required_authority` before writing, refusing an under-authorised
  approver — the proxy promotes whatever it finds, so the resolver, not the
  proxy, is where authority is checked. See the guard-mcp CLAUDE.md, the
  `approval-via-side-channel` probe, and the cli `approve.test.ts`.
  Both in-process and proxy hosts can be wired with a full `CompiledPolicy`
  (not just the bare `PolicyGate`): on a hold they re-run its pure `evaluate()`
  to recover a matched `require_approval` rule's `required_authority`
  (`min_trust_baseline` / `scope`) for the opened `ApprovalRequest`. The proxy
  takes one via `MCPProxyOverrides.policyGate`, which the CLI fills from a signed
  `ProxyConfig.policy` document (`compileProxyPolicy`) — so a declarative policy's
  authority constraints reach proxy holds, not just the mapped
  `sensitivity_clearance`. See the `proxy-hold-carries-rule-authority` probe.
- **OS-level sandbox enforcement.** The Policy Kernel *decides* a
  `SandboxProfile`; a separate sandbox runtime enforces it (graduates with the
  shell adapter).

## When changing the gate

1. The floor is load-bearing. If you touch it, the `ladder-floor-overrides-allow-rule`,
   `l4-action-requires-approval`, and `unmatched-action-defaults-to-deny` probes
   are the spec — run them.
2. Keep `evaluate()` pure (no I/O, no clock) so a host can re-run it
   deterministically after `arbitrate()` parks an action. The arbitrate hook
   keeps this: the host's `resolveContext` does the I/O on the gate's async
   boundary, and `evaluate(action, context)` is pure given the snapshot.
3. The arbitrate hook is load-bearing too: `sentinel-alert-gates-dependent-action`
   and `calibration-flag-escalates-action` are its spec, and each pins that the
   sentinel/calibrator only observed — enforcement lives here. Run them if you
   touch `applyArbitration`.
4. New policy fields go in `@qmilab/lodestar-core` first (additive), then here.
