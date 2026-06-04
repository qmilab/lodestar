/**
 * @qmilab/lodestar-otel-exporter — the OpenTelemetry bridge.
 *
 * Projects a session's event log into OTel GenAI spans and exports them
 * over OTLP/HTTP (JSON), so the epistemic chain — *what the agent
 * observed, claimed, believed, decided, and what policy allowed* — shows
 * up in any OTLP-compatible trace tool (Langfuse, Phoenix, Jaeger, Tempo).
 *
 * Read-side and batch: it reads a finished log, projects it, and emits a
 * trace. No OTel SDK, no live instrumentation. Content above a configured
 * sensitivity ceiling is withheld (structural metadata + payload hash
 * only) — the locked v0.2 export invariant.
 *
 * The CLI entry point is `lodestar otel export <session-id>`.
 */

export { exportSession, SessionNotFoundError } from "./export.js"
export type { ExportSessionOptions, ExportSummary } from "./export.js"

export { buildTrace } from "./project-spans.js"
export type {
  AttrValue,
  BuildTraceOptions,
  LodestarSpan,
  LodestarSpanEvent,
  LodestarTrace,
  SpanStatusCode,
} from "./project-spans.js"

export { toOtlpTraceJson } from "./otlp.js"
export type { OtlpTracePayload, ToOtlpOptions } from "./otlp.js"

export { isoToUnixNano, spanIdFor, traceIdFor } from "./ids.js"

export {
  contentSensitivityForAction,
  isAboveCeiling,
  isSensitivity,
  SENSITIVITY_ORDER,
  sensitivityRank,
} from "./sensitivity.js"
