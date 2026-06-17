import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import {
  type Sandbox,
  type SandboxPolicy,
  type WrappedCommand,
  bunBinDir,
  resolveBunPath,
} from "./index.js"

/**
 * macOS sandbox backend: `sandbox-exec -p <SBPL profile>`.
 *
 * SBPL is last-match-wins. `bun` is a JIT runtime (JavaScriptCore) that a strict
 * `(deny default)` profile cannot reliably host across macOS versions — the
 * allowlist a JIT needs (executable mmap, mach bootstrap, POSIX shm, …) is large
 * and brittle. So we take the robust, well-trodden shape: `(allow default)` to
 * let the runtime run, then **clamp** the three reachable surfaces —
 *
 *   - **writes:** denied everywhere except the per-run scratch;
 *   - **network:** denied except loopback + the operator allow-hosts;
 *   - **reads:** the operator's **home directory** (where ssh/aws/gcloud/npm
 *     credential stores live) is denied, re-allowing only the declared
 *     read-roots (which may themselves sit under home).
 *
 * This is weaker than a read-allowlist: it does NOT deny reads of `/etc`,
 * `/var`, or other users' files — it denies the running user's home, the actual
 * secret store. Linux (bwrap) gets the stronger read-allowlist via a mount
 * namespace; the per-host network granularity is the reverse (macOS is exact,
 * Linux coarse). Both close the primary threats — read host secrets / exfiltrate
 * — with the per-platform edges documented in ADR-0023. An OS-primitive
 * boundary, not kernel-grade containment.
 */

/** Escape a path for embedding in an SBPL `"..."` string literal. */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Render `(subpath "…")` clauses, one per directory. */
function subpaths(dirs: string[]): string {
  return dirs.map((d) => `  (subpath "${sbplString(d)}")`).join("\n")
}

/**
 * Render the network-outbound allows for the operator allow-hosts. A bare IP or
 * `ip:port` is matched exactly; a hostname coarsens to its port (`*:port`) or,
 * with no port, to all outbound — SBPL cannot resolve names.
 */
function networkAllows(allowHosts: string[]): string[] {
  const lines: string[] = []
  for (const entry of allowHosts) {
    const colon = entry.lastIndexOf(":")
    const host = colon > 0 ? entry.slice(0, colon) : entry
    const port = colon > 0 ? entry.slice(colon + 1) : ""
    const isIp = /^[0-9.]+$/.test(host) || host.includes(":")
    if (isIp) lines.push(`(allow network-outbound (remote ip "${sbplString(entry)}"))`)
    else if (port) lines.push(`(allow network-outbound (remote ip "*:${sbplString(port)}"))`)
    else lines.push("(allow network-outbound)")
  }
  return lines
}

/** Resolve a path to its real path; SBPL matches canonical paths, and `$HOME` /
 * `tmpdir()` are commonly symlinks on macOS (`/var` → `/private/var`). An
 * un-canonicalised deny-rule would silently fail to match. */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function buildProfile(policy: SandboxPolicy, binDir: string): string {
  const home = canonical(homedir())
  // The probe's own scratch + bun's dir are always readable/writable as needed;
  // bin dir is read so the runtime resolves even if it lives under $HOME.
  const readRoots = [...policy.readRoots, policy.writeRoot, binDir]
  const lines = [
    "(version 1)",
    // Let the JIT runtime run, then clamp the reachable surfaces below.
    "(allow default)",
    // --- writes: scratch only -------------------------------------------------
    "(deny file-write*)",
    `(allow file-write* (subpath "${sbplString(policy.writeRoot)}"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    // --- network: loopback + operator allow-hosts -----------------------------
    "(deny network*)",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow network-outbound (remote unix-socket))",
    ...networkAllows(policy.allowHosts),
    // --- reads: deny the user's home, re-allow declared roots -----------------
    `(deny file-read* (subpath "${sbplString(home)}"))`,
    `(allow file-read*\n${subpaths(readRoots)}\n)`,
  ]
  return lines.join("\n")
}

/** Build the macOS `sandbox-exec` sandbox for `policy`. */
export function buildSandboxExecSandbox(policy: SandboxPolicy): Sandbox {
  return {
    mechanism: "sandbox-exec",
    wrap(command: string, args: string[]): WrappedCommand {
      const bun = resolveBunPath(command)
      const profile = buildProfile(policy, bunBinDir(command))
      return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, bun, ...args] }
    },
    // The profile is passed inline via `-p`; nothing to clean up.
    cleanup(): void {},
  }
}
