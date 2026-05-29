/**
 * The Probe authoring surface.
 *
 * The 17 first-party probes in `packs/lodestar-core/` predate this class
 * and are *not* rewritten to use it — probes are spec, not scaffolding
 * (see the package CLAUDE.md). They remain standalone scripts that print
 * a banner and `process.exit(1)` on failure. This module exists so that
 * *new* probes can declare themselves once and get that exact contract
 * for free, instead of re-deriving the banner-and-exit boilerplate each
 * one currently hand-rolls.
 *
 * The runner executes probe *files* as subprocesses and reads their exit
 * code — it never imports a `Probe`. So a probe authored through this
 * class is indistinguishable to the runner from a hand-written one: both
 * are `bun run`-able files that exit 0 on pass and non-zero on fail.
 * `runProbeAsScript()` is the bridge that upholds that contract.
 */

/**
 * The outcome of one probe execution. `details` are human-readable lines
 * explaining what was asserted and observed — printed under the status
 * banner and surfaced by the runner when a probe fails.
 */
export interface ProbeResult {
  passed: boolean
  details: string[]
}

/**
 * A probe declaration: a stable name, a threat-model description, and the
 * assertion body. `run` may be sync or async and returns a {@link ProbeResult}.
 */
export interface ProbeSpec {
  /** Stable identifier; should match the probe's manifest entry name. */
  readonly name: string
  /** What invariant this probe defends and the attack it models. */
  readonly description: string
  run(): Promise<ProbeResult> | ProbeResult
}

/**
 * Optional base class for class-style probes. Equivalent to authoring a
 * {@link ProbeSpec} object literal — use whichever reads better. Subclass
 * and implement `name`, `description`, and `run()`.
 */
export abstract class Probe implements ProbeSpec {
  abstract readonly name: string
  abstract readonly description: string
  abstract run(): Promise<ProbeResult> | ProbeResult
}

const RULE = "─".repeat(72)

/**
 * Render a probe result as the canonical banner the first-party probes
 * print. Pure (returns a string); kept separate from I/O so it can be
 * unit-tested without capturing stdout.
 */
export function formatProbeReport(name: string, result: ProbeResult): string {
  const lines = [
    RULE,
    `probe: ${name}`,
    RULE,
    `status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`,
    ...result.details.map((d) => `  ${d}`),
    RULE,
  ]
  return lines.join("\n")
}

/**
 * Run a probe as a standalone script: execute it, print the banner, and
 * exit non-zero on failure. This is the entry point a probe file calls at
 * top level so that `bun run <probe>.ts` upholds the exit-code contract
 * the runner depends on.
 *
 * A thrown error (e.g. a setup precondition that could not be met) is
 * treated as a failure, not a crash, so the runner still records a clean
 * fail rather than an opaque non-zero exit.
 */
export async function runProbeAsScript(probe: ProbeSpec): Promise<never> {
  let result: ProbeResult
  try {
    result = await probe.run()
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    result = { passed: false, details: ["probe threw before producing a result:", message] }
  }
  process.stdout.write(`${formatProbeReport(probe.name, result)}\n`)
  process.exit(result.passed ? 0 : 1)
}
