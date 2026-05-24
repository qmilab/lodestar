# @orrery/guard

The write-side trust layer. A single import surface for governing an
agent: every tool call goes through the Action Kernel, every observation
through the Cognitive Core, and every step lands in the event log.

## Quick start

```ts
import {
  wrap,
  autoApprovePolicy,
  alwaysHoldsChecker,
  registerTool,
} from "@orrery/guard"

// Wrap your loop.
const run = wrap(async (ctx) => {
  const { output } = await ctx.callTool("git.status", { repo: "." })
  return output
})

// Run it under a governed context.
const { result, session_id, log_root } = await run({
  project_id: "my-project",
  actor_id: "my-agent",
  default_scope: { level: "project", identifier: "my-project" },
  default_sensitivity: "internal",
  policy_gate: autoApprovePolicy({
    auto_approve_up_to: 2,
    approver_id: "policy-stub",
  }),
  precondition_checker: alwaysHoldsChecker,
})
```

The event log lands at `<log_root>/<project_id>/<YYYY-MM-DD>.ndjson`.
Render it later with `orrery report <session-id>`.

## What `wrap()` actually does

For each call to `ctx.callTool(name, inputs)`:

1. Look up the tool in the action-kernel registry. Validate inputs
   against its `inputs` Zod schema.
2. Propose an Action with the tool's declared trust level and the
   caller's `default_scope`. Emit `action.proposed`.
3. Arbitrate through the supplied `policy_gate`. Emit
   `action.approved` or `action.rejected`.
4. Execute the tool, re-validating preconditions. The kernel validates
   the tool output against the registered output schema and constructs
   an Observation. Emit `action.completed` / `action.failed`.
5. Route the Observation through the Cognitive Core (claim extraction
   → evidence linking → belief adoption via the Memory Firewall). Emit
   `observation.recorded`, `cognitive.ingested`, plus one
   `claim.extracted` and one `belief.adopted` per ingested item.
6. Return the validated output, the completed Action, the Observation,
   and the Cognitive Core's ingest result.

For each `ctx.ingestObservation(obs)`: the observation is recorded and
ingested as in step 5; no Action surrounds it. Use for events that did
not originate from a registered tool (webhooks, external feeds).

`ctx.emit(type, payload)` is the escape hatch for chain primitives the
default plumbing doesn't generate — typically `decision.made`,
`outcome.observed`, `revision.recorded`, or custom domain events.

## No silent defaults

`policy_gate` and `precondition_checker` are required. Guard does not
provide an auto-approve default because "the trust layer auto-approved
everything by default" is the wrong failure mode. Use
`autoApprovePolicy({ auto_approve_up_to: ... })` if you want a starter
policy — the explicit ceiling makes the intent visible in the call site.

## What's re-exported

Everything from `@orrery/event-log`, `@orrery/action-kernel`,
`@orrery/memory-firewall`, and `@orrery/cognitive-core` that a typical
caller needs, plus the most-used types from `@orrery/core`. A consumer
who imports only from `@orrery/guard` should have the full trust-layer
surface available.

## What this package does not include

- Skill manifests, signing, or skill marketplace plumbing (out of scope
  through v1.5).
- MCP proxy mode for wrapping existing agents — that's
  `@orrery/guard-mcp`, scheduled for Batch 3.
- Production-grade policy (trust ladder, approval surfaces) — that's
  `@orrery/policy-kernel`, scheduled for Batch 4+.
