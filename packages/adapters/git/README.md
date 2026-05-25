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

registerGitStatusTool()

const kernel = new ActionKernel({ /* ... */ })
const contract = await kernel.propose("git.status@1", { cwd: "." }, ctx)
const outcome = await kernel.execute(contract, ctx)
```

## What it provides

- `makeGitStatusTool()` — constructs the Tool object without registering it.
- `registerGitStatusTool()` — convenience that registers it under the
  default name (`git.status@1`).
- `GitStatusOutputSchema` — Zod schema for the tool's output, used by
  the schema registry in `@qmilab/lodestar-core`.

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
