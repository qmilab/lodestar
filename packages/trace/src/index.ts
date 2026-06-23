/**
 * @qmilab/lodestar-trace — the read side of the epistemic chain.
 *
 * Consumes the append-only event log and projects it into the chain
 * primitives (Observation → Claim → EvidenceSet → Belief → Decision →
 * Action → Outcome → Revision), then renders a markdown trust report.
 *
 * The CLI entry point is `lodestar report <session-id>`. The library
 * surface (`projectChain`, `pendingApprovals`, `renderReport`) is
 * exported for callers that want to render reports — or read the
 * pending-approval queue — in their own pipelines.
 */

export { projectChain } from "./chain.js"
export type {
  ChainProjection,
  CognitiveSummary,
  ProjectedDecision,
  FirewallTransition,
  ProjectedAction,
} from "./chain.js"

export { toWireProjection } from "./wire.js"
export type { WireProjection } from "./wire.js"

export { pendingApprovals } from "./approvals.js"
export type { PendingApproval } from "./approvals.js"

export { renderReport } from "./report.js"
export type { RenderOptions } from "./report.js"

export { describeEvent, findEventById } from "./inspect.js"
export {
  defaultLogRoot,
  findProjectForSession,
  loadSessionEvents,
} from "./load.js"
