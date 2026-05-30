/**
 * The three first-party sentinels. Each watches the event stream for one
 * suspicious shape and emits `sentinel.alerted@1` findings through the
 * {@link SentinelRunner}. See `docs/architecture/sentinels.md`.
 */
export { LowConfidenceActionSentinel } from "./low-confidence-action.js"
export { SuspiciousMemoryOriginSentinel } from "./suspicious-memory-origin.js"
export {
  AnomalousToolSequenceSentinel,
  DEFAULT_SUSPICIOUS_SEQUENCES,
  type SuspiciousSequence,
  type ToolStepMatcher,
} from "./anomalous-tool-sequence.js"
