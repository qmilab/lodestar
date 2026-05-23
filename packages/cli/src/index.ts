#!/usr/bin/env bun
/**
 * orrery — command-line interface
 *
 * Reorganised in Batch 2 around the four developer-facing surfaces
 * (Guard, Trace, Action Kernel, Harness). The headline command is
 * `orrery report <session-id>`; everything else is structured under
 * area prefixes so the help output stays scannable.
 *
 * Some adapters (fs.read, git.status) are registered at module load
 * so `orrery action list` and `orrery action describe` produce useful
 * output without first running a session. The host project root is the
 * CWD.
 *
 * Usage:
 *   orrery report <session-id> ...           (headline command)
 *   orrery guard wrap --target <module> ...  (programmatic)
 *   orrery action list
 *   orrery action describe <action-id>
 *   orrery trace inspect <event-id> ...      (debug)
 *   orrery probe <name>
 *   orrery help
 */

import { registerFsReadTool } from "@orrery/adapter-filesystem"
import { registerGitStatusTool } from "@orrery/adapter-git"
import { actionDescribeCommand, actionListCommand } from "./commands/action"
import { guardWrapCommand } from "./commands/guard"
import { HELP_TEXT } from "./commands/help"
import { probeCommand } from "./commands/probe"
import { reportCommand } from "./commands/report"
import { traceInspectCommand } from "./commands/trace"

// Register the v0 tool set bound to the current working directory so
// the introspection commands have something to show. Guard-driven
// sessions register their own tools.
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

const argv = process.argv.slice(2)
const [command, sub, ...rest] = argv

async function dispatch(): Promise<number> {
  switch (command) {
    case "report":
      return reportCommand(sub === undefined ? [] : [sub, ...rest])

    case "guard":
      if (sub === "wrap") return guardWrapCommand(rest)
      process.stderr.write("usage: orrery guard wrap --target <module>\n")
      return 2

    case "action":
      if (sub === "list") return actionListCommand()
      if (sub === "describe") return actionDescribeCommand(rest)
      process.stderr.write("usage: orrery action list | orrery action describe <action-id>\n")
      return 2

    case "trace":
      if (sub === "inspect") return traceInspectCommand(rest)
      process.stderr.write("usage: orrery trace inspect <event-id>\n")
      return 2

    case "probe":
      return probeCommand(sub === undefined ? [] : [sub, ...rest])

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
