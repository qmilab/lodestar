# @qmilab/lodestar-otel-exporter — CLAUDE.md

The OpenTelemetry bridge. A **read-side, batch** exporter that projects a
session's event log into OTel GenAI spans and ships them over OTLP/HTTP (JSON).
The interop sibling of `@qmilab/lodestar-trace` (markdown) and
`@qmilab/lodestar-viewer` (SPA): same read-only stance, different output.

## What lives here

A pure pipeline with the I/O at the edge — each stage is independently testable:

```
log ──(trace.loadSessionEvents)──▶ ChainProjection ──(buildTrace)──▶ LodestarTrace (neutral IR)
                                                                          │
                                              (toOtlpTraceJson) ──▶ OTLP JSON ──▶ POST /v1/traces
                                                                                └▶ --out / --stdout
```

- `src/ids.ts` — deterministic ids (sha-256 over project/session/local ids; 16-byte
  trace id, 8-byte span id) and `isoToUnixNano`. No randomness, no wall clock —
  re-exporting the same log yields the same trace (idempotent).
- `src/sensitivity.ts` — re-export of the sensitivity gate, which graduated to
  `@qmilab/lodestar-core` (`SENSITIVITY_ORDER`, `sensitivityRank`,
  `isAboveCeiling`, `isSensitivity`, `contentSensitivityForAction`) so the
  session shipper and any future egress path share one implementation. The
  redaction itself — content whose source sensitivity outranks the ceiling is
  replaced by a `{ "lodestar.redacted": true, "lodestar.payload_hash": … }`
  marker, structural fields never pass through it — lives in `src/project-spans.ts`.
- `src/project-spans.ts` — **pure, no deps**. `buildTrace(projection, opts)` →
  the neutral `LodestarTrace` IR. Action-centric mapping (see README). This is
  where the chain→span shape lives; it carries no OTel dependency so it stays
  trivially testable.
- `src/otlp.ts` — **pure**. `toOtlpTraceJson(traces)` → the OTLP/HTTP
  `ExportTraceServiceRequest` JSON (resourceSpans → scopeSpans → spans). Owns the
  wire encoding: hex ids, `unixNano` strings, typed `anyValue` attributes, status
  codes (unset=0/ok=1/error=2), span kind INTERNAL=1.
- `src/export.ts` — the only module that does I/O. `exportSession()` reads via
  `@qmilab/lodestar-trace`, builds the trace, and either POSTs to an OTLP endpoint
  or writes the JSON to a file/stdout.

## Invariants

1. **Read-only.** This package never writes the event log. Like `trace`, every
   path is `readFile` + pure projection. (The CLI may write the OTLP JSON to a
   `--out` file or POST it to a collector — that is output, not the log.)
2. **Sensitivity gate is load-bearing.** The locked v0.2 rule
   (`v02-delta.md` §3) — *events above the ceiling are not exported by default;
   spans carry metadata but payload is dropped or hashed* — is enforced in
   `redact()` and pinned by the `otel-export-respects-sensitivity-ceiling` probe.
   Do not route content into an attribute without sending it through `redact()`
   first (structural metadata excepted). Default ceiling is `internal` — the same
   conservative default as the v0 `ContextPolicy`.
3. **Deterministic ids.** Trace/span ids are a pure function of the
   project, session, and action ids (the project is in the seed so two
   projects reusing a session id never collide). No `Date.now()` /
   `Math.random()`. Re-export is idempotent; collectors overwrite rather
   than duplicate.
4. **No OTel SDK dependency.** The OTLP/HTTP trace wire format is small and
   stable; we build it directly. A read-side batch exporter does not need the
   SDK's span processors, batching, retry, or context propagation — the log
   already holds the full causal DAG. If that calculus ever changes (live
   in-process spans), revisit — but that is a different package shape.

## GenAI semantic conventions

We follow the [GenAI span conventions][semconv]: the session root span uses
`gen_ai.operation.name = "invoke_agent"`; each Action span uses
`"execute_tool"` with the span name `execute_tool {tool}`, kind INTERNAL,
`gen_ai.tool.name`, and `gen_ai.tool.call.id`. Lodestar-specific epistemic data
(truth status, evidence quality, policy verdict, trust level, sensitivity) goes
under the `lodestar.*` namespace — exactly where OTel intends domain attributes
to live. Beliefs and decisions are point-in-time, so they are span **events**,
not spans; a decision's backing beliefs are a `lodestar.decision.belief_dependencies`
attribute (not an OTel span link, which would need a target span context).

[semconv]: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## What does not live here

- Live in-process instrumentation wired into `guard.wrap()` / the MCP proxy
  (would pull in the SDK and touch every package).
- OTel metrics / logs signals — traces only for v0. Calibration ECE/Brier
  metrics are the natural follow-up.
- gRPC OTLP — HTTP/JSON only.

## When you change the mapping

1. Keep `buildTrace` pure and dependency-free; keep I/O in `export.ts`.
2. Any new content-bearing attribute must go through `redact()`.
3. Keep the two probes (`otel-export-respects-sensitivity-ceiling`,
   `otel-export-projects-action-spans`) green — they are the spec.
