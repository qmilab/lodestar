export const HELP_TEXT = `orrery — the trust layer for AI agents

Usage:
  orrery report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
  orrery guard wrap --target <module> [--project <id>] [--actor <id>]
  orrery action list
  orrery action describe <action-id>
  orrery trace inspect <event-id> [--project <id>] [--session <id>]
  orrery probe <name>
  orrery help

Commands:
  report     Render a markdown trust report for a session (headline command).
  guard      Drive a guarded agent run (programmatic surface for experimentation).
  action     Introspect the registered tool catalogue.
  trace      Debug-grade event-log inspection. Not the user-facing surface;
             prefer 'orrery report'.
  probe      Run a research probe by short name (poison, chain, external,
             quarantine, sensitivity, autoobs, guard-import). Probes are spec,
             not test scaffolding.

Examples:
  orrery report session-1779551238212
  orrery action list
  orrery action describe git.status
  orrery trace inspect <event-id>
  orrery probe chain
`
