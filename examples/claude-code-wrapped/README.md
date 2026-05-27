# Example — `claude-code-wrapped`

End-to-end demonstration of the Batch 3 MCP proxy. A stand-in
MCP-speaking agent drives a small "coding task" against a sandboxed
filesystem MCP server with Lodestar's proxy in the middle. Every tool
call passes through the Action Kernel; every result through the
Cognitive Core. The resulting event log renders into a trust report.

## What it shows

The proxy in the middle:

- forwards three tool calls from the stand-in agent through to the
  downstream filesystem MCP server,
- records each call as a Lodestar `Action` with a real
  `session_id`/`project_id` propagated end-to-end (no stubs — Round 5
  invariant),
- ingests each `CallToolResult` as an `Observation` carrying the
  `mcp.tool_result@1` schema,
- emits two kinds of `Claim` per tool call — an envelope claim (the
  fact that the tool was called, treated as `tool_result` quality
  evidence) and a content claim (the text inside the result, treated
  as `external_document` quality),
- adopts the envelope claim as a Belief at `truth_status: supported`
  (strong evidence) and the content claim at `truth_status:
  unverified` (the Round 5 auto-observation gate refuses to
  silently promote a document-content claim regardless of its
  apparent strength).

The third tool call reads a file (`workspace/notes.md`) that has been
deliberately poisoned with prompt-injection content. The trust report
shows the hostile text preserved verbatim — the trust layer's job is
to record what crossed the boundary — but the resulting belief stays
at `truth_status: unverified`. The injection lands in the log; it
does not silently land in the agent's belief store.

This is the core wrap-an-agent demonstration:

```
┌──────────────┐ stdio MCP ┌─────────────────┐ stdio MCP ┌──────────────────┐
│ Stand-in     │──────────▶│ lodestar-guard- │──────────▶│ @modelcontext-   │
│ MCP agent    │           │ mcp proxy       │           │ protocol/server- │
│ (index.ts)   │◀──────────│ • Action Kernel │◀──────────│ filesystem       │
│              │           │ • Cog. Core     │           │ (downstream)     │
└──────────────┘           │ • Event Log     │           └──────────────────┘
                           └─────────────────┘
                                    │
                                    ▼
                          .lodestar/events/*.ndjson
                                    │
                                    ▼
                            lodestar report
```

In production, a real agent (Claude Code, Cursor, Aider) replaces the
stand-in: configure the agent's MCP server list to spawn `lodestar
guard mcp-proxy --config <path>` and the same pipeline runs unchanged.

## Run it

```bash
bun run examples/claude-code-wrapped/index.ts
```

The example writes its event log to
`examples/claude-code-wrapped/.lodestar/events/`. The trust report is
printed to stdout at the end; render it again any time with:

```bash
bun run packages/cli/src/index.ts report <session-id> \
  --project claude-code-wrapped \
  --log-root examples/claude-code-wrapped/.lodestar/events
```

## What's in `workspace/`

- `README.md` — ordinary text, just a project description.
- `notes.md` — appears at first glance to be ordinary engineering
  notes, but contains a `[SYSTEM-PRIORITY MESSAGE]` block planted to
  demonstrate prompt-injection content. The injection-defense probe
  (`research/probes/mcp-proxy-injection-defense.ts`) covers the same
  threat model in tighter assertion form.

## Where this example deviates from a production wrap-an-agent setup

The stand-in agent (`index.ts`) drives the proxy in-process via
`proxy.handleCallTool(...)` rather than spawning a real Claude Code
subprocess. That keeps the demo deterministic and screenshot-able for
this batch. The proxy's _downstream_ side still uses a real
subprocess (`bunx @modelcontextprotocol/server-filesystem`), so the
most failure-prone bit of the architecture — stdio MCP between two
real processes — is exercised here.

A future revision can swap the in-process driver for a real MCP
client subprocess once we have a real agent integration story to
verify against in CI.
