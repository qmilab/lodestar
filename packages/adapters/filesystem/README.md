# @qmilab/lodestar-adapter-filesystem

Filesystem adapter for the
[Lodestar](https://qmilab.com/lodestar) Action Kernel: governed reads
and writes confined to an operator-fixed root. Part of Lodestar — the
trust layer for AI agents.

Registers the `fs.read@1` tool: a sandbox-respecting file read with a
declared input schema, a Zod-validated output schema, and an
observation emitter for the epistemic chain.

It also registers `fs.write@1`: a governed write (trust L3,
`write-local`, compensable) hard-confined under a `writableRoot` — no
`..`/absolute/symlink escape, no host-env expansion (`~`/`$VAR` are
literal), oversized contents rejected rather than truncated, missing
parents created only via explicit `createDirs`, and an output that
records `created`/`previous_bytes` for the audit trail.

It also registers `doc.read`: the same sandbox-respecting read, but it
emits a `documentation.source@1` observation tagged with a `kind`
(`package_json` | `markdown` | `source`) so the cognitive core's
`DocumentationExtractor` can read *into* the file content and extract
documentation claims. Used by `examples/documentation-agent/`.

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
- `makeDocReadTool(projectRoot)` / `registerDocReadTool(projectRoot)` —
  the `doc.read` tool, plus `DocumentationSourceOutputSchema` registered
  against `documentation.source@1`.
- `makeFsWriteTool(options)` / `registerFsWriteTool(options)` — the
  `fs.write` tool (`{ writableRoot, maxBytes?, createDirs? }`), plus
  `FsWriteOutputSchema` registered against `fs.write@1`.

## Invariants

- **Path confinement.** Every path resolves against a root fixed at
  construction; `..`, absolute-path, and symlink escapes are refused
  (a write destination that is itself a symlink is refused, not
  followed). No host-env expansion — `~`/`$VAR` are literal.
- **Reads are read-only; writes are explicit.** `fs.read`/`doc.read`
  claim only `fs.read` at L0. `fs.write` claims `fs.write` at L3 with
  a declared `world_state_change` effect, rejects contents over its
  byte cap (never truncates), and creates missing parents only when
  the operator opted in via `createDirs`. A policy gate can refuse
  the contract before execution based on the requested path.
- **Honest observations.** The Observation emitted carries the
  resolved path, file size, and a content hash — enough for downstream
  cognition to extract claims from.

## License

[Apache 2.0](./LICENSE).
