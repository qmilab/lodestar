import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { EventLogReader } from "@qmilab/lodestar-event-log"
import { defaultLogRoot, describeEvent, findEventById } from "@qmilab/lodestar-trace"

/**
 * `lodestar trace inspect <event-id> [--project <id>] [--session <id>] [--log-root <path>]`
 *
 * Debug-grade event inspection. The user-facing command is
 * `lodestar report`; this exists for developers who need to look at a
 * specific envelope by id.
 */
export async function traceInspectCommand(argv: string[]): Promise<number> {
  let event_id: string | undefined
  let project_id: string | undefined
  let session_id: string | undefined
  let log_root = defaultLogRoot()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--project" || arg === "-p") {
      project_id = argv[++i]
    } else if (arg === "--session" || arg === "-s") {
      session_id = argv[++i]
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg && !arg.startsWith("-") && !event_id) {
      event_id = arg
    }
  }

  if (!event_id) {
    process.stderr.write(
      "usage: lodestar trace inspect <event-id> [--project <id>] [--session <id>] [--log-root <path>]\n",
    )
    return 2
  }

  if (!existsSync(log_root)) {
    process.stderr.write(`log root '${log_root}' does not exist.\n`)
    return 3
  }

  const reader = new EventLogReader(log_root)
  const projects = project_id
    ? [project_id]
    : (await readdir(log_root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)

  for (const project of projects) {
    if (!existsSync(join(log_root, project))) continue
    const events = session_id
      ? await reader.readSession(project, session_id)
      : await reader.readAll(project)
    const found = findEventById(events, event_id)
    if (found) {
      process.stdout.write(`${describeEvent(found)}\n`)
      return 0
    }
  }

  process.stderr.write(`no event with id '${event_id}' found under '${log_root}'.\n`)
  return 3
}
