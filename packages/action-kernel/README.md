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

- **Tool registry** — `registerTool()` declares a tool's name, sandbox
  profile, declared permissions and effects, the input schema, and an
  `execute()` function. Lookups go through `lookupTool()`; nothing
  bypasses the registry.
- **Two-phase execution** — `ActionKernel.propose()` returns an
  `ActionContract` describing what the action *would* do (inputs,
  permissions, effects, sandbox profile, predicted observations).
  `ActionKernel.execute()` is the second phase that actually runs the
  tool. Between the two, a `PolicyGate` and `PreconditionChecker` can
  refuse.
- **Sandbox profiles** — explicit declarations of network, filesystem,
  and host-environment access. No silent defaults.
- **Observation factories** — every executed tool emits an
  Observation validated against the schema registered in
  `@qmilab/lodestar-core`.

## Usage

```ts
import {
  ActionKernel,
  registerTool,
  type PolicyGate,
} from "@qmilab/lodestar-action-kernel"

registerTool({
  name: "my.tool@1",
  sandbox: { network: "deny", filesystem: "read-only", env: [] },
  permissions: ["fs.read"],
  effects: [],
  inputSchema: MyInputSchema,
  execute: async (input, ctx) => { /* ... */ },
})

const policy: PolicyGate = {
  evaluate(contract) {
    return contract.effects.length === 0
      ? { allow: true }
      : { allow: false, reason: "no side effects in this session" }
  },
}

const kernel = new ActionKernel({ policy })
const contract = await kernel.propose("my.tool@1", input, ctx)
const outcome = await kernel.execute(contract, ctx)
```

## Invariants

1. **No tool runs without a contract.** `propose()` is mandatory.
2. **The contract is what the policy sees.** Anything the tool actually
   does that wasn't in the contract is a bug — Lodestar's whole point
   is that the contract is honest.
3. **Sandbox profiles are explicit.** A tool that wants network access
   declares it; the host that runs the tool decides whether to grant it.
4. **No host env-var bleed-through into sandboxes.** Tools receive
   only the variables their sandbox declared.

## License

[Apache 2.0](./LICENSE).
