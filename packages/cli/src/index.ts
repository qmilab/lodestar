#!/usr/bin/env bun
/**
 * lodestar — command-line interface
 *
 * Reorganised in Batch 2 around the four developer-facing surfaces
 * (Guard, Trace, Action Kernel, Harness). The headline command is
 * `lodestar report <session-id>`; everything else is structured under
 * area prefixes so the help output stays scannable.
 *
 * Usage:
 *   lodestar report <session-id> ...           (headline command)
 *   lodestar guard wrap --target <module> ...  (programmatic)
 *   lodestar action list
 *   lodestar action describe <action-id>
 *   lodestar trace inspect <event-id> ...      (debug)
 *   lodestar probe <name>
 *   lodestar help
 */

import { registerFsReadTool } from "@qmilab/lodestar-adapter-filesystem"
import { registerGitStatusTool } from "@qmilab/lodestar-adapter-git"
import { actionDescribeCommand, actionListCommand } from "./commands/action.js"
import { approveCommand } from "./commands/approve.js"
import { guardMCPProxyCommand } from "./commands/guard-mcp.js"
import { guardWrapCommand } from "./commands/guard.js"
import { harnessCommand } from "./commands/harness.js"
import { HELP_TEXT } from "./commands/help.js"
import { otelCommand } from "./commands/otel.js"
import { packCommand } from "./commands/pack.js"
import { probeCommand } from "./commands/probe.js"
import { reflectCommand } from "./commands/reflect.js"
import { reportCommand } from "./commands/report.js"
import { shipCommand } from "./commands/ship.js"
import { traceInspectCommand } from "./commands/trace.js"
import { viewCommand } from "./commands/view.js"

/**
 * Pre-register the v0 built-in tools (fs.read, git.status) bound to
 * the current working directory. Called only by commands that need a
 * populated registry without first running a guarded session — namely
 * `lodestar action list` and `lodestar action describe`.
 *
 * Other commands (notably `lodestar guard wrap`) must NOT eagerly
 * register, because the target module being loaded typically calls
 * the same `registerFsReadTool` / `registerGitStatusTool` itself; the
 * action-kernel registry rejects duplicate names, which would make
 * the most common target shape fail to import.
 */
function registerBuiltinTools(): void {
  try {
    registerFsReadTool(process.cwd())
  } catch {
    // Already registered — fine (the registry refuses duplicates).
  }
  try {
    registerGitStatusTool(process.cwd())
  } catch {
    // Already registered — fine.
  }
}

const argv = process.argv.slice(2)
const [command, sub, ...rest] = argv

async function dispatch(): Promise<number> {
  switch (command) {
    case "report":
      return reportCommand(sub === undefined ? [] : [sub, ...rest])

    case "view":
      return viewCommand(sub === undefined ? [] : [sub, ...rest])

    case "otel":
      return otelCommand(sub === undefined ? [] : [sub, ...rest])

    case "ship":
      return shipCommand(sub === undefined ? [] : [sub, ...rest])

    case "guard":
      if (sub === "wrap") return guardWrapCommand(rest)
      if (sub === "mcp-proxy") return guardMCPProxyCommand(rest)
      process.stderr.write(
        "usage: lodestar guard wrap --target <module>\n" +
          "       lodestar guard mcp-proxy --config <path>\n",
      )
      return 2

    case "action":
      registerBuiltinTools()
      if (sub === "list") return actionListCommand()
      if (sub === "describe") return actionDescribeCommand(rest)
      process.stderr.write("usage: lodestar action list | lodestar action describe <action-id>\n")
      return 2

    case "approve":
      return approveCommand(sub === undefined ? [] : [sub, ...rest])

    case "trace":
      if (sub === "inspect") return traceInspectCommand(rest)
      process.stderr.write("usage: lodestar trace inspect <event-id>\n")
      return 2

    case "probe":
      return probeCommand(sub === undefined ? [] : [sub, ...rest])

    case "harness":
      return harnessCommand(sub === undefined ? [] : [sub, ...rest])

    case "pack":
      return packCommand(sub === undefined ? [] : [sub, ...rest])

    case "reflect":
      return reflectCommand(sub === undefined ? [] : [sub, ...rest])

    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP_TEXT)
      return 0

    default:
      process.stderr.write(`unknown command: ${command}\n`)
      process.stdout.write(HELP_TEXT)
      return 2
  }
}

const code = await dispatch()
process.exit(code)
