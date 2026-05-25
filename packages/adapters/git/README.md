# @qmilab/lodestar-adapter-git

Git status tool adapter for the
[Lodestar](https://qmilab.com/lodestar) Action Kernel. Part of
Lodestar — the trust layer for AI agents.

Registers the `git.status@1` tool: a sandbox-respecting wrapper around
`git status --porcelain` with a declared input schema, a Zod-validated
output schema, and an observation emitter for the epistemic chain.

## Install

```sh
npm install @qmilab/lodestar-adapter-git
# or
bun add @qmilab/lodestar-adapter-git
```

## Usage

```ts
import { registerGitStatusTool } from "@qmilab/lodestar-adapter-git"
import { ActionKernel } from "@qmilab/lodestar-action-kernel"

// projectRoot is required — git status runs inside it.
registerGitStatusTool(process.cwd())

const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink)
const action = kernel.propose({
  intent: "inspect repository state",
  tool: "git.status",
  inputs: { repo: "." },
  contract: { /* ... */ },
  proposed_by: "agent-1",
})
const arbitrated = await kernel.arbitrate(action)
if (arbitrated.phase === "approved") {
  const executed = await kernel.execute(arbitrated)
}
```

## What it provides

- `makeGitStatusTool(projectRoot)` — constructs the Tool object
  without registering it.
- `registerGitStatusTool(projectRoot)` — convenience that registers
  it under the name `git.status` with
  `output_schema_key: "git.status@1"`.
- `GitStatusOutputSchema` — Zod schema for the tool's output,
  registered against `git.status@1` in `@qmilab/lodestar-core`'s
  schema registry.

## Invariants

- **Read-only.** Status only — no commits, no checkouts, no branch
  changes. Other git operations are separate tools with their own
  contracts.
- **Declared permissions.** The tool claims only the permissions it
  needs (filesystem read in the working tree, no network, no host
  env-var bleed-through).
- **Honest observations.** The Observation emitted lists the
  branch, ahead/behind counters, and porcelain entries — enough for
  downstream cognition to extract claims like "current branch is X" or
  "5 files are staged for commit."

## License

[Apache 2.0](./LICENSE).
