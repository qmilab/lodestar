# coding-agent-greenfield

A minimal home-grown coding-agent loop wrapped with `@qmilab/lodestar-guard`. The
agent observes the repo, reads a couple of files, makes a decision, and
finishes. Every step is recorded; `orrery report` (or the trace library
used inline at the end of the script) renders a markdown trust report
from the resulting log.

## Run

```sh
bun run examples/coding-agent-greenfield/index.ts
```

To watch the policy gate reject an action that exceeds the auto-approve
ceiling:

```sh
bun run examples/coding-agent-greenfield/index.ts --simulate-denied-tool
```

## What it demonstrates

- `guard.wrap()` accepting a user-supplied agent loop and returning a
  function that drives it through the trust layer.
- The Action Kernel's two-phase execution (propose → arbitrate →
  execute), including the policy gate rejecting an L4 contract under an
  L2 auto-approve ceiling.
- The Cognitive Core ingesting observations into claims and beliefs
  through the Memory Firewall.
- `decision.made` events emitted via the escape hatch on
  `GuardContext.emit`, kept in the same log alongside actions and
  beliefs.
- `@qmilab/lodestar-trace` projecting the resulting event log into the
  epistemic chain and rendering a markdown trust report.

## What it does not demonstrate

- Real LLM-driven planning. The "decision" here is a hard-coded action
  in the agent loop. A real coding agent would use a planner and the
  belief store; the wiring would be the same, only richer.
- Side-effectful actions (commits, pushes, file edits). The example is
  read-only by design — it's the simplest path from "agent" to "trust
  report".
- The MCP proxy mode for wrapping an existing agent runtime (that's
  Batch 3).
