# @qmilab/lodestar-guard — CLAUDE.md

A meta-package. Mostly re-exports plus one helper (`wrap`).

## What lives here

- `src/index.ts` — re-exports from `@qmilab/lodestar-event-log`,
  `@qmilab/lodestar-action-kernel`, `@qmilab/lodestar-memory-firewall`,
  `@qmilab/lodestar-cognitive-core`, and selected types from `@qmilab/lodestar-core`. Plus
  the local helpers below.
- `src/wrap.ts` — `wrap(loop)` and `runGuarded(loop, config)`. Wires up
  one fresh session per invocation: writer, in-memory stores, firewall,
  cognitive core, kernel. Calls the loop with a `GuardContext`.
- `src/types.ts` — `GuardConfig`, `GuardContext`, `CallToolOptions`,
  `CallToolResult`, `GuardRunResult`, `GuardInternals`.
- `src/policy-presets.ts` — `autoApprovePolicy` (with explicit ceiling)
  and `alwaysHoldsChecker`. Neither is a default; the helper must be
  called explicitly with the policy ceiling visible at the call site.

## Invariants

1. **No silent defaults for security-relevant settings.** `policy_gate`
   and `precondition_checker` are required fields on `GuardConfig`. The
   helpers `autoApprovePolicy()` and `alwaysHoldsChecker` exist but
   must be invoked by name with explicit parameters — Guard never
   auto-approves on the caller's behalf.
2. **One session per `runGuarded` call.** Each invocation constructs a
   new event-log writer, new in-memory stores, and a new session_id.
   The package does not currently support reusing a guarded context
   across multiple loop invocations.
3. **Sequential tool calls within a session.** Two parallel `callTool`s
   in the same `GuardContext` may race on the shared observation-sink
   capture. Multi-process / parallel-tool safety is a Batch 3 concern
   that lands with the MCP proxy.
4. **No new schemas.** Guard does not extend `@qmilab/lodestar-core`. All
   event payloads are existing chain primitives or simple status events
   (`guard.session.started`, `guard.session.ended`,
   `guard.session.failed`).

## What does not live here

- MCP proxy mode — `@qmilab/lodestar-guard-mcp`, Batch 3.
- Real policy enforcement — `@qmilab/lodestar-policy-kernel`, Batch 4+.
- Anything that consumes the event log on the read side — that's
  `@qmilab/lodestar-trace`.

## When changing `wrap`

- The shape of `GuardContext` is part of the public API. Add new fields
  before removing or renaming existing ones.
- Every event written by `wrap` carries the configured `project_id`,
  `session_id`, and `actor_id`. `orrery report` relies on session_id
  to slice the log.
- New event types should be additive. Existing consumers (the trace
  package, examples) must keep working with old event types.
