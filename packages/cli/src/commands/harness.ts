import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type PackRunResult,
  ProbePackError,
  buildCalibrationComputedPayload,
  calibrate,
  calibrationCursor,
  eventLogCalibrationSink,
  eventLogRecorder,
  formatCalibrationReport,
  loadProbePack,
  runPack,
} from "@qmilab/lodestar-harness"
import { defaultLogRoot, loadSessionEvents } from "@qmilab/lodestar-trace"

/**
 * `lodestar harness run --pack <name|path>`
 * `lodestar harness list --pack <name|path>`
 *
 * The harness developer surface. `run` drives every probe in a pack as a
 * subprocess and reports the aggregate result; `list` inspects a pack's
 * manifest without executing anything. This is the runner that replaces
 * the hand-chained `probes:all` script.
 *
 * `--pack` accepts a first-party pack name (resolved by walking up to
 * `packs/<name>/`, the same strategy `lodestar probe` uses), a path to a
 * pack directory, or a path to a manifest file. It defaults to the
 * first-party `lodestar-core` pack.
 */

const RULE = "─".repeat(72)

/**
 * Resolve a `--pack` argument to a path `loadProbePack` understands.
 * A bare name (no separator) is treated as a first-party pack and looked
 * up under `packs/<name>/`; anything else is a filesystem path.
 */
/**
 * A bare `--pack` name (no path separator) is a first-party in-repo pack looked
 * up under `packs/<name>/`. Those ship unsigned in v0 (signing them is the
 * publish CLI's job, #90), so the harness loads them with an explicit
 * `allowUnsigned: true`. A path-based `--pack` is potentially external and gets
 * no such default — it must be signed, or the operator must pass `--allow-unsigned`.
 */
function isBareFirstPartyName(packArg: string): boolean {
  return !packArg.includes("/") && !packArg.includes("\\") && !packArg.startsWith(".")
}

function resolvePackTarget(packArg: string): string {
  const looksLikePath = packArg.includes("/") || packArg.includes("\\") || packArg.startsWith(".")
  if (looksLikePath) return resolve(process.cwd(), packArg)

  // Bare name → first-party pack. Walk up from this file so the lookup
  // works from any cwd and from an installed CLI, not just the repo root.
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = resolve(dir, "packs", packArg)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fall back to a cwd-relative `packs/<name>` so repo-root callers work
  // even if the bin was relocated; if it's missing, loadProbePack reports it.
  return resolve(process.cwd(), "packs", packArg)
}

const USAGE =
  "usage: lodestar harness run      [--pack <name|path>] [--log-root <path>] [--no-record]\n" +
  "                                  [--allow-unsigned]\n" +
  "       lodestar harness list     [--pack <name|path>] [--allow-unsigned]\n" +
  "       lodestar harness calibrate <session-id> [--project <id>] [--log-root <path>]\n" +
  "                                  [--actor <id>] [--no-emit] [--out <file>]\n"

const CALIBRATE_USAGE =
  "usage: lodestar harness calibrate <session-id> [--project <id>] [--log-root <path>]\n" +
  "                                  [--actor <id>] [--no-emit] [--out <file>]\n"

/** A malformed invocation (missing flag value, unknown flag). Maps to exit 2. */
class UsageError extends Error {
  override readonly name = "UsageError"
}

/**
 * Read the value for a value-taking flag. A value that is missing or that
 * looks like another flag (`--actor --no-emit`) is almost always a forgotten
 * argument — consuming it silently would bind a flag name as the value and
 * leave the swallowed flag unapplied (e.g. a `--no-emit` dry-run that records
 * after all), so reject it loudly. Shared by every harness subcommand parser.
 */
function takeFlagValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`flag ${flag} requires a value`)
  }
  return value
}

interface ParsedFlags {
  pack: string
  logRoot: string
  project: string
  session: string
  actor: string
  record: boolean
  allowUnsigned: boolean
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    pack: "lodestar-core",
    logRoot: resolve(process.cwd(), ".lodestar", "events"),
    project: "harness",
    session: `harness-${randomUUID()}`,
    actor: "lodestar-harness",
    record: true,
    allowUnsigned: false,
  }
  const takeValue = (i: number, flag: string): string => takeFlagValue(argv, i, flag)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--pack":
        flags.pack = takeValue(i, arg)
        i++
        break
      case "--log-root":
        flags.logRoot = resolve(process.cwd(), takeValue(i, arg))
        i++
        break
      case "--project":
        flags.project = takeValue(i, arg)
        i++
        break
      case "--session":
        flags.session = takeValue(i, arg)
        i++
        break
      case "--actor":
        flags.actor = takeValue(i, arg)
        i++
        break
      case "--no-record":
        flags.record = false
        break
      case "--allow-unsigned":
        flags.allowUnsigned = true
        break
      default:
        throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return flags
}

async function harnessRun(argv: string[]): Promise<number> {
  let flags: ParsedFlags
  try {
    flags = parseFlags(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE}`)
      return 2
    }
    throw err
  }
  const target = resolvePackTarget(flags.pack)

  let pack: Awaited<ReturnType<typeof loadProbePack>>
  try {
    pack = await loadProbePack(target, {
      allowUnsigned: flags.allowUnsigned || isBareFirstPartyName(flags.pack),
    })
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }

  process.stdout.write(
    `harness: running pack '${pack.manifest.name}' (${pack.probes.length} probe${
      pack.probes.length === 1 ? "" : "s"
    })\n\n`,
  )

  const record = flags.record
    ? eventLogRecorder({
        root: flags.logRoot,
        project_id: flags.project,
        session_id: flags.session,
        actor_id: flags.actor,
      })
    : undefined

  const result = await runPack(pack, {
    record,
    onResult: (o) => {
      const mark = o.passed ? "✓" : "✗"
      process.stdout.write(`  ${mark} ${o.name.padEnd(46)} ${o.duration_ms}ms\n`)
    },
  })

  printSummary(result, flags)
  return result.ok ? 0 : 1
}

function printSummary(result: PackRunResult, flags: ParsedFlags): void {
  const secs = (result.duration_ms / 1000).toFixed(1)
  process.stdout.write(
    `\n${result.total} probe${result.total === 1 ? "" : "s"}: ${result.passed} passed, ${
      result.failed
    } failed  (${secs}s)\n`,
  )
  if (flags.record) {
    process.stdout.write(
      `recorded ${result.total} run${result.total === 1 ? "" : "s"} → ${flags.logRoot} (session ${flags.session})\n`,
    )
  }

  const failures = result.outcomes.filter((o) => !o.passed)
  if (failures.length > 0) {
    process.stdout.write(`\n${RULE}\nfailures\n${RULE}\n`)
    for (const f of failures) {
      const reason = f.signal !== null ? `signal ${f.signal}` : `exit ${f.exit_code ?? "?"}`
      process.stdout.write(`\n✗ ${f.name} (${reason})\n`)
      const output = `${f.stdout}${f.stderr}`.trimEnd()
      if (output) {
        for (const line of output.split("\n")) process.stdout.write(`  ${line}\n`)
      }
    }
  }
}

async function harnessList(argv: string[]): Promise<number> {
  let flags: ParsedFlags
  try {
    flags = parseFlags(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE}`)
      return 2
    }
    throw err
  }
  const target = resolvePackTarget(flags.pack)

  let pack: Awaited<ReturnType<typeof loadProbePack>>
  try {
    pack = await loadProbePack(target, {
      allowUnsigned: flags.allowUnsigned || isBareFirstPartyName(flags.pack),
    })
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }

  const m = pack.manifest
  process.stdout.write(
    `pack: ${m.name}  v${m.version}  (spec ${m.spec_version}, source ${m.source_type})\n`,
  )
  if (m.description) process.stdout.write(`${m.description}\n`)
  process.stdout.write(`coverage: ${m.coverage_areas.join(", ")}\n`)
  process.stdout.write(`invariants: ${m.invariants.join(", ")}\n`)
  process.stdout.write(`\nprobes (${pack.probes.length}):\n`)
  for (const p of pack.probes) {
    process.stdout.write(`  ${p.name.padEnd(46)} ${p.file}\n`)
  }
  if (pack.sentinels.length > 0) {
    process.stdout.write(`\nsentinels (${pack.sentinels.length}):\n`)
    for (const s of pack.sentinels) {
      process.stdout.write(`  ${s.id}\n`)
    }
  }
  return 0
}

/**
 * `lodestar harness calibrate <session-id> [--project <id>] [--no-emit] [--out <file>]`
 *
 * The calibrator's publish step. Reads a session's events, runs the
 * (measure-only) `calibrate()`, prints the markdown report, and — unless
 * `--no-emit` — records the verdict as a durable `calibration.computed@1`
 * event so calibration drift is auditable and replayable (ADR-0011). The
 * calibrator itself never writes; emission is this separate step, the same
 * measure/record split the sentinels follow.
 */
async function harnessCalibrate(argv: string[]): Promise<number> {
  let session: string | undefined
  let project: string | undefined
  let logRoot = defaultLogRoot()
  let actor: string | undefined
  let out: string | undefined
  let emit = true

  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      switch (arg) {
        case "--project":
          project = takeFlagValue(argv, i, arg)
          i++
          break
        case "--log-root":
          logRoot = resolve(process.cwd(), takeFlagValue(argv, i, arg))
          i++
          break
        case "--actor":
          actor = takeFlagValue(argv, i, arg)
          i++
          break
        case "--out":
          out = takeFlagValue(argv, i, arg)
          i++
          break
        case "--no-emit":
          emit = false
          break
        default:
          if (arg && !arg.startsWith("-") && !session) {
            session = arg
            break
          }
          throw new UsageError(`unknown argument: ${arg}`)
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${CALIBRATE_USAGE}`)
      return 2
    }
    throw err
  }

  if (!session) {
    process.stderr.write(CALIBRATE_USAGE)
    return 2
  }

  const loaded = await loadSessionEvents({ logRoot, session_id: session, project_id: project })
  if (loaded.events.length === 0) {
    process.stderr.write(`no events found for session '${session}' under '${logRoot}'\n`)
    return 3
  }

  const report = calibrate(loaded.events)
  const markdown = formatCalibrationReport(report, { title: `calibration — session ${session}` })
  if (out) {
    await writeFile(out, `${markdown}\n`, "utf8")
    process.stderr.write(`wrote ${markdown.length} bytes to ${out}\n`)
  } else {
    process.stdout.write(`${markdown}\n`)
  }

  if (!emit) {
    process.stderr.write("calibration computed (not recorded — --no-emit)\n")
    return 0
  }

  // The highest-seq event is the "computed as of" anchor — one meaningful
  // causal parent rather than every event the pass read. The cursor is the
  // precise replay key (re-run calibrate over the window → same report).
  const anchor = loaded.events.reduce((a, b) => (b.seq > a.seq ? b : a))
  const payload = buildCalibrationComputedPayload({
    report,
    cursor: calibrationCursor(loaded.events),
    computed_at: new Date().toISOString(),
    triggered_by: "cli",
  })
  const sink = eventLogCalibrationSink({ root: logRoot, actor_id: actor })
  const eventId = await sink({
    project_id: loaded.project_id,
    session_id: session,
    payload,
    causal_parent_ids: [anchor.id],
  })
  process.stderr.write(
    `recorded calibration.computed@1 (${payload.computation_id}) → ${logRoot} ` +
      `(session ${session}, event ${eventId}, ${report.flagged_classes.length} flagged)\n`,
  )
  return 0
}

export async function harnessCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === "run") return harnessRun(rest)
  if (sub === "list") return harnessList(rest)
  if (sub === "calibrate") return harnessCalibrate(rest)
  process.stderr.write(USAGE)
  return 2
}
