#!/usr/bin/env bun
/**
 * `lodestar-report` — standalone CLI binary for `@qmilab/lodestar-trace`.
 *
 * Typically invoked via `lodestar report <session-id>` (the unified CLI
 * in `@qmilab/lodestar-cli` dispatches here). Provided as its own bin so the
 * trace package is self-contained.
 *
 * Usage:
 *   lodestar-report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
 *
 * Exit codes:
 *   0 — report written
 *   2 — usage error
 *   3 — no events found for the requested session
 */

import { writeFile } from "node:fs/promises"
import { defaultLogRoot, loadSessionEvents } from "./load"
import { projectChain } from "./chain"
import { renderReport } from "./report"

interface ParsedArgs {
  session_id?: string
  project_id?: string
  log_root: string
  out?: string
  raw_event_limit: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    log_root: defaultLogRoot(),
    raw_event_limit: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--project" || arg === "-p") {
      out.project_id = argv[++i]
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) out.log_root = next
    } else if (arg === "--out" || arg === "-o") {
      out.out = argv[++i]
    } else if (arg === "--raw-events") {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN
      out.raw_event_limit = Number.isFinite(parsed) ? parsed : 0
    } else if (arg && !arg.startsWith("-") && !out.session_id) {
      out.session_id = arg
    }
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.session_id) {
    process.stderr.write(
      "usage: lodestar-report <session-id> [--project <id>] [--log-root <path>] [--out <file>] [--raw-events <n>]\n",
    )
    return 2
  }

  const loaded = await loadSessionEvents({
    logRoot: args.log_root,
    session_id: args.session_id,
    project_id: args.project_id,
  })

  if (loaded.events.length === 0) {
    process.stderr.write(
      `no events found for session '${args.session_id}' under '${args.log_root}'\n`,
    )
    return 3
  }

  const projection = projectChain(loaded.events, {
    session_id: args.session_id,
    project_id: loaded.project_id,
  })

  const renderOptions =
    args.raw_event_limit > 0 ? { raw_event_limit: args.raw_event_limit } : {}
  const report = renderReport(projection, renderOptions)

  if (args.out) {
    await writeFile(args.out, `${report}\n`, "utf8")
    process.stderr.write(`wrote ${report.length} bytes to ${args.out}\n`)
  } else {
    process.stdout.write(`${report}\n`)
  }
  return 0
}

const code = await main()
process.exit(code)
