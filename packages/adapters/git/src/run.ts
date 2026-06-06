import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Scoped `git` runner shared by the transport tools (`git.commit` / `git.push` /
 * `git.clone`). A git-specialised sibling of the shell adapter's `runScoped`
 * (`@qmilab/lodestar-adapter-shell`): same hardening — scoped env, argv-only exec
 * (never a shell string), wall-clock timeout with process-group reaping, bounded
 * output capture — plus two git-specific concerns:
 *
 *   - **Secret redaction.** A resolved credential (token) is passed to git through
 *     the environment, never argv, so it does not appear in `ps`. As defence in
 *     depth we still redact any declared secret strings from the captured
 *     command/stdout/stderr before they can reach an observation or a log.
 *   - **Host git config neutralised.** The base env sets a fresh empty HOME and
 *     `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`, so an attacker-controlled
 *     `~/.gitconfig` (hook paths, includes, credential helpers) cannot influence
 *     the commands this adapter runs.
 *
 * Like the shell adapter, this is a TS-level governance boundary, not an OS
 * sandbox: `git.push` / `git.clone` reach the real network by design. The
 * governance is destination pinning + credential scoping + the L4 approval gate,
 * not network containment.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 120_000 // 2 minutes
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB per stream
// After the deadline kills the process group the pipes close and `close` fires
// promptly; this hard backstop guarantees the call cannot hang past the deadline
// even if the group kill fails to close them.
const TIMEOUT_GRACE_MS = 500

export interface GitRunResult {
  /** The exact argv executed (argv[0] is `git`), with secrets redacted. */
  command: string[]
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}

export interface GitRunOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  /** Literal strings (e.g. a resolved token) to strip from command/stdout/stderr. */
  redactions?: string[]
}

/**
 * The base scoped environment every git command runs under: a fresh empty HOME
 * (so git reads no host dotfiles), git's global/system config neutralised, and
 * non-interactive (`GIT_TERMINAL_PROMPT=0` so a missing credential fails fast
 * instead of blocking on a prompt). `PATH` is inherited so `git` resolves;
 * `process.env` is otherwise NOT passed through. Mirrors the Action Kernel's
 * "no host env to sandboxes" rule and the shell adapter's `defaultScopedEnv`.
 */
export function baseGitEnv(home?: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home ?? mkdtempSync(join(tmpdir(), "lodestar-git-home-")),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
  const path = process.env.PATH
  if (path !== undefined) env.PATH = path
  return env
}

/** Replace every occurrence of each non-empty redaction with `***`. */
export function applyRedactions(text: string, redactions: string[] | undefined): string {
  if (!redactions || redactions.length === 0) return text
  let out = text
  for (const secret of redactions) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}

/**
 * Redact credentials embedded in a remote URL (`scheme://user:pass@host/...`).
 * Operators are told never to put credentials in the pinned URL — credentials
 * flow through the `credential` config — but if one slips in, never surface it.
 */
export function redactUrl(url: string): string {
  return url.replace(/(\w+:\/\/)([^/@\s]+)@/g, (_m, scheme: string) => `${scheme}***@`)
}

interface StreamSink {
  readonly onData: (chunk: Buffer) => void
  text(): string
  truncated(): boolean
}

function makeStreamSink(maxBytes: number): StreamSink {
  const chunks: Buffer[] = []
  let stored = 0
  let truncated = false
  return {
    onData(chunk: Buffer): void {
      if (stored >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - stored
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        stored += chunk.length
      } else {
        chunks.push(chunk.subarray(0, remaining))
        stored += remaining
        truncated = true
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  }
}

/**
 * Run `git <args>` under the scoped env with a wall-clock timeout and bounded
 * output capture. Never invokes a shell: `git` is spawned with an argv array, so
 * a malicious arg cannot inject a second command. The whole process group is
 * reaped on completion or at the deadline so no descendant outlives the action.
 */
export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const start = Date.now()
  const redactions = opts.redactions

  // `detached: true` puts git in its own process group so the timeout can signal
  // the whole group by negative pid, reclaiming any descendant (e.g. a credential
  // helper) that inherited the pipes — mirrors the shell adapter.
  const child = spawn("git", args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  const stdoutSink = makeStreamSink(opts.maxOutputBytes)
  const stderrSink = makeStreamSink(opts.maxOutputBytes)
  child.stdout?.on("data", stdoutSink.onData)
  child.stderr?.on("data", stderrSink.onData)

  const killGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already exited */
      }
    }
  }

  let timedOut = false
  const exitCode = await new Promise<number>((resolveFn) => {
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      killGroup("SIGKILL")
      resolveFn(code)
    }
    const deadline = setTimeout(() => {
      timedOut = true
      killGroup("SIGKILL")
      graceTimer = setTimeout(() => finish(-1), TIMEOUT_GRACE_MS)
    }, opts.timeoutMs)
    child.once("close", (code) => finish(code ?? -1))
    child.once("error", () => finish(-1))
  })

  return {
    command: ["git", ...args].map((part) => applyRedactions(part, redactions)),
    exit_code: exitCode,
    stdout: applyRedactions(stdoutSink.text(), redactions),
    stderr: applyRedactions(stderrSink.text(), redactions),
    duration_ms: Date.now() - start,
    timed_out: timedOut,
    stdout_truncated: stdoutSink.truncated(),
    stderr_truncated: stderrSink.truncated(),
  }
}
