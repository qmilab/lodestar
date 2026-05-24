/**
 * @orrery/trace — the read side of the epistemic chain.
 *
 * Consumes the append-only event log and projects it into the chain
 * primitives (Observation → Claim → EvidenceSet → Belief → Decision →
 * Action → Outcome → Revision), then renders a markdown trust report.
 *
 * The CLI entry point is `orrery report <session-id>`. The library
 * surface (`projectChain`, `renderReport`) is exported for callers that
 * want to render reports in their own pipelines.
 */

export { projectChain } from "./chain"
export type {
  ChainProjection,
  CognitiveSummary,
  ProjectedDecision,
  FirewallTransition,
  ProjectedAction,
} from "./chain"

export { renderReport } from "./report"
export type { RenderOptions } from "./report"

export { describeEvent, findEventById } from "./inspect"
export {
  defaultLogRoot,
  findProjectForSession,
  loadSessionEvents,
} from "./load"
