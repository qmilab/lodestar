# @qmilab/lodestar-event-log

Append-only NDJSON event log for the Lodestar epistemic chain. Part of
[Lodestar](https://qmilab.com/lodestar) — the trust layer for AI agents.

Every governance event in Lodestar (observation, claim, belief
adoption, firewall transition, action proposal, action outcome,
revision) flows through this log. The log is the source of truth that
`@qmilab/lodestar-trace` reads to produce trust reports, and the
substrate replay-grade audit is built on.

## Install

```sh
npm install @qmilab/lodestar-event-log @qmilab/lodestar-core
# or
bun add @qmilab/lodestar-event-log @qmilab/lodestar-core
```

## Usage

### Writing

```ts
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"

const writer = new EventLogWriter(".lodestar/events")

await writer.append({
  id: crypto.randomUUID(),
  type: "observation.recorded",
  schema_version: "0.1.0",
  project_id: "my-project",
  session_id: "session-1",
  actor_id: "agent-1",
  timestamp: new Date().toISOString(),
  causal_parent_ids: [],
  payload: { what: "an example observation" },
  payload_hash: canonicalHash({ what: "an example observation" }),
  versions: { schema_registry_version: "0.1.0" },
})
```

The writer assigns each event a monotonic per-project `seq` and a
per-session `logical_clock`. Both are stored in the envelope so
downstream readers can reconstruct ordering and causality without
re-deriving them.

### Reading

```ts
import { EventLogReader } from "@qmilab/lodestar-event-log"

const reader = new EventLogReader(".lodestar/events")

// All events for a project, in seq order:
const all = await reader.readAll("my-project")

// Just the events for one session, in logical-clock order:
const session = await reader.readSession("my-project", "session-1")
```

`projectChain` and `renderReport` from `@qmilab/lodestar-trace`
consume the reader's output to produce the trust reports that the
`lodestar report` CLI emits.

## File layout

One NDJSON file per `(project_id, day)` under
`<root>/<project_id>/<YYYY-MM-DD>.ndjson`. Each line is a single JSON
event envelope. The writer validates every envelope against the
`EventEnvelopeSchema` from `@qmilab/lodestar-core` before writing —
malformed envelopes never reach disk.

## Concurrency

The writer maintains process-wide partition state (per `rootDir` ×
`project_id`) so multiple `EventLogWriter` instances in the same
process — for example, two concurrent `guard.runGuarded` sessions for
the same project — share allocation of `seq` and `logical_clock`.

Cross-process safety (file locking) is a v0.2+ concern that lands with
the MCP proxy. For now, run one writer process per project at a time.

## Vocabulary note

The architecture memo refers to this subsystem as the **Ephemeris** —
"a table of positions over time; the Lodestar event log records the
position of the agent's epistemic state over time." That naming is
documented in
[`docs/architecture/v02-delta.md`](https://github.com/qmilab/lodestar/blob/main/docs/architecture/v02-delta.md).
The package name on npm stays `@qmilab/lodestar-event-log`.

## License

[Apache 2.0](./LICENSE).
