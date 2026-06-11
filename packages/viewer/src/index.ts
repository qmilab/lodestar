/**
 * @qmilab/lodestar-viewer — the read-side Governing UI.
 *
 * A local, strictly read-only web viewer over the Lodestar event log. It
 * reuses the trace package's `projectChain()` + `renderReport()` to render
 * the epistemic chain — *what the agent observed, claimed, believed,
 * decided, and what policy allowed* — live in the browser, with drill-down
 * and live tail. It is the interactive sibling of the one-shot
 * `lodestar report`.
 *
 * Read-only by construction: no route mutates the event log, and pending
 * approvals are surfaced for visibility only. Resolving them is the
 * separate write-side surface (the `lodestar approve` CLI, or a
 * separate write-side product).
 *
 * The CLI entry point is `lodestar view [session-id]`.
 */

export { startViewer } from "./server.js"
export type { ViewerOptions, ViewerHandle } from "./server.js"

export { listSessions, pendingApprovals, readAllEvents } from "./sessions.js"
export type { SessionSummary, PendingApproval } from "./sessions.js"

export { toWireProjection } from "./wire.js"
export type { WireProjection } from "./wire.js"
