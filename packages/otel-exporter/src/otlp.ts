import type {
  AttrValue,
  LodestarSpan,
  LodestarSpanEvent,
  LodestarTrace,
  SpanStatusCode,
} from "./project-spans.js"

/**
 * Serialise the neutral trace IR to the OTLP/HTTP **JSON** form
 * (`ExportTraceServiceRequest`) that any OTLP receiver accepts at
 * `POST /v1/traces`.
 *
 * Two wire-format details worth pinning:
 *  - In OTLP/JSON, `traceId` / `spanId` are lowercase **hex** strings —
 *    the spec's explicit exception to protobuf-JSON's base64 default for
 *    `bytes` fields. Our ids are already hex.
 *  - 64-bit values (`*UnixNano`, int attributes) are JSON **strings**.
 *
 * The encoder is pure and deterministic (attribute keys are sorted), so
 * the same trace IR always serialises to the same bytes.
 */

const SCOPE_NAME = "@qmilab/lodestar-otel-exporter"
const SPAN_KIND_INTERNAL = 1
const STATUS_CODE_UNSET = 0
const STATUS_CODE_OK = 1
const STATUS_CODE_ERROR = 2

export interface ToOtlpOptions {
  /** Instrumentation-scope version (defaults to the package version string). */
  scopeVersion?: string
}

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }

interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

export interface OtlpTracePayload {
  resourceSpans: unknown[]
}

/** Build the OTLP/HTTP JSON request body for one or more traces. */
export function toOtlpTraceJson(
  traces: LodestarTrace[],
  opts: ToOtlpOptions = {},
): OtlpTracePayload {
  const version = opts.scopeVersion ?? "0.1.5"
  return {
    resourceSpans: traces.map((t) => ({
      resource: { attributes: encodeAttributes(t.resource_attributes) },
      scopeSpans: [
        {
          scope: { name: SCOPE_NAME, version },
          spans: t.spans.map((s) => encodeSpan(s, t.trace_id)),
        },
      ],
    })),
  }
}

function encodeSpan(s: LodestarSpan, traceId: string): Record<string, unknown> {
  const span: Record<string, unknown> = {
    traceId,
    spanId: s.span_id,
    name: s.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: s.start_unix_nano,
    endTimeUnixNano: s.end_unix_nano,
    attributes: encodeAttributes(s.attributes),
    events: s.events.map(encodeEvent),
    status: encodeStatus(s.status),
  }
  if (s.parent_span_id) span.parentSpanId = s.parent_span_id
  return span
}

function encodeEvent(e: LodestarSpanEvent): Record<string, unknown> {
  return {
    timeUnixNano: e.time_unix_nano,
    name: e.name,
    attributes: encodeAttributes(e.attributes),
  }
}

function encodeStatus(st: { code: SpanStatusCode; message?: string }): Record<string, unknown> {
  const code =
    st.code === "ok" ? STATUS_CODE_OK : st.code === "error" ? STATUS_CODE_ERROR : STATUS_CODE_UNSET
  const out: Record<string, unknown> = { code }
  if (st.message) out.message = st.message
  return out
}

function encodeAttributes(bag: Record<string, AttrValue>): OtlpKeyValue[] {
  return Object.keys(bag)
    .sort()
    .map((key) => ({ key, value: encodeAnyValue(bag[key] as AttrValue) }))
}

function encodeAnyValue(v: AttrValue): OtlpAnyValue {
  if (typeof v === "string") return { stringValue: v }
  if (typeof v === "boolean") return { boolValue: v }
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  }
  return { arrayValue: { values: v.map((e) => encodeAnyValue(e)) } }
}
