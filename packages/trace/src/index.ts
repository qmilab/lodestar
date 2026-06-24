/**
 * @qmilab/lodestar-trace — the read side of the epistemic chain.
 *
 * Consumes the append-only event log and projects it into the chain
 * primitives (Observation → Claim → EvidenceSet → Belief → Decision →
 * Action → Outcome → Revision), then renders a markdown trust report.
 *
 * The CLI entry point is `lodestar report <session-id>`. The library
 * surface (`projectChain`, `pendingApprovals`, `harvestCandidates`,
 * `renderReport`) is exported for callers that want to render reports —
 * or read the pending-approval queue or the durable-memory harvest
 * queue — in their own pipelines.
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

export { harvestCandidates } from "./harvest.js"
export type { MemoryCandidate, SupersededLesson } from "./harvest.js"

export { renderReport } from "./report.js"
export type { RenderOptions } from "./report.js"

export { describeEvent, findEventById } from "./inspect.js"
export {
  defaultLogRoot,
  findProjectForSession,
  loadSessionEvents,
} from "./load.js"
