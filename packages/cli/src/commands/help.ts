export const HELP_TEXT = `lodestar — the trust layer for AI agents

Usage:
  lodestar report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
  lodestar guard wrap --target <module> [--project <id>] [--actor <id>]
  lodestar guard mcp-proxy --config <path>
  lodestar action list
  lodestar action describe <action-id>
  lodestar trace inspect <event-id> [--project <id>] [--session <id>]
  lodestar probe <name>
  lodestar help

Commands:
  report     Render a markdown trust report for a session (headline command).
  guard      Wrap an agent run. Two modes:
               wrap       — programmatic; loads a JS/TS loop module.
               mcp-proxy  — stdio MCP proxy; wrap any MCP-speaking agent
                            (Claude Code, Cursor, Aider).
  action     Introspect the registered tool catalogue.
  trace      Debug-grade event-log inspection. Not the user-facing surface;
             prefer 'lodestar report'.
  probe      Run a research probe by short name (poison, chain, external,
             quarantine, sensitivity, autoobs, guard-import). Probes are spec,
             not test scaffolding.

Examples:
  lodestar report session-1779551238212
  lodestar guard mcp-proxy --config ./lodestar-mcp-proxy.config.json
  lodestar action list
  lodestar action describe git.status
  lodestar trace inspect <event-id>
  lodestar probe chain
`
