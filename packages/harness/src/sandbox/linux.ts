import { realpathSync } from "node:fs"
import {
  type Sandbox,
  type SandboxPolicy,
  type WrappedCommand,
  bunBinDir,
  resolveBunPath,
} from "./index.js"

/**
 * Linux sandbox backend: `bubblewrap` (`bwrap`).
 *
 * A fresh mount namespace: read-only binds of the system runtime + declared
 * read-roots, a read-write bind of the per-run scratch, and (when no host is
 * allow-listed) `--unshare-net` for a loopback-only network. The host's HOME and
 * credential stores are simply not bound, so a probe cannot see them. The scoped
 * env (HOME + TMPDIR under the scratch) is passed through `spawn`'s `env`, so
 * bwrap forwards it unchanged — we do not `--clearenv`.
 *
 * Granularity note: `bwrap --unshare-net` is all-or-nothing — an isolated net
 * namespace has only its own loopback, with no route to an external host. So a
 * non-empty `allowHosts` cannot be honoured per-host; this backend then does NOT
 * unshare the network (the probe gets the host's network) — the coarse Linux
 * fallback documented in ADR-0023. The common case (no allow-hosts) is a clean,
 * fully-isolated loopback-only network. First-party DB-gated probes run
 * unsandboxed, so they do not depend on this fallback.
 */

/** System runtime paths a sandboxed bun/git/tar needs (read-only). */
const SYSTEM_RO_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt"]

function roBindTry(path: string): string[] {
  return ["--ro-bind-try", path, path]
}

/**
 * When the host network is shared (an allow-host is set), DNS needs the resolver
 * config. On systemd systems `/etc/resolv.conf` is a symlink into `/run`
 * (`/run/systemd/resolve/stub-resolv.conf`), whose target is NOT under the
 * `/etc` bind — so the symlink dangles inside the sandbox and hostname lookups
 * fail. Bind the symlink's real target (at its own path) when it lives outside
 * `/etc`. A real file under `/etc` is already covered by the `/etc` bind.
 */
function resolverBinds(): string[] {
  try {
    const target = realpathSync("/etc/resolv.conf")
    if (!target.startsWith("/etc/")) return ["--ro-bind-try", target, target]
  } catch {
    /* no resolver config to bind */
  }
  return []
}

/** Build the macOS-free bwrap argv that precedes `-- bun run …`. */
function buildBwrapArgs(policy: SandboxPolicy, binDir: string): string[] {
  const args: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ]
  for (const p of SYSTEM_RO_PATHS) args.push(...roBindTry(p))
  // The bun binary's directory (may live outside /usr, e.g. ~/.bun/bin).
  args.push(...roBindTry(binDir))
  // Operator/pack read-roots (the probe file lives under the pack root).
  for (const root of policy.readRoots) args.push(...roBindTry(root))
  // The per-run scratch — the only writable tree (HOME + TMPDIR live here).
  args.push("--bind", policy.writeRoot, policy.writeRoot)
  // Start inside the scratch so a confined cwd is always valid.
  args.push("--chdir", policy.writeRoot)
  // Network: isolate to loopback unless the operator allow-listed a host (then
  // share the host net — the coarse Linux fallback; see the note above). When
  // shared, also bind the resolver target so hostname allow-hosts can resolve.
  if (policy.allowHosts.length === 0) args.push("--unshare-net")
  else args.push(...resolverBinds())
  return args
}

/** Build the Linux `bwrap` sandbox for `policy`. */
export function buildBwrapSandbox(policy: SandboxPolicy): Sandbox {
  return {
    mechanism: "bwrap",
    wrap(command: string, args: string[]): WrappedCommand {
      const bun = resolveBunPath(command)
      const bwrapArgs = buildBwrapArgs(policy, bunBinDir(command))
      return { command: "bwrap", args: [...bwrapArgs, "--", bun, ...args] }
    },
    cleanup(): void {},
  }
}
