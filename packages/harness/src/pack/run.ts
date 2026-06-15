import { spawn } from "node:child_process"
import { ProbePackError } from "./errors.js"

/** Captured result of a non-executing resolution subprocess (`tar`, `git`). */
export interface SpawnCapture {
  code: number | null
  stdout: string
  stderr: string
}

/** Wall-clock ceiling for a single resolution subprocess. */
export const DEFAULT_RESOLUTION_TIMEOUT_MS = 120_000
/** Output capture cap per stream — a malicious archive/remote cannot spew unbounded. */
const MAX_CAPTURE_BYTES = 1_000_000

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
}

/**
 * Spawn a resolution helper (`tar`, `git`) with a scoped environment, a
 * wall-clock timeout (SIGKILL on expiry), and bounded output capture. Resolves
 * with the exit code and captured streams; rejects (as {@link ProbePackError})
 * only on spawn failure or timeout — a non-zero exit is returned, not thrown, so
 * the caller can fold stderr into a precise message.
 *
 * This is the one place resolution shells out. It mirrors the native adapters'
 * subprocess discipline (scoped env, timeout, bounded capture) but is a
 * TS-level boundary, not an OS sandbox.
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
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(
        new ProbePackError(`'${command}' timed out after ${timeoutMs}ms during pack resolution.`),
      )
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
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new ProbePackError(`Could not spawn '${command}' for pack resolution: ${err.message}`, {
          cause: err,
        }),
      )
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
