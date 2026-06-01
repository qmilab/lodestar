#!/usr/bin/env bun
/**
 * Telenotes governed development — deterministic scripted run (clean path).
 *
 * The Batch 5 primary proving ground. A coding agent, wrapped via the MCP
 * proxy, adds a `clientTag` feature to the Telenotes fixture: it observes the
 * codebase, decides on a plan, edits files, runs tests, commits, and attempts
 * to push (which the policy gate blocks at L4). Every tool call is governed by
 * the Action Kernel and recorded in the epistemic chain.
 *
 * The shared driver lives in `../lib/governed-dev-run.ts`; this entry point is
 * the clean run (no poisoned file). See `../poison-run/` for the firewall
 * demonstration.
 *
 *   bun run examples/telenotes-governed-dev/scripted-run/index.ts
 *
 * The trust report is written to stdout; progress goes to stderr. Capture the
 * committed snapshot with:
 *
 *   bun run examples/telenotes-governed-dev/scripted-run/index.ts \
 *     > examples/telenotes-governed-dev/reports/scripted-run.report.md
 */

import { resolve } from "node:path"
import { runGovernedDevDemo } from "../lib/governed-dev-run.js"

const result = await runGovernedDevDemo({
  exampleDir: resolve(import.meta.dirname, ".."),
  projectId: "telenotes-governed-dev",
  actorId: "agent:claude-code",
})

process.stdout.write(`${result.report}\n`)
process.stderr.write(
  `[telenotes] done. Re-render any time with:\n  bun run lodestar report ${result.sessionId} --project telenotes-governed-dev --log-root ${result.logRoot}\n`,
)
