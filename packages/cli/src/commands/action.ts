import { listTools, lookupTool } from "@qmilab/lodestar-action-kernel"

/**
 * `orrery action list`
 *
 * Lists registered tools with their trust level, sandbox, and
 * declared permissions.
 */
export function actionListCommand(): number {
  const tools = listTools()
  if (tools.length === 0) {
    process.stderr.write("no tools registered. did the host bind any adapters?\n")
    return 0
  }
  const widthName = Math.max(...tools.map((n) => n.length), "name".length)
  const header = `${pad("name", widthName)}  level  sandbox             permissions`
  process.stdout.write(`${header}\n`)
  process.stdout.write(`${"-".repeat(header.length)}\n`)
  for (const name of tools) {
    const tool = lookupTool(name)
    if (!tool) continue
    process.stdout.write(
      `${pad(name, widthName)}  L${tool.required_trust_level}     ` +
        `${pad(tool.sandbox, 18)}  ${tool.permissions.join(", ")}\n`,
    )
  }
  return 0
}

/**
 * `orrery action describe <action-id>`
 *
 * Describes one registered tool by name (the CLI uses "action-id" for
 * the tool's namespace.name key).
 */
export function actionDescribeCommand(argv: string[]): number {
  const name = argv[0]
  if (!name) {
    process.stderr.write("usage: orrery action describe <action-id>\n")
    return 2
  }
  const tool = lookupTool(name)
  if (!tool) {
    process.stderr.write(
      `unknown action '${name}'. run 'orrery action list' to see what is registered.\n`,
    )
    return 3
  }

  const out = {
    name: tool.name,
    output_schema_key: tool.output_schema_key,
    required_trust_level: tool.required_trust_level,
    sandbox: tool.sandbox,
    permissions: tool.permissions,
    reversibility: tool.reversibility,
    effects: tool.effects,
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  return 0
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s
  return s + " ".repeat(width - s.length)
}
