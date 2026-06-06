# @qmilab/lodestar-adapter-shell — CLAUDE.md

The native shell-command adapter. Graduates the demo-shaped
`examples/telenotes-governed-dev/dev-tools-mcp/` server (three hardcoded tools)
into a configurable native adapter under `packages/`: the operator declares
command **specs**, and each becomes its own governed `Tool` with its own name and
trust floor. First slice of the post-v1 P2 native-adapters work (shell → github →
nostr); git commit/push graduate into the `github` adapter, not this one.

## What lives here

- `src/shell.ts` — the `shell.run@1` output schema, the `ShellCommandSpec` /
  `ShellAdapterConfig` types, the scoped-env + spawn-with-timeout + bounded-capture
  `runScoped`, and the `defineShellTool` / `defineShellTools` / `registerShellTools`
  factory.
- `src/presets.ts` — `bunTest`: the `shell.test` preset (`bun test [-t <pattern>]`).
- `src/shell.test.ts` — mechanism-level Bun unit tests (env isolation, timeout,
  truncation, matcher rejection).

The headline adversarial invariants are locked by the harness probe
`packs/lodestar-core/probes/shell-adapter-enforces-sandbox-invariants.ts`, which
drives the real adapter through the kernel.

## The boundary this claims — and the one it does not

This is a **TS-level audit / governance boundary, not an OS sandbox.** It enforces,
in-process:

1. **Fixed binary + argv, no shell.** The binary is fixed by the spec; the agent
   supplies only args, which pass through the spec's `argsMatcher`. `Bun.spawn`
   takes an argv array, never a shell string — no command/argument injection.
2. **Allowlist via `argsMatcher`.** It validates the requested args and returns the
   final args, or throws to reject the call *before any process is spawned*. A
   preset can inject safety flags the agent cannot see or override.
3. **No host-env passthrough.** The subprocess sees only the declared `env`;
   `process.env` is never spread in. The default scoped env mirrors the dev-tools
   `scopedEnv`: fresh empty `HOME`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`,
   `PATH` inherited. (Mirrors the Action Kernel's "no host env to sandboxes" rule.)
4. **Wall-clock timeout.** Every command has a deadline. The child is spawned
   `detached` (its own process group) so the timeout kills the whole group by its
   negative pid — a descendant that inherited the stdout/stderr pipes is reclaimed,
   not just the immediate child (otherwise it would hold the pipes open and run the
   action past its deadline). A hard grace-timer backstop guarantees the call never
   hangs even if group-kill fails. `timed_out` is reported.
5. **Bounded output capture.** stdout/stderr are captured up to `maxOutputBytes` and
   flagged when truncated; the child is still drained to EOF so it cannot block.
6. **Pinned cwd.** Every command runs in `workspaceRoot`; the agent cannot redirect it.

**What it does NOT claim:** it does not OS-sandbox the code it runs. `shell.test`
executes the workspace's own test code; a command that internally `cd`s elsewhere,
opens a socket, or reads outside the workspace is not prevented at the OS level. That
enforcement (namespaces, cgroups, `--network none`) graduates with a real
`controlled-shell` runtime — deferred, not done here. Keep this honest in docs and
tool descriptions, exactly as `docs/architecture/v02-delta.md` §6 and the dev-tools
server do. Decision recorded in `.claude/adr/0004-native-shell-adapter-ts-level-sandbox.md`.

## When you add a command

- Give it a `namespace.action` name (e.g. `shell.test`) and a **fixed** `bin`.
- Make `argsMatcher` as tight as possible — allowlist the exact arg shapes, return
  the final args, and **throw** on anything else. Never let the agent's args reach
  the binary unvalidated.
- Set `trust` to the right floor (the kernel enforces it). Irreversible/external
  commands belong at L4 and stay blocked until approved — don't lower the floor to
  make a demo pass.
- Declare real `effects` and `reversibility`; `[]` effects means read-only.
- Do **not** widen the default scoped env to pass host secrets through. If a command
  needs a variable, declare it explicitly in `env`.
