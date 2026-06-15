import { spawn } from "node:child_process"
import { ProbePackError } from "./errors.js"

/** Captured result of a non-executing resolution subprocess (`tar`, `git`). */
export interface SpawnCapture {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Wall-clock ceiling for a single resolution subprocess. */
export const DEFAULT_RESOLUTION_TIMEOUT_MS = 120_000
/** Output capture cap per stream — a malicious archive/remote cannot spew unbounded. */
const MAX_CAPTURE_BYTES = 1_000_000
/**
 * After the deadline kills the process group the pipes close and `close` fires
 * promptly; this hard backstop guarantees the call cannot hang past the deadline
 * even if the group kill fails to close them. Mirrors the git adapter.
 */
const TIMEOUT_GRACE_MS = 500

export interface SpawnCapturedOptions {
  /**
   * The subprocess environment. This is the SCOPED env — it is passed verbatim
   * and the host `process.env` is NOT inherited. Source resolution mirrors the
   * Action Kernel's "no host env to sandboxes" rule: a fetch/extract/clone gets
   * only what we hand it (PATH, and for git the scoped config nulls), never host
   * secrets. Callers build this explicitly; there is no silent default.
   */
  env: Record<string, string>
  cwd?: string
  timeoutMs?: number
  /**
   * Literal strings (e.g. a credential embedded in a remote URL) to strip from
   * the captured stdout/stderr before they can reach an error message or a log.
   */
  redactions?: string[]
}

/** Replace every occurrence of each non-empty redaction with `***`, longest-first. */
export function applyRedactions(text: string, redactions: string[] | undefined): string {
  if (!redactions || redactions.length === 0) return text
  let out = text
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}

/**
 * Spawn a resolution helper (`tar`, `git`) with a scoped environment, a
 * wall-clock timeout, and bounded, optionally-redacted output capture. Resolves
 * with the exit code and captured streams; rejects (as {@link ProbePackError})
 * only on spawn failure — a non-zero exit (and a timeout) is returned, not
 * thrown, so the caller can fold stderr into a precise message.
 *
 * The child is spawned `detached` (its own process group) and the **whole group**
 * is reaped — on normal completion and at the deadline — so a descendant helper
 * (e.g. `git clone`'s `ssh` / `git-remote-https`) cannot outlive a failed or
 * timed-out resolution and the advertised wall-clock ceiling is actually
 * enforced. Mirrors `@qmilab/lodestar-adapter-git`'s `runGit`.
 */
export function spawnCaptured(
  command: string,
  args: readonly string[],
  options: SpawnCapturedOptions,
): Promise<SpawnCapture> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so the timeout can signal the whole group by negative
      // pid and reclaim any descendant that inherited the pipes.
      detached: true,
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined

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

    const finish = (result: SpawnCapture | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      killGroup("SIGKILL")
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const deadline = setTimeout(() => {
      timedOut = true
      killGroup("SIGKILL")
      // Backstop: if the group kill does not close the pipes promptly, resolve as
      // a timeout anyway so the call cannot hang past the deadline.
      graceTimer = setTimeout(() => {
        finish({
          code: null,
          stdout: applyRedactions(stdout, options.redactions),
          stderr: applyRedactions(stderr, options.redactions),
          timedOut: true,
        })
      }, TIMEOUT_GRACE_MS)
    }, timeoutMs)

    const capture = (chunk: Buffer, into: "stdout" | "stderr") => {
      const text = chunk.toString("utf8")
      if (into === "stdout") {
        if (stdout.length < MAX_CAPTURE_BYTES)
          stdout += text.slice(0, MAX_CAPTURE_BYTES - stdout.length)
      } else if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += text.slice(0, MAX_CAPTURE_BYTES - stderr.length)
      }
    }

    child.stdout?.on("data", (c: Buffer) => capture(c, "stdout"))
    child.stderr?.on("data", (c: Buffer) => capture(c, "stderr"))
    child.on("error", (err) => {
      finish(
        new ProbePackError(`Could not spawn '${command}' for pack resolution: ${err.message}`, {
          cause: err,
        }),
      )
    })
    child.on("close", (code) => {
      finish({
        code,
        stdout: applyRedactions(stdout, options.redactions),
        stderr: applyRedactions(stderr, options.redactions),
        timedOut,
      })
    })
  })
}
