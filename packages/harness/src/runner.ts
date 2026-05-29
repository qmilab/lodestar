import { spawn } from "node:child_process"
import type { LoadedProbe, LoadedProbePack } from "./pack/loader.js"

/**
 * The pack runner.
 *
 * Executes the probes in a {@link LoadedProbePack} and reports the
 * aggregate result. It is a *subprocess driver*: each probe is run as
 * `bun run <file>` and its exit code is the verdict — 0 is a pass,
 * anything else is a fail. This is the same contract `lodestar probe
 * <name>` already uses, and it is what lets the 17 first-party probes
 * stay untouched (they are scripts, not classes; probes are spec).
 *
 * The runner does not load or interpret probe source. It does not record
 * to the event log either — recording is an injected {@link ProbeRunRecorder}
 * so the runner core depends on nothing but `node:child_process`. The
 * CLI wires in the event-log-backed recorder from `./recorder.ts` so
 * that probe runs are auditable through `lodestar report`.
 */

/** The result of running one probe file as a subprocess. */
export interface ProbeRunOutcome {
  /** Probe name from the manifest. */
  name: string
  /** Probe source file, relative to the pack root. */
  file: string
  /** True when the probe exited 0. */
  passed: boolean
  /** Process exit code, or null when terminated by a signal or never spawned. */
  exit_code: number | null
  /** Terminating signal name, or null when the probe exited normally. */
  signal: string | null
  /** Wall-clock duration of the subprocess, milliseconds. */
  duration_ms: number
  /** ISO timestamp captured immediately before spawn. */
  started_at: string
  /** Captured stdout (the probe's own banner). */
  stdout: string
  /** Captured stderr. */
  stderr: string
}

/** Aggregate result of running a whole pack. */
export interface PackRunResult {
  /** Pack name from the manifest. */
  pack: string
  /** True when every probe passed. */
  ok: boolean
  total: number
  passed: number
  failed: number
  outcomes: ProbeRunOutcome[]
  /** Wall-clock duration of the entire pack run, milliseconds. */
  duration_ms: number
}

/**
 * Sink for probe-run records. Called once per probe, after it finishes,
 * with the outcome and the owning pack name. Implementations turn this
 * into a synthetic `observation.recorded` event (see `./recorder.ts`).
 */
export type ProbeRunRecorder = (outcome: ProbeRunOutcome, pack: string) => Promise<void> | void

export interface RunPackOptions {
  /** The `bun` executable to spawn. Defaults to `"bun"` (resolved on PATH). */
  bun?: string
  /** Optional sink invoked once per probe so runs can be recorded/audited. */
  record?: ProbeRunRecorder
  /** Optional progress callback fired as each probe completes. */
  onResult?: (outcome: ProbeRunOutcome) => void
}

function spawnProbe(
  bun: string,
  probe: LoadedProbe,
): Promise<{ exit_code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bun, ["run", probe.path], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    // A spawn failure (e.g. `bun` not on PATH) is a probe failure, not a
    // harness crash — resolve with a synthetic non-zero outcome so the
    // pack run completes and reports it like any other failing probe.
    child.on("error", (err) => {
      resolve({
        exit_code: null,
        signal: null,
        stdout,
        stderr: `${stderr}failed to spawn probe: ${err.message}\n`,
      })
    })
    child.on("close", (code, signal) => {
      resolve({ exit_code: code, signal: signal ?? null, stdout, stderr })
    })
  })
}

/** Run a single resolved probe as a subprocess and return its outcome. */
export async function runProbe(
  probe: LoadedProbe,
  options: RunPackOptions = {},
): Promise<ProbeRunOutcome> {
  const bun = options.bun ?? "bun"
  const started_at = new Date().toISOString()
  const start = performance.now()
  const { exit_code, signal, stdout, stderr } = await spawnProbe(bun, probe)
  const duration_ms = Math.round(performance.now() - start)
  return {
    name: probe.name,
    file: probe.file,
    passed: exit_code === 0,
    exit_code,
    signal,
    duration_ms,
    started_at,
    stdout,
    stderr,
  }
}

/**
 * Run every probe in a pack, in manifest order, and return the aggregate
 * result. Probes run sequentially: this mirrors the `probes:all` script
 * the runner replaces and avoids any contention on a shared event-log
 * directory when recording is enabled.
 *
 * A failing probe does not abort the run — every probe executes so the
 * caller sees the full picture, not just the first failure. The recorder
 * (if any) is awaited per probe so the audit trail is complete before the
 * summary returns.
 */
export async function runPack(
  pack: LoadedProbePack,
  options: RunPackOptions = {},
): Promise<PackRunResult> {
  const start = performance.now()
  const outcomes: ProbeRunOutcome[] = []
  for (const probe of pack.probes) {
    const outcome = await runProbe(probe, options)
    outcomes.push(outcome)
    if (options.record) await options.record(outcome, pack.manifest.name)
    options.onResult?.(outcome)
  }
  const passed = outcomes.filter((o) => o.passed).length
  return {
    pack: pack.manifest.name,
    ok: passed === outcomes.length,
    total: outcomes.length,
    passed,
    failed: outcomes.length - passed,
    outcomes,
    duration_ms: Math.round(performance.now() - start),
  }
}
