# @qmilab/lodestar-trace

The read side of the epistemic chain. Consumes an Orrery event log and
produces a markdown trust report that explains what an agent observed,
what it came to believe, which beliefs informed which actions, what
happened, and whether anything was revised.

## CLI

```
orrery report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
```

Defaults the log root to `./.orrery/events`. Will scan project directories
under the log root if `--project` is not supplied.

Examples:

```sh
# Render to stdout
orrery report session-1779551238212

# Write to a file (suitable for pasting into a GitHub issue)
orrery report session-1779551238212 --out trust.md

# Inspect a different log root
orrery report session-1779551238212 --log-root .orrery/events
```

The package also exposes the binary directly:

```sh
bunx orrery-report <session-id>
```

## Library

```ts
import {
  loadSessionEvents,
  projectChain,
  renderReport,
  defaultLogRoot,
} from "@qmilab/lodestar-trace"

const { events, project_id } = await loadSessionEvents({
  logRoot: defaultLogRoot(),
  session_id: "session-1779551238212",
})
const projection = projectChain(events, { session_id: "session-1779551238212" })
const markdown = renderReport(projection)
```

## Why this is a separate package

The append-only event log is *the* source of truth in Orrery. The trace
package treats it as such: every fact it surfaces is grounded in a
specific event. That separation is what lets `orrery report` work even
when the agent process has exited and only the log remains.

## What it does not do

- Real-time tailing of an active session (planned for v0.2).
- Rendering to HTML or JSON (markdown only in v0).
- Exporting to LangSmith / Langfuse / Phoenix (that's `@qmilab/lodestar-otel-exporter`).
- Single-writer enforcement on the underlying event log (that's Batch 3).
