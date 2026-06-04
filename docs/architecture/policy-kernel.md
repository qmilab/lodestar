# Policy Kernel & Governing UI — Design Doc

The keystone of the post-v1 build track. `packages/policy-kernel/` is an empty
directory; real policy enforcement is still a stand-in inside the Action Kernel
(the `autoApprovePolicy` preset's single ceiling check). This doc is the design
lock for the package that closes that gap — and, because the approval workflow it
introduces is what a governing UI exists to drive, the read-side viewer and the
approval surface are designed here alongside it.

It builds on three decisions already made and deliberately deferred *to this
component*:
- the `arbitrate` hook that lets a `sentinel.alerted@1` gate the next dependent
  action (`docs/architecture/sentinels.md`, "What's wired, what isn't");
- acting on a calibrator-flagged miscalibrated class
  (`docs/architecture/calibrator.md`, "What's wired, what isn't");
- OS-level sandbox intent vs. enforcement, named as landing "with the Policy
  Kernel (Batch 4+)" in the MCP-proxy threat model (`v02-delta.md`).

It does not relitigate the trust ladder, the action contract, or the two-phase
execution model — those are settled in `v02-delta.md` and the action-kernel
CLAUDE.md. It specifies how a Policy Kernel *enforces* them and adds the one
thing the v0 preset cannot express: holding an action for approval.

Written 2026-06-03.

> **Status (current as of 2026-06-03).** Forward-looking — **nothing here is
> built yet.** `packages/policy-kernel/` is empty; today's enforcement is the
> `autoApprovePolicy` preset (`@qmilab/lodestar-guard/src/policy-presets.ts`): a
> single `required_level ≤ ceiling` check, no holds, no approval, no consumption
> of sentinel/calibrator signal. This doc locks the design that (a) turns policy
> into a signed, packageable document, (b) gives the gate a third outcome —
> `hold` — and a first-class approval workflow, (c) finally wires the deferred
> `arbitrate` hook so alerts and calibration flags have teeth, and (d) designs
> the governing UI. It needs **additive core-schema
> additions** (a `pending_approval` Action phase plus new `Policy` /
> `ApprovalRequest` schemas) — **ratified as decisions 2026-06-03**, with the
> schema edit itself the first implementation step, not done in this doc (see
> "Schema changes this requires"). Related locks:
> [sentinels](./sentinels.md), [calibrator](./calibrator.md); reader-facing
> overview: [reference/architecture.md](../reference/architecture.md).

---

## Mental model

The **Policy Kernel decides whether a proposed action is allowed, denied, or must
wait for approval.** It is the component that turns the *declared* trust ladder
(L0–L5) and the *declared* action contract (`required_level`, `blast_radius`,
`reversibility`, `scope`, `data_sensitivity`) into an *enforced* decision, and it
is the home for the three governance signals that until now had nowhere to act:
human approval, sentinel alerts, and calibration flags.

It is **not**:
- **Not the Action Kernel.** The Action Kernel owns the *mechanics* —
  `propose → arbitrate → execute`, input/output validation, TOCTOU precondition
  revalidation. It already delegates the *verdict* to a `PolicyGate` function and
  does not care who implements it. The Policy Kernel is that implementation.
- **Not a sandbox runtime.** It *decides* which `SandboxProfile` an action runs
  under; it does not *enforce* that profile at the OS level. Enforcement
  (namespaces, cgroups, a real `controlled-shell`) is a separate sandbox runtime
  that graduates with the shell adapter. See "Sandbox: decision vs. enforcement".
- **Not the `ContextPolicy`.** `ContextPolicy` (`packages/core/src/schemas/belief.ts`)
  already exists and governs *what beliefs may enter model context*. The `Policy`
  here governs *what actions may touch the world*. Two different gates on two
  different chain links; the name collision is unfortunate but the scopes never
  overlap. Where ambiguity is possible this doc writes **action policy**.
- **Not the UI.** The UI renders the chain and lets a human resolve a pending
  approval; the Policy Kernel produces the pending approval and consumes the
  resolution.

## The seam that already exists

The Action Kernel calls policy through one function, once, at arbitrate time
(`packages/action-kernel/src/kernel.ts:19`):

```typescript
export type PolicyGate = (action: Action) => Promise<PolicyDecision>

export interface PolicyDecision {
  approved: boolean
  reason: string
  approver_id: string
  requires_human_approval?: boolean   // ← forward-planned; nothing reads it yet
}
```

`arbitrate()` today maps the verdict to exactly two phases
(`kernel.ts:191-211`):

```typescript
const decision = await this.policyGate(inArbitration)
return { ...inArbitration, phase: decision.approved ? "approved" : "rejected", ... }
```

Two things matter here. First, `requires_human_approval` was added to the
interface ahead of need — the seam already anticipates a third state; nothing
honours it yet. Second, the Action Kernel is the *right* place for the gate to
stay a function: the kernel must not depend on the Policy Kernel (that would
invert the layering). So the Policy Kernel does not replace the `PolicyGate`
type — **it ships a real implementation of it**, plus the lifecycle machinery the
function alone cannot hold (approval records, alert/calibration indices). Hosts
swap `autoApprovePolicy(...)` for `policyKernel.gate()` and the Action Kernel
gains two small additive transitions — parking a held action and un-parking a
resolved one (both below).

## Action policy as a signed, packageable document

Today policy is *only* a function — opaque, unversioned, unsignable. That is
fine for a getting-started preset and wrong for everything the architecture
already assumes:

- `Decision` records `policy_dependencies: string[]` — "policy versions
  consulted" (`packages/core/src/schemas/decision.ts`). For that to be auditable,
  a policy version must be a first-class, addressable, hashable artifact.
- `v02-delta.md` §5 lists **policy versions** among the things that *require*
  Ed25519 signatures. A function cannot be signed; a document can.
- **Policy packs** ship as portable artifacts (`v02-delta.md`), not compiled
  closures.

So the Policy Kernel introduces a declarative `Policy` document in
`@qmilab/lodestar-core`, and the kernel *compiles* a `Policy` into a `PolicyGate`.
The function seam stays; the policy behind it becomes data.

```
Policy {
  id                    // stable policy id
  version               // monotonic; this is what Decision.policy_dependencies cites
  rules: PolicyRule[]   // evaluated in order; first decisive rule wins
  signature             // Ed25519 over the canonical document; required for an
                        //   active policy (see "Draft vs. active" below)
  signed_by             // actor_id of the signer
}
```

There is deliberately no `default` field: an action matching no rule is denied,
structurally (see the deny default below). There is no expressible `default:
allow`.

A `PolicyRule` is a match → effect:

```
PolicyRule {
  match {                         // all present fields must hold (AND)
    tool?            // glob, e.g. "git.*"
    max_blast_radius?            // "self" | "session" | "project" | "external"
    reversibility?               // subset of reversible | compensable | irreversible
    scope?                       // ResourceScope constraint
    data_sensitivity?            // public | private | secret
    required_level_lte?          // contract level at or below this
  }
  effect: "allow" | "deny" | "require_approval"
  approval?: ApprovalRequirement  // present iff effect = require_approval
  reason: string                  // surfaced verbatim in the PolicyDecision
}
```

`autoApprovePolicy({ auto_approve_up_to: N })` is then the one-rule policy
`[{ match: { required_level_lte: N }, effect: allow }]` over the structural deny
default. The preset does not disappear — it graduates into the Policy Kernel as
the canonical "ceiling" constructor, so getting-started stays one line while the
underlying object is now inspectable and signable. **Its ceiling now caps at L3**
(`N` in `0..3`), not L4 — see the ladder floor immediately below.

**The trust-ladder floor is a non-overridable pre-check, applied before any
rule.** The ladder (`v02-delta.md`) is explicit: **L4 (external/shared — network,
credentials, deploy, push) always requires approval; L5 is prohibited.** Were
that merely a rule in the list, a broad earlier `allow` (say `git.* → allow`)
would auto-approve an L4 push and silently skip the entire approval workflow. So
the kernel applies the floor *first*, structurally, and no rule can lift it:

```
ladder floor:
  required_level == 5  → deny             (always; prohibited)
  required_level == 4  → require_approval is a LOWER BOUND, not a fixed verdict
  required_level <= 3  → the rule list decides, over a structural deny default
```

**The L4 floor is a lower bound, not a fixed verdict** (implementation note,
clarified after a review caught the subtlety). "No rule can *lift* it" means a
rule may make an L4 action *more* restrictive but never less. So the rule list
is still consulted for L4, and the floor only blocks a downgrade to `allow`:

- a matching `deny` rule → **deny** (stricter than the floor; honoured — the
  floor must not soften an explicit deny into an approvable hold);
- a matching `require_approval` rule → **hold**, with the rule's stricter
  `required_authority` *preserved* into the opened `ApprovalRequest` (so a
  policy demanding a senior approver is not silently downgraded to the floor's
  empty authority);
- a matching `allow` rule → **hold** (the floor lifts `allow` → require
  approval; `allow` is impotent at L4);
- no matching rule → **hold** (the floor's baseline — L4 is the
  human-in-the-loop tier, so it does *not* fall to the structural deny default
  the way L0–L3 do).

A naïve "L4 → hold, ignore the rules" floor would under-enforce: it silently
drops a stricter rule's `deny` or `required_authority`. The floor strengthens,
never weakens.

This is why `autoApprovePolicy`'s ceiling tops out at L3 — auto-approving L4 is
not expressible, by design. Today's preset accepts a ceiling of 4 and
auto-approves L4; the Policy Kernel deliberately **tightens** this to honour the
ladder (the runtime L5-reject the preset already carries graduates into the
floor's L5 line).

**Why ordered, first-decisive rules over a structural deny default.** The
architecture's through-line is "refuse unless explicitly approved" (the proxy
threat model's words). An unordered rule set forces a conflict-resolution policy;
an ordered list read top-to-bottom over a deny default makes the safe outcome
*structural* — not a rule someone can forget to add — and keeps a policy readable
in one pass. The default is not a tunable field; there is no silent allow,
mirroring "no silent defaults for security-relevant settings" (root CLAUDE.md).

**Draft vs. active: signatures are required at the gate.** `v02-delta.md` §5
requires Ed25519 signatures on policy versions, and the
`policy-version-signature-required` probe enforces it — so `signature` /
`signed_by` are *not* optional on a policy the gate evaluates. The kernel rejects
an unsigned or invalid-signature policy at load. Unsigned **drafts** are an
authoring convenience only, usable solely under an explicit, logged
`allow_unsigned: true` development opt-in (security-relevant → no silent
default), never the production path. An active version is signed and
content-hashed, and that hash is what `Decision.policy_dependencies` cites.

## The three-valued gate: allow / deny / hold

The v0 preset is binary: allow or deny. An L4 action — push, deploy, spend,
publish — is neither. It should not auto-approve (that is the whole point of L4)
and it should not flatly reject (a human might say yes). It must **wait**. So the
gate gains a third outcome:

```
PolicyVerdict = "allow" | "deny" | "hold"
```

`hold` is surfaced through the seam that already exists:
`{ approved: false, requires_human_approval: true, reason }`. The Action Kernel
learns one new branch in `arbitrate()` (parking), plus a second transition that
*un-parks* a resolved action (specified under the approval workflow):

```
approved              → phase "approved"
!approved & !requires → phase "rejected"
!approved &  requires → phase "pending_approval"   // ← new
```

A `pending_approval` action has *not* been rejected and has *not* been approved.
It is parked, an `ApprovalRequest` is opened, and the world is untouched (the
two-phase discipline guarantees `execute()` cannot run from `pending_approval`,
exactly as it cannot run from `proposed`).

### How a hold resolves in each host

Holding means something different for an in-process loop than for an external
agent over MCP. Both are designed; both are honest about their limits.

- **`guard.wrap()` (in-process loop).** The agent loop is suspendable JS, so a
  hold can *await*. The host injects an `ApprovalResolver` — the same pattern as
  the existing required `precondition_checker` on `GuardConfig`:

  ```
  ApprovalResolver = (req: ApprovalRequest) => Promise<ApprovalOutcome>
  ```

  The resolver is where a human (via the approval UI), an auto-rule, or a test
  stub answers. No new schema; a new required config field, security-relevant, so
  **no silent default** — a config that can produce holds must say who resolves
  them, or construction fails.

- **MCP proxy (external agent).** A `tools/call` is request/response; the proxy
  cannot hold one open indefinitely without tripping client timeouts. So a held
  action carries a **deadline** (`approval_timeout`, configured like
  `auto_approve_ceiling`). The proxy waits up to the deadline for an out-of-band
  resolution (the approval UI writing an `approval.granted@1` event); if none
  arrives it returns the same synthetic-result shape the proxy already uses for
  denials — `isError: true`, `_meta._lodestar.kind = "approval_required"` (or
  `"approval_timeout"`) — so the wrapped agent reads it as a normal tool result
  and re-plans, never as a transport error. This reuses the proxy's existing
  `buildPolicyDeniedResult` machinery (`packages/guard-mcp/src/policy-result.ts`)
  with a new `kind`; it does not invent a resume protocol. **Deferred,
  explicitly:** durable resume — re-issuing the *same* approved call after a
  timeout. v0 treats a timed-out hold as a soft denial the agent must re-propose.

## The approval workflow

`ApprovalRequest` is the first-class record of a parked action. It lives in
`@qmilab/lodestar-core` (wire format only; no behaviour — core invariant #1):

```
approval.requested@1 {
  request_id
  action_id            // the parked action
  reason               // the rule's reason, verbatim
  required_authority {            // who is allowed to resolve it
    min_trust_baseline?           // an approver's Actor.trust_baseline floor
    sensitivity_clearance?        // must clear the action's sensitivity (mapped; see note)
    scope?                        // ResourceScope the approver must hold
  }
  requested_at
  deadline?            // ISO 8601; the proxy's hold timeout, absent in-process
}

approval.granted@1  { request_id, action_id, approver_id, reason?, at }
approval.denied@1   { request_id, action_id, approver_id, reason?,  at }
approval.expired@1  { request_id, action_id, at }   // deadline passed, no human
```

Design notes, in the discipline the sentinel/reflection wire formats already
hold:
- **Grant and deny are distinct event types, not one event with an `approved`
  flag.** `approval.granted@1` / `approval.denied@1` carry no `approved` boolean —
  the type *is* the verdict, so a redundant flag (which could disagree with the
  type on re-read) is omitted. When the resolution folds back into the action via
  `resolve()`, it is recorded in the action's existing `approval` field
  (`ApprovalEvent`: `approver_id`, `approved`, `reason?`, `at` — `action.ts:79`),
  where a single boolean is the natural shape. So the standalone stream view
  (type-discriminated) and the single-action view (`ApprovalEvent`) agree without
  duplicating the verdict on the wire.
- **`required_authority` is data, not a callback.** It says *what* an approver
  must be (trust baseline, clearance, scope), checked against the resolver's
  `Actor`. This is what lets the team approval surface route a request to
  the right person without the Policy Kernel knowing anything about people.
- **The clearance check spans two alphabets and must map between them.** An
  action's `data_sensitivity` is the 3-value `public | private | secret`; an
  `Actor.sensitivity_clearance` is the 4-value `public | internal | confidential |
  secret`. The request carries the action's sensitivity *mapped into the 4-value
  `Sensitivity`* via the Action Kernel's existing `sensitivityForContract`
  (`kernel.ts:345` — `public→public`, `private→internal`, `secret→secret`), and
  the approver must clear it on the ordering `public < internal < confidential <
  secret`. Reusing that one mapping keeps the action-side and approver-side
  alphabets reconciled in a single place rather than inventing a second
  comparison.
- **No optional payload field is ever `undefined`** — omitted entirely when
  unset, never set to `undefined`, so the event-log writer's `canonicalHash`
  (undefined → null) and `JSON.stringify` (drops the key) cannot disagree on
  re-read. Same rule the sentinel and firewall-audit payloads hold. `deadline`
  and `reason?` are omitted in-process, not nulled.

The lifecycle, end to end:

```
propose → arbitrate ─(hold)→ pending_approval ─┬─ approval.granted → approved → execute
                                               ├─ approval.denied  → rejected
                                               └─ approval.expired → rejected
```

**Un-parking is an explicit Action-Kernel transition, not a side effect.**
`arbitrate()` parks a held action at `pending_approval`; a resolution does not
reach back into it implicitly. The Action Kernel gains one new method —
`resolve(action, outcome): Action` — that transitions `pending_approval →
approved` (on `approval.granted`) or `→ rejected` (on `approval.denied` /
`approval.expired`), recording the `ApprovalEvent` and audit entry exactly as
`arbitrate()` does. The split of duty mirrors arbitration: the **Policy Kernel
decides** the outcome (it matches the resolution against `required_authority`),
the **Action Kernel applies** it (the phase transition), so the kernel still
never imports the Policy Kernel. A granted action then enters `execute()` through
the normal `approved` gate — which is why TOCTOU revalidation still fires. So the
Action-Kernel change is *two* additive transitions, park and un-park, not one.

An approval that **grants** does not skip the TOCTOU defense: the un-parked
action still re-validates `must_revalidate_at_execution` preconditions at
`execute()` time. A human approving "push to main" at T0 does not authorise a
push against a different HEAD at T1 — the precondition check the Action Kernel
already enforces still fires. Approval authorises *intent*, not a stale world.

### Schema changes this requires (ratified 2026-06-03)

The architecture is locked at v0.2 + Round 5; `packages/core/` schema changes
need explicit sign-off (root CLAUDE.md, locked decisions). The following were
ratified in the design session on 2026-06-03. All are *additive*; none changes
an existing field's meaning. **The ratification is of the decisions, not yet the
code:** the edits to `packages/core/` and the matching record in the v0.2 delta
are the first implementation step of the Policy Kernel, not part of this design
PR — until they land, the authoritative `ActionPhaseSchema` still shows the
eight-value enum.

1. **`pending_approval` added to `ActionPhaseSchema`.** The enum today is
   `proposed | arbitrating | approved | rejected | executing | completed |
   failed | halted` (`action.ts:64`). `halted` is a *terminal* mid-execution
   stop (`executing → completed/failed/halted`), so it cannot represent
   "waiting" — a distinct value is required. **Decision: add it (ratified
   2026-06-03).** The
   alternative — leaving a held action in `arbitrating` limbo — breaks
   `arbitrate()`'s contract that it returns a resolved phase, and makes every
   reader special-case "arbitrating but actually waiting". An additive enum value
   is the cleaner touch; existing logs without it still parse, and consumers
   (trace projection, the proxy) gain one case.
2. **`Policy`, `PolicyRule`, `ApprovalRequest` schemas + the four `approval.*`
   event types**, all new files under `packages/core/src/schemas/`. Pure
   additions; nothing depends on them until the Policy Kernel ships.
3. **A `schema_version` bump + migration note**, per core CLAUDE.md invariant #4
   ("Backwards-compatible additions only after v0.2 … every schema change ships
   with a `schema_version` bump and a migration note"). The migration is a no-op
   for existing logs (additive), but the note is the discipline.

## The arbitrate hook: giving alerts and calibration teeth

This is the piece `sentinels.md` and `calibrator.md` both deferred *to here*. The
critical invariant it must preserve: **sentinels still do not block, and the
calibrator still does not enforce.** A sentinel emits `sentinel.alerted@1` and
stops; the calibrator returns a `CalibrationReport` and stops. The *Policy
Kernel* is what reads those signals and decides. The observe/measure-only
boundary the harness guards stays exactly where it is — the alert is evidence,
the policy decision is enforcement.

When the gate arbitrates an action, in addition to the contract/rule evaluation
above, it consults two read-only indices the host wires in:

1. **Recent alerts, scoped to the action's beliefs.** Resolve the action's
   backing beliefs via `action.decision_id → decision.belief_dependencies`, then
   query `sentinel.alerted@1` events whose `subject` names one of those beliefs
   (or names the action / a matching `tool_sequence`). This is *why*
   `suspicious-memory-origin` emits one alert **per offending belief** and why
   `subject.kind: "belief"` was called "load-bearing" in `sentinels.md` — the
   hook scopes alerts to `belief_dependencies`, exactly as that doc anticipated.
   A matching alert at or above a policy-configured severity escalates the
   effect: `allow → require_approval`, or `→ deny` for `critical`.

2. **Calibration flags, scoped to the action's belief classes.** If a backing
   belief's `calibration_class` is in the latest `CalibrationReport.flagged_classes`
   (a class the calibrator found miscalibrated under its `min_samples` guard),
   the gate downweights: escalate a high-trust action to `require_approval`. This
   is the "downweighting an overconfident class" `calibrator.md` named as the
   Policy Kernel's job. **How the report reaches the gate is a prerequisite
   interface, not an afterthought.** The calibrator is return-value-only and
   harness-local today, with `calibration.computed@1` deliberately deferred *to
   this consumer* (`calibrator.md`). v0 wires it host-side: the host runs
   `calibrate()` over the session/project log and hands the gate the resulting
   `CalibrationReport` as a read-only, snapshot-in-time object (the same injection
   shape as the alert index above), scoped to the action's `project_id`. Two
   honesty caveats — the snapshot is only as fresh as the host's last `calibrate()`
   run (not live), and a class needs `≥ min_samples` before it can flag, so early
   in a session calibration gating is simply inactive. A durable
   `calibration.computed@1` event is the deferred upgrade.

**Honest about ordering.** Alerts arrive on the sentinel runner's async tail, so
the hook reads alerts that *have already landed* — it does not synchronously run
sentinels during arbitration. In the normal chain this is fine: a
`suspicious-memory-origin` alert fires on `decision.made`, which precedes
`action.proposed`, so the alert exists before the action is arbitrated. But the
tail latency is non-zero (`sentinels.md`), so a not-yet-landed alert does not
gate its action — the gate fails *open on that one signal* while the action's own
contract rules (ceiling, blast radius, approval requirements) still apply. A
*synchronous* pre-flight sentinel pass over the candidate action's dependencies
would close this race; it is a deliberate **deferred refinement**, kept out of v0
to preserve the "sentinels are an async tail, not an inline blocker" model.

**Which subjects can gate, and which are audit-only.** The race bites differently
per sentinel, so the design is explicit about each:
- `suspicious-memory-origin` names a **belief** and fires on `decision.made`,
  which precedes `action.proposed` — its alert reliably exists before the
  dependent action is arbitrated, so it gates.
- `anomalous-tool-sequence` names a **tool_sequence** ending at a *completed*
  action — it gates *subsequent* actions, which is exactly its intent.
- `low-confidence-action` names the **action itself** and fires on
  `action.proposed` / `action.approved` — it cannot reliably gate the action it
  names (same-event race). So the gate does **not** wait on that alert: it applies
  the low-confidence condition *directly and synchronously* from the action's
  `belief_dependencies` (a backing belief at `confidence < floor` or
  `truth_status: unverified`), which it already holds at arbitration. The
  sentinel's action-subject alert stays the audit tripwire; *enforcement* of the
  same condition is a synchronous belief check, not a wait on the alert. This is
  the same division everywhere: sentinels observe, the Policy Kernel enforces.

## Sandbox: decision vs. enforcement

The proxy threat model names OS-level sandbox enforcement as landing "with the
Policy Kernel". To be precise about what that means and avoid over-claiming:

- **The Policy Kernel decides the sandbox.** A rule can constrain or override the
  `SandboxProfile` an action runs under (deny if a tool requests
  `controlled-shell` outside an allowed scope; force `read` for an untrusted
  downstream). The *decision* is policy and lands here.
- **OS-level enforcement is a separate runtime.** Namespaces/cgroups/containers,
  `--network none`, scoped bind mounts, no host env passthrough (`v02-delta.md`
  §6) are enforced by a sandbox runtime, not by a policy verdict. That runtime
  graduates with the **shell adapter** (`examples/.../dev-tools-mcp/CLAUDE.md`
  documents the graduation path; the demo's shell deliberately has *no* sandbox).
  Until it lands, the Policy Kernel's `SandboxProfile` decision is *intent* the
  way it is today — now centralised and auditable, but operators still confine
  downstream servers themselves (the proxy's operator guidance stands).

Keeping the two separate is the honest framing: the Policy Kernel makes sandbox
choice a governed, logged decision; it does not by itself make the box real.

## What lives where

- **`@qmilab/lodestar-core`** — wire formats only: `Policy`, `PolicyRule`,
  `ApprovalRequest`, the `approval.*` events, the additive `pending_approval`
  phase. No behaviour.
- **`@qmilab/lodestar-policy-kernel`** (the empty dir, filled) — the engine:
  `compile(policy) → PolicyGate`; the `ApprovalRequest` lifecycle manager; the
  arbitrate hook (alert + calibration consumption); signature verification of
  policy documents; the `autoApprovePolicy` constructor (graduated from guard,
  re-exported there for source compatibility).
- **`@qmilab/lodestar-action-kernel`** — two additive transitions: `arbitrate()`
  parks a held action at `pending_approval`, and a new `resolve()` un-parks it to
  `approved` / `rejected`. Nothing else moves; the kernel still does not import
  the Policy Kernel.
- **`@qmilab/lodestar-guard`** — `GuardConfig` gains the required `approval_resolver`
  seam (when the policy can hold); `policy_gate` may now be a compiled Policy.
- **`@qmilab/lodestar-guard-mcp`** — the hold path: deadline config, the
  `approval_required` / `approval_timeout` synthetic results, out-of-band
  resolution via an `approval.granted@1` write.
- **`@qmilab/lodestar-harness`** — unchanged. Sentinels observe; the calibrator
  measures. The Policy Kernel *reads* their outputs; the boundary does not move.
- **`@qmilab/lodestar-trace`** — gains projection + render for the new events and
  the `pending_approval` phase (read-only, tolerant projection, as always).

## What ships here, and what's a separate team surface

The split is technical, not a sales line: the format and the solo-developer
workflow run entirely in this repo; the team-scale surface is a larger, separate
piece that could be built later.

- **In this repo (Apache 2.0):** the `Policy`/`PolicyRule`/`ApprovalRequest`
  schemas, the engine, signature verification, the in-process `ApprovalResolver`
  seam **and a minimal reference resolver** — a `lodestar approve`-style CLI that
  lists pending `approval.requested@1` events and writes `approval.granted@1` /
  `approval.denied@1` — plus `autoApprovePolicy`, the arbitrate hook, and the
  read-side viewer (below). The reference resolver is the load-bearing guarantee
  that **the solo workflow is never gated**: a single developer can author a
  policy, hit a held L4, approve it from their own terminal, and see the whole
  chain — free, local, no account. Without it a team UI would be the *only* way to
  resolve a hold, every held L4 would time out to a denial, and the solo path
  would be gated.
- **A separate team surface (if built, lives elsewhere):** multi-approver
  workflows, team routing of `required_authority` to real people, a hosted
  approval surface, audit/compliance exports of the approval trail, and
  curated/managed policy packs. None of it gates the local workflow.

## Governing UI

Two layers — the read side ships here and is built first; the write side
(resolving approvals across a team) is a larger separate surface that depends on
the Policy Kernel.

### (a) Read-side trust-report viewer — ships here, build first

A local web UI over the NDJSON event log that renders the same projection
`lodestar report` already produces. It does **not** depend on the Policy Kernel
and can ship before it.

- **Reuse, don't reinvent.** It is the trace package's `projectChain()` +
  `renderReport()` (`packages/trace/src/`) behind HTTP instead of stdout —
  read-only, tolerant projection (trace invariants #1–#3 carry over unchanged).
  The viewer adds what a static report can't: a **live tail** (subscribe to the
  log's appends), filtering by session/actor/event-type, and drill-down from an
  action back through its decision → beliefs → claims → observations.
- **Stack:** Elysia (stack invariant: "Elysia where HTTP is needed") serving a
  small SPA. Local and free; no account, no network egress. It reads the log; it
  never writes.
- **It can show pending approvals read-only** — "here is what is waiting, and
  why" — surfacing `approval.requested@1` events without offering a button.
  Showing the queue is read-side; *resolving* it is the write-side surface below.
  That keeps the seam at the natural place: observing is local; acting on it
  across a team is the larger surface.

### (b) Approval surface — team-scale, depends on the Policy Kernel

The interactive write side: a human (or team) sees the pending `ApprovalRequest`
queue, with the full epistemic chain behind each one (this is *the* payoff of the
whole architecture — an approver sees what the agent observed, claimed, believed,
and why it decided, not just "approve y/n"), and resolves it.

- Resolving writes an `approval.granted@1` / `approval.denied@1` event, which is
  exactly the out-of-band signal the in-process `ApprovalResolver` awaits and the
  proxy's hold loop polls. The UI is one concrete implementation of
  `ApprovalResolver`; the local `lodestar approve` CLI is another, a CI
  auto-rule a third. What the team surface adds over the CLI is *team* —
  routing, multi-approver, the queue view — not the ability to approve at all.
- `required_authority` on the request is what routes it: the surface shows a
  request only to an approver whose `Actor` clears its trust baseline, sensitivity
  clearance, and scope. Multi-approver (N-of-M) and team views live here.
- This is the surface that closes the loop the whole project points at:
  `lodestar guard mcp-proxy && claude code` proposes an L4 push → the Policy
  Kernel holds it → the approver sees the chain and approves → the action
  un-parks and executes → `lodestar report` shows the approval in the audit
  trail.

## Probes (the spec to implement against)

Per the repo's discipline (CLAUDE.md "add a probe that exercises the new
behaviour under adversarial conditions"), the Policy Kernel ships with probes
that pin its invariants. These are the spec, written before/with the code, added
to `packs/lodestar-core/` or `packs/coding-agent-safety/` and declared in the
manifest:

- **`l4-action-requires-approval`** — an action at `required_level: 4` can never
  auto-approve: the ladder floor routes it to `require_approval` regardless of any
  ceiling (`autoApprovePolicy` caps at L3), and without an `approval.granted` it
  never executes.
- **`pending-approval-cannot-execute`** — an action parked at `pending_approval`
  cannot be driven to `execute()`; only `approval.granted` un-parks it. Asserts
  the two-phase discipline holds for the new state.
- **`sentinel-alert-gates-dependent-action`** — the hook `sentinels.md`
  anticipated: a `suspicious-memory-origin` alert on belief B causes the Policy
  Kernel to escalate/deny the next action whose `belief_dependencies` include B —
  while the sentinel itself still only emitted an alert. Pins that enforcement
  lives in policy, not in the sentinel.
- **`calibration-flag-escalates-action`** — an action backed by a belief in a
  `flagged_classes` class is escalated to `require_approval`, while the
  calibrator only measured.
- **`approval-timeout-denies`** (proxy) — a held action whose deadline passes is
  denied (synthetic `approval_timeout`) and never executes; no resume.
- **`granted-approval-still-revalidates-preconditions`** — a granted L4 action
  whose `must_revalidate_at_execution` precondition no longer holds is still
  rejected at execute time. Approval authorises intent, not a stale world.
- **`policy-version-signature-required`** — a `Policy` whose signature is missing
  or invalid is rejected by the kernel (`v02-delta.md` §5).
- **`ladder-floor-overrides-allow-rule`** — a policy whose first rule would
  `allow` an L4 action (e.g. `{ match: { tool: "git.*" }, effect: allow }`) still
  yields `require_approval`: the structural floor runs before the rule list and no
  rule can lift it.
- **`unmatched-action-defaults-to-deny`** — an action matching no rule hits the
  structural deny default; no silent allow.

## What this unblocks / what stays deferred

- **Unblocks:** the sentinels' `arbitrate` hook (alerts gain teeth), the
  calibrator feedback loop (flags escalate), L4 human approval end-to-end, the
  approval UI, and centralised/auditable sandbox-profile *decisions*. Five
  stubs/deferrals across the codebase resolve to this one component.
- **Stays deferred (deliberately):**
  - **OS-level sandbox enforcement** — a separate runtime that graduates with the
    shell adapter (above). The Policy Kernel decides; it does not yet box.
  - **Durable MCP hold resume** — re-issuing the same approved call after a
    proxy timeout. v0 treats a timed-out hold as a soft denial to re-propose.
  - **Synchronous pre-flight sentinel pass** — closing the alert-latency race in
    the arbitrate hook; v0 reads landed alerts (eventually-consistent).
  - **Multi-approver / team routing / hosted approval surface** — a separate
    team-scale surface, out of scope here.
  - **Cross-session policy state** — a held approval surviving a process restart
    needs the persistent stores; in-scope only where the Postgres stores already
    are.

## Open questions

- **How are the alert index and calibration report injected?** Both the
  recent-alerts view and the `CalibrationReport` are read-only inputs the gate
  consults at arbitration. Options: the host passes queryable snapshots (mirrors
  how guard wires stores and how the calibrator is handed events), or the Policy
  Kernel tails the log itself. Leaning host-injected — it keeps the kernel
  I/O-free at its core and lets the one host that already runs the SentinelRunner
  and `calibrate()` own their freshness. The exact query surface (scope, freshness
  window) is a prerequisite interface, settled at implementation.
- **Who writes `Decision.policy_dependencies`?** The gate arbitrates *Actions*,
  but the policy *version* consulted must be threaded into *Decision* creation (the
  cognitive core) for the audit citation to populate. The active version is known
  at session construction, so the likely answer is "the host stamps it onto
  decisions the way it stamps session/project context" — but the exact seam (does
  the cognitive core take the active policy version, or does a post-hoc projection
  fill it?) is unsettled. Flagged so it is not discovered at implementation time.
- **`autoApprovePolicy`'s typed ceiling narrows to `0|1|2|3`.** With the ladder
  floor making L4 always-require-approval, a ceiling of 4 is no longer expressible;
  the constructor's compile-time type drops from `0|1|2|3|4` to `0|1|2|3`, and the
  runtime floor (not the type) stays the load-bearing guard, as it is for L5 today.
  Settled by the L4 decision above; the only open part is cosmetic — whether to
  keep the narrowed typed literal at all or rely solely on the runtime check.
- **Severity → effect mapping for the arbitrate hook** — fixed table
  (`critical → deny`, `warning → require_approval`) vs. policy-configurable.
  Lean configurable (it *is* policy), with the fixed table as the default rule
  set. Settle when the first real policy is written.

## What to read next

- `docs/architecture/v02-delta.md` — the locked schema, the trust ladder (§1–9),
  signing scope (§5), shell safety (§6), and the MCP-proxy threat model that
  names this component.
- `docs/architecture/sentinels.md` and `calibrator.md` — the two deferred hooks
  this kernel consumes; "What's wired, what isn't" in each points here.
- `packages/action-kernel/src/kernel.ts` — the `PolicyGate` seam, the
  `arbitrate()` mapping that gains a parking branch, and where the new `resolve()`
  un-park transition attaches.
- `packages/guard/src/policy-presets.ts` — the `autoApprovePolicy` stand-in this
  replaces and graduates.
- `packages/trace/src/` — the projection the read-side viewer reuses.
