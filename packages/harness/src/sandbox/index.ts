import { existsSync } from "node:fs"
import { platform } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { buildBwrapSandbox } from "./linux.js"
import { buildSandboxExecSandbox } from "./macos.js"

/**
 * OS sandbox for probe execution (#121, ADR-0023 — step 2).
 *
 * Step 1 (ADR-0022) denied a probe the host `process.env`; it did NOT contain a
 * probe's filesystem or network reach. This module is the step-2 boundary: it
 * wraps the probe spawn in an OS sandbox that confines reads to an
 * operator-declared set of roots, writes to a per-run scratch, and outbound
 * network to loopback plus an operator allowlist.
 *
 * It is an **OS-primitive governance boundary, not kernel-grade containment** —
 * the same honesty every native adapter and step 1 practise. `sandbox-exec` is
 * Apple-deprecated (works today); `bwrap` relies on unprivileged user
 * namespaces. We claim filesystem-read confinement to the declared roots,
 * filesystem-write confinement to the scratch, and outbound-network
 * deny-by-default to loopback + the allowlist. We do not claim defence against a
 * kernel-level sandbox escape, nor (on Linux) per-host network granularity.
 */

/** A mechanism this host can enforce a probe sandbox with. */
export type SandboxMechanism = "sandbox-exec" | "bwrap"

/**
 * The resolved confinement policy for one pack run. Absolute paths throughout.
 * Built by the runner from the operator's {@link ProbeSandboxOptions} plus the
 * pack root and the per-run scratch — the operator widens, the manifest cannot.
 */
export interface SandboxPolicy {
  /**
   * Directories a probe may READ, beyond the always-allowed system runtime
   * paths. Defaults to the pack directory; the operator adds more via
   * `--allow-read`. The consumer's wider filesystem is denied.
   */
  readRoots: string[]
  /**
   * The single directory a probe may READ and WRITE — its per-run scratch. The
   * scoped env points HOME and TMPDIR inside it, so a probe's `mkdtemp`/`tmpdir`
   * writes land here and nowhere else.
   */
  writeRoot: string
  /**
   * Non-loopback hosts a probe may reach, each `host` or `host:port`. Loopback
   * (`127.0.0.1`/`::1`/`localhost`) is always allowed; everything else is denied
   * unless listed here (operator `--allow-host`). See the per-platform notes on
   * granularity in {@link buildBwrapSandbox} / {@link buildSandboxExecSandbox}.
   */
  allowHosts: string[]
}

/** A spawn rewritten to run inside the sandbox. */
export interface WrappedCommand {
  command: string
  args: string[]
}

/** A constructed sandbox: rewrites a spawn and owns any transient resources. */
export interface Sandbox {
  readonly mechanism: SandboxMechanism
  /**
   * Rewrite `(command, args)` into the sandboxed invocation. `command` is the
   * `bun` executable; a non-absolute command is resolved to the running bun
   * (`process.execPath`) so the binary the sandbox must grant is unambiguous.
   */
  wrap(command: string, args: string[]): WrappedCommand
  /** Release any transient resource (e.g. a temp profile file). Best-effort. */
  cleanup(): void
}

/** Does a `cmd` resolve to an executable on the current PATH? */
function onPath(cmd: string): boolean {
  const path = process.env.PATH
  if (path === undefined) return false
  return path.split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, cmd)))
}

/**
 * The sandbox mechanism available on this host, or `null` if none is. macOS
 * ships `sandbox-exec`; Linux needs `bubblewrap` installed (and unprivileged
 * user namespaces enabled — not probed here, surfaced as a spawn failure). A
 * `null` return is the runner's fail-closed signal.
 */
export function detectSandboxMechanism(): SandboxMechanism | null {
  if (platform() === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") ? "sandbox-exec" : null
  }
  if (platform() === "linux") {
    return onPath("bwrap") ? "bwrap" : null
  }
  return null
}

/**
 * Resolve the bun executable the sandbox must grant. An absolute path is used
 * verbatim; anything else resolves to the running interpreter
 * (`process.execPath`) so the binary is unambiguous inside the sandbox (PATH
 * resolution can differ once the filesystem view is confined).
 */
export function resolveBunPath(command: string): string {
  return isAbsolute(command) ? command : process.execPath
}

/**
 * Build a sandbox enforcing `policy` on this host, or `null` if no mechanism is
 * available (the caller fails closed). The system runtime paths a sandboxed
 * `bun`/`git`/`tar` needs are added by the per-platform backend; `policy` only
 * carries the operator/pack-specific grants.
 */
export function createSandbox(policy: SandboxPolicy): Sandbox | null {
  const mechanism = detectSandboxMechanism()
  if (mechanism === "sandbox-exec") return buildSandboxExecSandbox(policy)
  if (mechanism === "bwrap") return buildBwrapSandbox(policy)
  return null
}

/** Directory holding the bun binary — always granted read+exec in a sandbox. */
export function bunBinDir(command: string): string {
  return dirname(resolveBunPath(command))
}
