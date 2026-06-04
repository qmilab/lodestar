# @qmilab/lodestar-otel-exporter

The OpenTelemetry bridge for Lodestar. It projects a session's event log into
OTel spans that follow the [GenAI semantic conventions][semconv] and exports
them over **OTLP/HTTP (JSON)** — so the epistemic chain shows up in any
OTLP-compatible trace tool: **Langfuse, Phoenix, Jaeger, Tempo, Datadog**.

Lodestar is not an observability platform. It records *what an agent observed,
claimed, believed, decided, and what policy allowed*; this package hands that
record to the tool you already use to look at traces.

It is a **read-side, batch** exporter: it reads a finished NDJSON event log,
projects it, and emits a trace. No SDK, no live in-process instrumentation, no
new runtime dependencies — the OTLP/HTTP trace wire format is a small, stable
JSON shape we build directly.

## Span model

Action-centric — the shape Langfuse and Phoenix render natively:

```
trace = session
└─ span: invoke_agent (the session)
   ├─ event: observation.recorded
   ├─ event: belief.adopted        (truth_status, sensitivity, confidence …)
   ├─ span:  execute_tool fs.read  [ok]
   ├─ span:  execute_tool git.push [error: policy denied]
   └─ event: firewall.belief.transitioned
```

Each governed Action becomes an `execute_tool` span (`gen_ai.operation.name`,
`gen_ai.tool.name`, `gen_ai.tool.call.id`) carrying Lodestar's policy verdict,
trust level, blast radius, and outcome as `lodestar.*` attributes. Observations,
beliefs, decisions, and firewall transitions ride as span **events** on the
session root. Span and trace ids are derived deterministically from the
project, session, and action ids, so re-exporting the same log produces the
same trace (and two projects that reuse a session id stay distinct).

## The sensitivity gate

Content above a configured **sensitivity ceiling** (default `internal`) is never
exported: the span or event is still emitted with its structural metadata (ids,
timing, type, status) and the payload is dropped, leaving the envelope's
`payload_hash` in its place. A `secret`-sensitivity belief shows up in your trace
tool as *"a secret belief existed and backed this decision"* — never as its
content. This honours the locked v0.2 invariant (`docs/architecture/v02-delta.md`
§3).

## Usage

```bash
# Print the OTLP JSON for a session (no collector needed)
lodestar otel export <session-id> --stdout

# Push to a collector / Langfuse / Phoenix OTLP endpoint
lodestar otel export <session-id> --endpoint http://localhost:4318

# Raise the ceiling, add auth headers, write to a file
lodestar otel export <session-id> \
  --sensitivity-ceiling confidential \
  --header "authorization=Bearer $TOKEN" \
  --out trace.json
```

Programmatically:

```ts
import { exportSession } from "@qmilab/lodestar-otel-exporter"

const summary = await exportSession({
  sessionId: "my-session",
  endpoint: "http://localhost:4318",
  sensitivityCeiling: "internal",
})
// → { trace_id, span_count, event_count, redacted_count }
```

[semconv]: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## License

Apache-2.0
