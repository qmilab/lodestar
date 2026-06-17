import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import {
  type Sandbox,
  type SandboxPolicy,
  type WrappedCommand,
  bunBinDir,
  macosAllowHostError,
  resolveBunPath,
  splitHostPort,
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
 *   - **reads:** the home credential stores are denied **independently of
 *     `$HOME`** (which `os.homedir()`/`os.userInfo()` follow and a nested/wrapped
 *     caller may have scoped): `/Users`, `/var/root`, and the real account home
 *     resolved from Directory Services (`id -un` + `dscl`, covering a non-`/Users`
 *     custom/network home). Only the declared read-roots are re-allowed.
 *
 * This is weaker than a read-allowlist: it does NOT deny reads of `/etc` or
 * `/var` — it denies the home credential stores, the actual secret store. Linux
 * (bwrap) gets the stronger read-allowlist via a mount
 * namespace. Outbound egress is coarse on both platforms, just differently:
 * macOS scopes by **port** (SBPL cannot filter by host — a literal IP is
 * rejected, only `*:port` loads), Linux is **all-or-nothing** (sharing the host
 * net once any host is allow-listed). Both close the primary threats — read host
 * secrets / exfiltrate — with the per-platform edges documented in ADR-0023. An
 * OS-primitive boundary, not kernel-grade containment.
 */

/** Escape a path for embedding in an SBPL `"..."` string literal. */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

let realHomeCache: string | null | undefined
/**
 * The account's real home directory, resolved **independently of `$HOME`/`$USER`**
 * — both of which bun's `os.homedir()`/`os.userInfo()` follow, so neither is safe
 * for a security deny. We ask Directory Services: the real username from `id -un`
 * (keyed on the effective uid, not the env), then its `NFSHomeDirectory`. This is
 * what covers a non-`/Users` home (root / custom / network) when the caller runs
 * with an overridden HOME. Returns `null` if it cannot be resolved (the `/Users`
 * + `/var/root` static denials still apply). Memoised — it cannot change within a
 * process and the lookup shells out.
 */
function realAccountHome(): string | null {
  if (realHomeCache !== undefined) return realHomeCache
  realHomeCache = null
  try {
    const username = execFileSync("id", ["-un"], { encoding: "utf8", timeout: 5000 }).trim()
    if (username.length === 0) return realHomeCache
    const record = execFileSync(
      "/usr/bin/dscl",
      [".", "-read", `/Users/${username}`, "NFSHomeDirectory"],
      { encoding: "utf8", timeout: 5000 },
    )
    const matched = record.match(/NFSHomeDirectory:\s*(.+)/)
    realHomeCache = matched?.[1]?.trim() || `/Users/${username}`
  } catch {
    // dscl/id unavailable or failed — fall back to the static denials.
  }
  return realHomeCache
}

/** Render `(subpath "…")` clauses, one per directory. */
function subpaths(dirs: string[]): string {
  return dirs.map((d) => `  (subpath "${sbplString(d)}")`).join("\n")
}

/**
 * Render the network-outbound allows for the operator allow-hosts. SBPL scopes
 * by PORT, not host (a literal `(remote ip "1.2.3.4:port")` is rejected; only
 * `*:port` loads), so each entry is allowed as any host on its port. Entries are
 * validated to carry a port by {@link macosAllowHostError} before the sandbox is
 * built — we never emit an unfiltered `(allow network-outbound)`, which would
 * turn one grant into all egress.
 */
function networkAllows(allowHosts: string[]): string[] {
  const lines: string[] = []
  for (const entry of allowHosts) {
    const { port } = splitHostPort(entry)
    if (!/^\d+$/.test(port)) continue // defensive: validated upstream (needs a port)
    lines.push(`(allow network-outbound (remote ip "*:${sbplString(port)}"))`)
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
  // The probe's own scratch + bun's dir are always readable/writable as needed;
  // bin dir is read so the runtime resolves even if it lives under a home dir.
  const readRoots = [...policy.readRoots, policy.writeRoot, binDir]
  // Deny the home credential stores INDEPENDENTLY of `$HOME`: `os.homedir()` (and
  // bun's `os.userInfo().homedir`) follow the possibly-scoped/overridden HOME env,
  // so denying only that would leave the real home readable under `(allow default)`
  // whenever the caller runs with a non-real HOME (a nested runPack, a wrapper that
  // sets HOME, CI). We deny: `/Users` (every standard macOS home, regardless of
  // HOME), `/var/root` (root's home), the Directory-Services-resolved real home
  // (covers a non-`/Users` custom/network home, resolved without trusting the env),
  // and the env-resolved homedir (a harmless extra in the common case). Read-roots
  // are re-allowed below (last-match-wins), so a declared root under /Users reads.
  const denyReads = [
    ...new Set(
      ["/Users", "/var/root", realAccountHome(), canonical(homedir())].filter(
        (d): d is string => d !== null,
      ),
    ),
  ]
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
    ...networkAllows(policy.allowHosts),
    // --- reads: deny home credential stores, re-allow declared roots ----------
    `(deny file-read* ${denyReads.map((d) => `(subpath "${sbplString(d)}")`).join(" ")})`,
    `(allow file-read*\n${subpaths(readRoots)}\n)`,
  ]
  return lines.join("\n")
}

/** Build the macOS `sandbox-exec` sandbox for `policy`. */
export function buildSandboxExecSandbox(policy: SandboxPolicy): Sandbox {
  // Fail closed before any probe runs: a hostname/IPv6 allow-host cannot be
  // expressed in SBPL, and silently widening it (or dropping it) is unsafe.
  const hostError = macosAllowHostError(policy.allowHosts)
  if (hostError !== null) throw new Error(hostError)
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
