# @qmilab/lodestar-policy-kernel

The **Policy Kernel** for [Lodestar](https://qmilab.com/lodestar), the trust
layer for AI agents.

It turns the *declared* trust ladder (L0–L5) and action contract into an
*enforced* decision. It compiles a declarative, signable `Policy` document into
the Action Kernel's `PolicyGate`, gives the gate a third outcome beyond
allow/deny — **hold** — and owns the approval-request lifecycle that a held
action waits on.

```
PolicyVerdict = "allow" | "deny" | "hold"
```

- **allow** — the action proceeds to execution.
- **deny** — the action is rejected.
- **hold** — the action is parked at `pending_approval`; an `ApprovalRequest`
  is opened and the world stays untouched until a human (or auto-rule) resolves
  it. An L4 action — push, deploy, spend, publish — is *always* a hold.

## Quick start

```ts
import { compile, autoApprovePolicy } from "@qmilab/lodestar-policy-kernel"
import { ActionKernel } from "@qmilab/lodestar-action-kernel"

// One-line getting-started policy: auto-approve up to L3, hold L4, deny L5.
const gate = autoApprovePolicy({ auto_approve_up_to: 3, approver_id: "policy" })

const kernel = new ActionKernel(gate, checker, sink, { session_id, project_id })
```

Or compile a full declarative policy:

```ts
import { compile } from "@qmilab/lodestar-policy-kernel"

const { gate, evaluate } = compile(signedPolicy, { decider_id: "policy@v3" })
// gate: PolicyGate for the Action Kernel
// evaluate(action): the pure verdict, including a held action's required_authority
```

## Design

How a hold resolves, the trust-ladder floor, the signed-policy document model,
and the approval workflow are specified in the design lock:
[`docs/architecture/policy-kernel.md`](https://github.com/qmilab/lodestar/blob/main/docs/architecture/policy-kernel.md).

Wire formats (`Policy`, `PolicyRule`, `ApprovalRequest`, the `approval.*`
events, the `pending_approval` phase) live in `@qmilab/lodestar-core`. This
package is behaviour only; the Action Kernel applies the phase transitions.

## Status

The three-valued gate, the ladder floor, the structural deny default, signature
verification, and the in-process approval lifecycle ship here. The arbitrate
hook (consuming sentinel alerts and calibration flags) and host wiring (the
`guard.wrap()` resolver seam, the MCP proxy hold path) build on this engine in
follow-up releases. See the design doc for the deferral list.

## License

Apache-2.0
