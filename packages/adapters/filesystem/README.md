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

// projectRoot is required — every fs.read input path is resolved
// relative to it, and reads outside that root are rejected.
registerFsReadTool(process.cwd())

const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink)
const action = kernel.propose({
  intent: "read project file",
  tool: "fs.read",
  inputs: { path: "README.md" },
  contract: { /* ... */ },
  proposed_by: "agent-1",
})
const arbitrated = await kernel.arbitrate(action)
if (arbitrated.phase === "approved") {
  const executed = await kernel.execute(arbitrated)
}
```

## What it provides

- `makeFsReadTool(projectRoot)` — constructs the Tool object without
  registering it.
- `registerFsReadTool(projectRoot)` — convenience that registers it
  under the name `fs.read` with `output_schema_key: "fs.read@1"`.
- `FsReadOutputSchema` — Zod schema for the tool's output, registered
  against `fs.read@1` in `@qmilab/lodestar-core`'s schema registry.

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
