import type { TrustLevel } from "@qmilab/lodestar-core"
import type { ShellCommandSpec } from "./shell.js"

/**
 * Preset command specs for common, narrowly-scoped shell tools.
 *
 * Presets exist so the safe argv shape (and any safety flags) lives in the adapter,
 * not in the agent's hands. Each returns a `ShellCommandSpec` you pass to
 * `registerShellTools({ commands: [...] })`.
 */

/**
 * `shell.test` — run the workspace's test suite via `bun test`.
 *
 * The only accepted call shapes are `bun test` and `bun test -t <pattern>`; any
 * other args are rejected by the matcher before a process is spawned. A test run
 * is reversible (it mutates no source) and defaults to L3.
 *
 * Boundary: this runs the workspace's *own* test code — it is a governance
 * boundary, not an OS sandbox against the code under test (see the package
 * CLAUDE.md). Other runners (npm/pnpm) and lifecycle-script hardening
 * (`--ignore-scripts`) are the extension path; v0 ships bun only.
 */
export function bunTest(
  opts: { name?: string; trust?: TrustLevel; timeoutMs?: number } = {},
): ShellCommandSpec {
  return {
    name: opts.name ?? "shell.test",
    bin: "bun",
    description: "Run the workspace's test suite via `bun test` (optionally filtered with -t).",
    trust: opts.trust ?? 3,
    reversibility: "reversible",
    effects: [],
    timeoutMs: opts.timeoutMs,
    argsMatcher: (requested) => {
      if (requested.length === 0) return ["test"]
      const pattern = requested[1]
      if (
        requested.length === 2 &&
        requested[0] === "-t" &&
        pattern !== undefined &&
        pattern.length > 0
      ) {
        return ["test", "-t", pattern]
      }
      throw new Error(
        `shell.test: only \`bun test\` or \`bun test -t <pattern>\` is allowed; got args ${JSON.stringify(requested)}`,
      )
    },
  }
}
