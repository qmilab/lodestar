# @qmilab/lodestar-adapter-shell

Governed shell-command tool adapter for the [Lodestar](https://qmilab.com/lodestar)
Action Kernel — part of Lodestar, the trust layer for AI agents.

Declare the shell commands an agent may run as **command specs**; each becomes its
own governed `Tool` with its own name and trust floor. Every call flows through the
Action Kernel's two-phase `propose → arbitrate → execute`, and its output is
captured as a typed `shell.run@1` observation in the epistemic chain.

## What it enforces

This is a **TS-level audit / governance boundary, not an OS sandbox**:

- **Fixed binary, argv-only.** The binary is fixed by the spec; the agent supplies
  only args. Commands run via `Bun.spawn` with an argv array (never a shell string),
  so inputs cannot inject extra commands.
- **Allowlist.** Each spec's `argsMatcher` validates the requested args and returns
  the final args to run — or throws to reject the call *before* anything is spawned.
- **No host-env passthrough.** The subprocess sees only the declared `env`;
  `process.env` is never spread in. The default scoped env has a fresh empty `HOME`
  and git's global/system config disabled.
- **Wall-clock timeout.** Every command has a deadline; the process is killed at the
  timeout and `timed_out` is reported.
- **Bounded output capture.** stdout/stderr are captured up to a byte cap and flagged
  when truncated.
- **Pinned cwd.** Every command runs in `workspaceRoot`; the agent cannot redirect it.

What it does **not** claim: it does not OS-sandbox the code it runs (no namespaces,
cgroups, or network isolation). `shell.test` executes the workspace's own test code.
OS-level enforcement graduates separately (see the package `CLAUDE.md`,
`docs/architecture/v02-delta.md` §6, and ADR-0004).

## Usage

```ts
import { registerShellTools, bunTest } from "@qmilab/lodestar-adapter-shell"

registerShellTools({
  workspaceRoot: "/path/to/repo",
  // env optional — defaults to a minimal scoped env (fresh HOME, PATH, git off)
  commands: [
    bunTest({ trust: 3 }), // shell.test — `bun test [-t <pattern>]`, auto-approves @L3
    {
      name: "shell.format",
      bin: "bun",
      argsMatcher: (a) => {
        if (a.length === 0) return ["run", "format"] // only `bun run format`
        throw new Error("shell.format takes no args")
      },
      trust: 3,
      reversibility: "compensable",
    },
  ],
})
```

The registered tools are then reachable through `guard.wrap()` / the Action Kernel
like any other Lodestar tool. (The adapter is **not** reachable through the MCP
proxy — the proxy only governs downstream MCP servers; see the Telenotes example.)

## License

Apache-2.0
