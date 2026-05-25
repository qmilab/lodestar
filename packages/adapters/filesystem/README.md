# @qmilab/lodestar-adapter-filesystem

Filesystem read tool adapter for the
[Lodestar](https://qmilab.com/lodestar) Action Kernel. Part of
Lodestar — the trust layer for AI agents.

Registers the `fs.read@1` tool: a sandbox-respecting file read with a
declared input schema, a Zod-validated output schema, and an
observation emitter for the epistemic chain.

## Install

```sh
npm install @qmilab/lodestar-adapter-filesystem
# or
bun add @qmilab/lodestar-adapter-filesystem
```

## Usage

```ts
import { registerFsReadTool } from "@qmilab/lodestar-adapter-filesystem"
import { ActionKernel } from "@qmilab/lodestar-action-kernel"

registerFsReadTool()

const kernel = new ActionKernel({ /* ... */ })
const contract = await kernel.propose("fs.read@1", { path: "README.md" }, ctx)
const outcome = await kernel.execute(contract, ctx)
```

## What it provides

- `makeFsReadTool()` — constructs the Tool object without registering it.
- `registerFsReadTool()` — convenience that registers it under the
  default name (`fs.read@1`).
- `FsReadOutputSchema` — Zod schema for the tool's output, used by the
  schema registry in `@qmilab/lodestar-core`.

## Invariants

- **Read-only.** No writes. No execution. No directory traversal
  beyond the sandbox profile.
- **Declared permissions.** `fs.read` is the only permission the tool
  claims. A policy gate can refuse the contract before execution
  based on the requested path.
- **Honest observations.** The Observation emitted carries the
  resolved path, file size, and a content hash — enough for downstream
  cognition to extract claims from.

## License

[Apache 2.0](./LICENSE).
