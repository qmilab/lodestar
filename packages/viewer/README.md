# @qmilab/lodestar-viewer

The read-side **Governing UI** for [Lodestar](https://qmilab.com/lodestar),
the trust layer for AI agents.

A local, **strictly read-only** web viewer over the Lodestar event log. It
projects the append-only log into the epistemic chain — *what the agent
observed, claimed, believed, decided, and what policy allowed* — and renders
it live in your browser, with drill-down, an event-type filter, a live tail,
and a read-only view of pending approvals.

It is the interactive sibling of `lodestar report`: same read side
(`projectChain()` + `renderReport()`), in a browser instead of a one-shot
markdown file.

## Usage

```bash
# Serve the default log root (<cwd>/.lodestar/events) on http://127.0.0.1:4319
lodestar view

# Open a specific session in the browser
lodestar view session-1779551238212 --open

# Point at another log root / port
lodestar view --log-root ./.lodestar/events --port 8080
```

Then open the printed URL. Pick a session on the left to see:

- **Chain** — observations → claims → evidence → beliefs → decisions →
  actions → firewall transitions, each expandable to its raw envelope.
- **Report** — the same markdown `lodestar report` produces (one-click
  download).
- **Events** — the raw envelope stream, filterable by type, with a live
  tail toggle (Server-Sent Events).
- **Approvals** — pending `approval.requested@1` items, **read-only**.

## Read-only by design

This viewer never writes the event log and exposes no mutation route.
Pending approvals are shown for visibility only — to resolve them, use
`lodestar approve grant|deny` (or the separate write-side Governing UI). It
binds to `127.0.0.1` by default; the log can carry secret-sensitivity
beliefs, so localhost is the trust boundary. Do not expose it on a
non-loopback interface without an auth layer in front.

## Library API

```ts
import { startViewer } from "@qmilab/lodestar-viewer"

const viewer = await startViewer({ logRoot: "./.lodestar/events", port: 0 })
console.log(viewer.url) // http://127.0.0.1:<ephemeral>
// ... later
await viewer.stop()
```

Also exports `listSessions`, `pendingApprovals`, `readAllEvents`, and
`toWireProjection` for callers that want the read-side helpers directly.

## License

Apache-2.0
