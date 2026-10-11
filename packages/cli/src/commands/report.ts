import { writeFile } from "node:fs/promises"
import { type Sensitivity, isSensitivity } from "@qmilab/lodestar-core"
import {
  defaultLogRoot,
  loadSessionEvents,
  projectChain,
  renderReport,
  renderTaintSet,
  taintSet,
} from "@qmilab/lodestar-trace"

/**
 * `lodestar report <session-id> [--project <id>] [--log-root <path>] [--out <file>]`
 *
 * Headline user-facing command. Loads events for the given session
 * from the log root, projects them into the epistemic chain, and
 * renders a markdown trust report.
 */
export async function reportCommand(argv: string[]): Promise<number> {
  let session_id: string | undefined
  let project_id: string | undefined
  let log_root = defaultLogRoot()
  let out: string | undefined
  let raw_event_limit = 0
  let taint: string | undefined
  let ceiling: Sensitivity | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--project" || arg === "-p") {
      project_id = argv[++i]
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg === "--out" || arg === "-o") {
      out = argv[++i]
    } else if (arg === "--taint") {
      taint = argv[++i] ?? ""
    } else if (arg === "--sensitivity-ceiling") {
      const next = argv[++i]
      if (!isSensitivity(next)) {
        process.stderr.write(`invalid --sensitivity-ceiling: ${JSON.stringify(next)}\n`)
        return 2
      }
      ceiling = next
    } else if (arg === "--raw-events") {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN
      raw_event_limit = Number.isFinite(parsed) ? parsed : 0
    } else if (arg && !arg.startsWith("-") && !session_id) {
      session_id = arg
    }
  }

  if (!session_id) {
    process.stderr.write(
      "usage: lodestar report <session-id> [--project <id>] [--log-root <path>] [--out <file>] [--raw-events <n>] [--taint <belief-id> [--sensitivity-ceiling <level>]]\n",
    )
    return 2
  }

  const loaded = await loadSessionEvents({
    logRoot: log_root,
    session_id,
    project_id,
  })
  if (loaded.events.length === 0) {
    process.stderr.write(`no events found for session '${session_id}' under '${log_root}'\n`)
    return 3
  }

  if (taint !== undefined) {
    if (!taint) {
      process.stderr.write("--taint requires a belief id\n")
      return 2
    }
    const set = taintSet(loaded.events, taint, ceiling ? { sensitivityCeiling: ceiling } : {})
    const md = renderTaintSet(set)
    if (out) {
      await writeFile(out, `${md}\n`, "utf8")
      process.stderr.write(`wrote ${md.length} bytes to ${out}\n`)
    } else {
      process.stdout.write(`${md}\n`)
    }
    return 0
  }

  const projection = projectChain(loaded.events, {
    session_id,
    project_id: loaded.project_id,
  })

  const renderOptions = raw_event_limit > 0 ? { raw_event_limit } : {}
  const markdown = renderReport(projection, renderOptions)

  if (out) {
    await writeFile(out, `${markdown}\n`, "utf8")
    process.stderr.write(`wrote ${markdown.length} bytes to ${out}\n`)
  } else {
    process.stdout.write(`${markdown}\n`)
  }
  return 0
}
