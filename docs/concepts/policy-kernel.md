---
title: "The Policy Kernel & approvals"
description: "How a declared trust rating becomes an enforced decision: the three-valued gate (allow / deny / hold), the L4 approval lifecycle, signed out-of-band approvals, and the arbitrate hook."
---

# The Policy Kernel & approvals

The [trust ladder](trust-ladder.md) *rates* an action; the **Policy Kernel** is
what turns that rating into an enforced decision. It is the component standing
between "the agent wants to push to `main`" and the push actually happening.

## A gate with three answers, not two

Most policy gates are binary — allow or deny. The Policy Kernel has **three**
answers:

| Verdict | Meaning |
| --- | --- |
| **`allow`** | the action proceeds to execution |
| **`deny`** | the action is refused; the agent gets a structured refusal it can re-plan around |
| **`hold`** | the action is parked at `pending_approval` — not run, not refused, *waiting for a human* |

The third value is the important one. An irreversible external action — a `git
push`, a deploy, a payment, a published message — usually shouldn't be silently
allowed *or* silently denied. It should **stop and wait for a person**. `hold` is
how the gate expresses "this needs a human," and it is the verdict the whole
[L4 rung](trust-ladder.md) of the ladder resolves to.

## How a decision is made

The gate is compiled from a **signed, declarative policy document**. When an
action is proposed, the kernel:

1. **Verifies the policy's signature** — an unsigned or tampered policy is
   rejected, so the rules in force are the rules the operator actually authored.
2. **Matches the action against the policy's rules** — a rule can `allow`,
   `deny`, or `require_approval` (hold), and can carry a *required authority* (a
   minimum approver trust, a scope) that travels with the hold.
3. **Applies the trust-ladder floor** — the [ladder](trust-ladder.md) rung is a
   *floor* the policy cannot weaken: an L4 action is held even if a permissive
   rule said `allow`; an L5 action is denied. The stricter of (rule, floor) wins.
4. **Defaults to deny** — an action that no rule matches is refused, not allowed.
   Silence is not permission.

## The approval lifecycle

When the gate returns `hold`, the action opens an **approval request** and parks.
Nothing about the action has run — and crucially, **a granted approval still
revalidates the action's preconditions** before it executes, so a stale grant
can't run against changed state.

A hold gets resolved one of two ways, for the two adoption shapes:

- **In-process (`guard.wrap()`).** A held action calls an injected **approval
  resolver** — a human prompt, an auto-rule, a test stub — which grants or denies.
  Same process, same trust boundary; no forgery surface.
- **Out-of-band (the MCP proxy).** The wrapped agent is opaque, so the proxy
  parks the held action and polls the event log for an out-of-band resolution (up
  to a configured `approval_timeout_ms`; a timeout is a soft denial the agent
  re-plans around). A separate process — the
  [`lodestar approve`](../reference/cli.md#approve-resolve-a-held-approval-out-of-band)
  CLI — writes that resolution.

## Signed approvals: the forgery boundary

Across a process boundary, "whoever can write the resolution can un-park the hold"
is not good enough — a held L4 is exactly what an attacker wants to release. So an
out-of-band resolution carries an **Ed25519 signature**, and the proxy verifies it
against **operator-pinned approver public keys** before promoting it. A forged,
unsigned, or tampered grant is rejected and the action stays held (then times
out). The same gate covers both the side-channel *and* the sibling event log —
same `log_root`, same write-trust domain — so a forgery can't sneak in by either
path. The proxy remains the sole event-log writer.

This is the first **real cryptographic boundary** in Lodestar; the
policy-document signature path it builds on was an injected placeholder until this
landed.

## The arbitrate hook: signals with teeth

A static policy isn't the only input to a decision. The gate exposes an
**arbitrate hook** that lets runtime signals *strengthen* a verdict — never weaken
it:

- a [sentinel](sentinels-and-calibration.md) alert (e.g. a decision steered by an
  `external_document` belief) can turn an `allow` into a `hold`;
- a [calibration](sentinels-and-calibration.md) flag (a class the agent is
  measurably overconfident in) can escalate the decision the same way.

Because the hook only ever tightens, a misfiring signal can cost you an extra
approval prompt but can never *open* an action the policy would have held.

## Honest current state

The gate, the trust-ladder floor, the approval lifecycle, signed out-of-band
approvals, and the arbitrate hook all ship today, with both resolution paths
wired. What's still ahead is the **team-approval surface** (multi-approver
workflows, roles, an approvals dashboard — the commercial write-side) and
**OS-level sandbox enforcement** (the adapter sandboxes are governance boundaries,
not containment — see [governed egress](governed-egress.md)).

## Related

- [The trust ladder](trust-ladder.md) — the risk rating the kernel enforces.
- [Governed egress & native adapters](governed-egress.md) — the L4 actions the
  hold protects.
- [Sentinels and calibration](sentinels-and-calibration.md) — the runtime signals
  the arbitrate hook consumes.
- [CLI reference](../reference/cli.md#approve-resolve-a-held-approval-out-of-band)
  — the `lodestar approve` side-channel resolver.
