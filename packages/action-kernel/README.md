# @qmilab/lodestar-action-kernel

Tool registry, two-phase action execution, and sandbox profiles for
the Lodestar epistemic chain. Part of
[Lodestar](https://qmilab.com/lodestar) — the trust layer for AI agents.

The Action Kernel is the runtime gate every tool call passes through.
It separates *describing* an intended action from *executing* it, so a
policy gate or precondition checker can refuse the action before it
touches the world.

## Install

```sh
npm install @qmilab/lodestar-action-kernel
# or
bun add @qmilab/lodestar-action-kernel
```

## What it does

- **Tool registry** — `registerTool()` declares a tool's name, inputs
  schema, output schema key, declared effects, reversibility,
  permissions, required trust level, sandbox profile, optional
  preconditions, and an `execute()` function. Lookups go through
  `lookupTool()`; nothing bypasses the registry.
- **Two-phase execution** — `kernel.propose()` builds a proposed
  `Action` from inputs + `ActionContract`. `kernel.arbitrate()` calls
  the policy gate to approve or reject. `kernel.execute()` re-checks
  preconditions (TOCTOU defense), invokes the tool, validates the
  output against the registered schema, and emits an Observation.
- **Sandbox profiles** — four levels: `"read"`, `"write-isolated"`,
  `"write-local"`, `"controlled-shell"`. Declared per tool; no silent
  defaults.
- **Observations via the schema registry** — every executed tool
  emits an Observation validated against the output schema registered
  in `@qmilab/lodestar-core`.

## Usage

```ts
import {
  ActionKernel,
  registerTool,
  type PolicyGate,
  type PreconditionChecker,
} from "@qmilab/lodestar-action-kernel"
import type { Action, Observation } from "@qmilab/lodestar-core"

registerTool({
  name: "my.tool",
  inputs: MyInputSchema,                  // Zod schema
  output_schema_key: "my.tool@1",         // registered in @qmilab/lodestar-core
  effects: [],                            // read-only tool
  reversibility: "reversible",
  permissions: ["fs.read"],
  required_trust_level: 0,
  sandbox: "read",
  execute: async (inputs, ctx) => { /* ... */ },
})

const policyGate: PolicyGate = async (action) => ({
  approved: action.contract.effects.length === 0,
  reason: "read-only actions are approved by default",
  approver_id: "demo-policy",
})

const preconditionChecker: PreconditionChecker = async (_check) => ({
  holds: true,
  observed: null,
})

const observationSink = async (obs: Observation) => {
  // route obs into the cognitive core / event log
}

const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink)

const action = kernel.propose({
  intent: "inspect repository state",
  tool: "my.tool",
  inputs: { /* ... */ },
  contract: {
    required_level: 0,
    blast_radius: "self",
    reversibility: "reversible",
    scope: { level: "project", identifier: "my-project" },
    data_sensitivity: "internal",
    preconditions: [],
  },
  proposed_by: "agent-1",
})

const arbitrated = await kernel.arbitrate(action)
if (arbitrated.phase === "approved") {
  const executed = await kernel.execute(arbitrated)
  // executed.phase === "completed" or "failed" or "rejected"
}
```

## Invariants

1. **No tool runs without a contract.** `propose()` is mandatory and
   validates inputs against the tool's Zod schema exactly once.
2. **Two-phase execution is enforced by phase.** `arbitrate()` only
   runs from `proposed`; `execute()` only runs from `approved`.
3. **Tool-declared preconditions cannot be dropped.** The kernel
   merges tool preconditions with the caller's contract; the caller
   can only add, not remove.
4. **Preconditions are re-validated at execution time.** Any
   precondition with `must_revalidate_at_execution: true` is re-checked
   immediately before `tool.execute` runs — TOCTOU defense.
5. **Outputs are validated against the registered schema.** A tool
   returning a value that doesn't match its `output_schema_key` raises
   a structural error rather than entering cognition.

## License

[Apache 2.0](./LICENSE).
