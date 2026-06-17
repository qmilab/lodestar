import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
 * so the runner core depends on nothing but `node:child_process` (plus a
 * temp dir for the scoped HOME). The CLI wires in the event-log-backed
 * recorder from `./recorder.ts` so that probe runs are auditable through
 * `lodestar report`.
 *
 * **Scoped-env execution (#114, ADR-0022).** A probe is potentially
 * third-party — the loader treats pack manifests as untrusted — so each
 * probe is spawned with an explicit, minimal environment (a fresh empty
 * HOME + inherited PATH), never the host `process.env`. This denies host
 * secrets to a probe it was not explicitly granted, mirroring the Action
 * Kernel's "no host env to sandboxes" rule. The operator widens the env only
 * via {@link RunPackOptions.allowHostEnv} (an explicit allowlist); the
 * manifest cannot. The spawn also passes `--no-env-file` so `bun run` cannot
 * auto-load a working-directory `.env` back into the probe's `process.env`
 * (which would re-introduce host secrets outside the allowlist). This is a
 * TS/process-level governance boundary, not an OS sandbox — it does not
 * contain filesystem or network reach (the separate longer-term step).
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
  /**
   * The COMPLETE environment each probe subprocess sees. The host `process.env`
   * is NEVER merged in — a probe is potentially third-party (the loader treats
   * pack manifests as untrusted) and must not inherit host secrets. When set,
   * this is passed verbatim and {@link allowHostEnv} is ignored. Tests and
   * hermetic callers use this; the CLI uses {@link allowHostEnv}. (#114, ADR-0022)
   */
  env?: Record<string, string>
  /**
   * Names of host environment variables the **operator** explicitly permits a
   * probe to receive, layered on top of the default scoped env (a fresh empty
   * HOME + inherited PATH). This is the operator-controlled allowlist — the
   * manifest cannot widen it (it is untrusted input), so a hostile pack cannot
   * declare its way to a host secret. A named var that is unset on the host is
   * simply not forwarded. No silent inheritance: anything not listed is absent.
   */
  allowHostEnv?: string[]
}

/**
 * Build the default scoped environment a probe subprocess runs under: a fresh
 * empty HOME (so a probe reads no host dotfiles / per-user credential stores)
 * and PATH inherited (so `bun` and anything it shells to resolve). The host
 * `process.env` is otherwise NOT passed through — denying host secrets to a
 * potentially-third-party probe. Mirrors the Action Kernel's "no host env to
 * sandboxes" rule and the native adapters' `defaultScopedEnv` / `baseGitEnv`.
 *
 * `allowHostEnv` names host vars the operator has explicitly permitted (e.g. a
 * test database URL); each, if set on the host, is forwarded on top of the
 * default. Returns the env plus a `cleanup` that removes the temp HOME — call
 * it once the probe(s) using this env have finished.
 *
 * This is a TS/process-level governance boundary, not an OS sandbox: it denies
 * host environment secrets, not filesystem or network reach. Real OS-level
 * containment is the separate longer-term step (ADR-0022 step 2).
 */
function buildScopedProbeEnv(allowHostEnv?: string[]): {
  env: Record<string, string>
  cleanup: () => void
} {
  const home = mkdtempSync(join(tmpdir(), "lodestar-probe-home-"))
  const env: Record<string, string> = { HOME: home }
  const path = process.env.PATH
  if (path !== undefined) env.PATH = path
  for (const name of allowHostEnv ?? []) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return {
    env,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* best-effort: a leaked temp HOME is harmless */
      }
    },
  }
}

/**
 * Resolve the probe environment for a run. A complete `env` override wins (used
 * verbatim, host env never merged, nothing to clean up); otherwise build the
 * default scoped env plus any operator-allowlisted host vars.
 */
function resolveProbeEnv(options: RunPackOptions): {
  env: Record<string, string>
  cleanup: () => void
} {
  if (options.env !== undefined) {
    return { env: options.env, cleanup: () => {} }
  }
  return buildScopedProbeEnv(options.allowHostEnv)
}

// Per-stream capture cap, in characters (chunks are UTF-8-decoded before
// counting, so this bounds memory, not exact bytes). A probe is
// potentially third-party (the loader treats pack manifests as untrusted)
// and a buggy or hostile one can print without bound; without a cap the
// harness would buffer all of it in memory and could OOM. 256 Ki chars
// per stream is far more than any probe banner needs while keeping a
// runaway probe's footprint bounded.
const MAX_CAPTURE_CHARS = 256 * 1024

/**
 * Accumulates stream output up to a character cap, then drops the
 * remainder and appends a truncation marker. Keeps the runner's memory
 * bounded regardless of how much a probe prints.
 */
class CappedBuffer {
  private readonly chunks: string[] = []
  private size = 0
  private truncated = false
  constructor(private readonly cap: number) {}

  push(chunk: unknown): void {
    if (this.truncated) return
    const s = String(chunk)
    const remaining = this.cap - this.size
    if (s.length <= remaining) {
      this.chunks.push(s)
      this.size += s.length
      return
    }
    if (remaining > 0) this.chunks.push(s.slice(0, remaining))
    this.truncated = true
  }

  toString(): string {
    const body = this.chunks.join("")
    return this.truncated ? `${body}\n…[output truncated at ${this.cap} chars]\n` : body
  }
}

function spawnProbe(
  bun: string,
  probe: LoadedProbe,
  env: Record<string, string>,
): Promise<{ exit_code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // `env` is the COMPLETE environment — host `process.env` is never spread in,
    // so a probe cannot read host secrets it was not explicitly granted (#114).
    // `--no-env-file` is load-bearing: `bun run` otherwise auto-loads `.env` /
    // `.env.local` from the working directory and merges them into the probe's
    // `process.env`, which would repopulate it with host secrets that are NOT in
    // the scoped env / allowlist — defeating the boundary. With it, the scoped
    // `env` is authoritative; the operator's only widening path stays `allowHostEnv`.
    const child = spawn(bun, ["run", "--no-env-file", probe.path], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = new CappedBuffer(MAX_CAPTURE_CHARS)
    const stderr = new CappedBuffer(MAX_CAPTURE_CHARS)
    child.stdout?.on("data", (chunk) => stdout.push(chunk))
    child.stderr?.on("data", (chunk) => stderr.push(chunk))
    // A spawn failure (e.g. `bun` not on PATH) is a probe failure, not a
    // harness crash — resolve with a synthetic non-zero outcome so the
    // pack run completes and reports it like any other failing probe.
    child.on("error", (err) => {
      stderr.push(`failed to spawn probe: ${err.message}\n`)
      resolve({
        exit_code: null,
        signal: null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      })
    })
    child.on("close", (code, signal) => {
      resolve({
        exit_code: code,
        signal: signal ?? null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      })
    })
  })
}

/** Run one probe under an already-resolved scoped env and return its outcome. */
async function executeProbe(
  probe: LoadedProbe,
  bun: string,
  env: Record<string, string>,
): Promise<ProbeRunOutcome> {
  const started_at = new Date().toISOString()
  const start = performance.now()
  const { exit_code, signal, stdout, stderr } = await spawnProbe(bun, probe, env)
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

/** Run a single resolved probe as a subprocess and return its outcome. */
export async function runProbe(
  probe: LoadedProbe,
  options: RunPackOptions = {},
): Promise<ProbeRunOutcome> {
  const bun = options.bun ?? "bun"
  const { env, cleanup } = resolveProbeEnv(options)
  try {
    return await executeProbe(probe, bun, env)
  } finally {
    cleanup()
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
  const bun = options.bun ?? "bun"
  // Resolve the scoped env ONCE per pack run (one temp HOME shared across every
  // probe) and clean it up after, rather than per-probe.
  const { env, cleanup } = resolveProbeEnv(options)
  const outcomes: ProbeRunOutcome[] = []
  try {
    for (const probe of pack.probes) {
      const outcome = await executeProbe(probe, bun, env)
      outcomes.push(outcome)
      if (options.record) await options.record(outcome, pack.manifest.name)
      options.onResult?.(outcome)
    }
  } finally {
    cleanup()
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
