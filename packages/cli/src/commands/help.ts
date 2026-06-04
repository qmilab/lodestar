export const HELP_TEXT = `lodestar — the trust layer for AI agents

Usage:
  lodestar report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
  lodestar guard wrap --target <module> [--project <id>] [--actor <id>]
  lodestar guard mcp-proxy --config <path>
  lodestar approve list --project <id> [--log-root <path>]
  lodestar approve grant <request-id> --approver <id> --project <id>
  lodestar approve deny  <request-id> --approver <id> --project <id>
  lodestar action list
  lodestar action describe <action-id>
  lodestar trace inspect <event-id> [--project <id>] [--session <id>]
  lodestar probe <name>
  lodestar harness run [--pack <name|path>] [--log-root <path>] [--no-record]
  lodestar harness list [--pack <name|path>]
  lodestar reflect <session-id> [--since-seq <n>] [--trigger <name>] [--json]
  lodestar help

Commands:
  report     Render a markdown trust report for a session (headline command).
  guard      Wrap an agent run. Two modes:
               wrap       — programmatic; loads a JS/TS loop module.
               mcp-proxy  — stdio MCP proxy; wrap any MCP-speaking agent
                            (Claude Code, Cursor, Aider).
  approve    Resolve an action the MCP proxy is holding for approval. Lists
             pending requests (list) and writes a grant/deny to the proxy's
             side-channel. The reference resolver that keeps the solo workflow
             ungated — local, no account.
  action     Introspect the registered tool catalogue.
  trace      Debug-grade event-log inspection. Not the user-facing surface;
             prefer 'lodestar report'.
  probe      Run a single probe by short name (poison, chain, external,
             quarantine, sensitivity, autoobs, guard-import). Probes are spec,
             not test scaffolding.
  harness    Drive a whole probe pack. Two modes:
               run   — run every probe in a pack; records each run as a
                       synthetic observation so the run is itself auditable.
               list  — inspect a pack's manifest without executing anything.
  reflect    Dry-run a reflection pass over a session's event log: print the
             typed proposals reflection would produce. Applying is the host's
             job (Guard / the MCP proxy own the live firewall).

Examples:
  lodestar report session-1779551238212
  lodestar guard mcp-proxy --config ./lodestar-mcp-proxy.config.json
  lodestar approve list --project my-project
  lodestar approve grant 7f3c… --approver me --project my-project
  lodestar action list
  lodestar action describe git.status
  lodestar trace inspect <event-id>
  lodestar probe chain
  lodestar harness run --pack lodestar-core
  lodestar harness list
  lodestar reflect session-1779551238212
`
