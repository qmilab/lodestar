# ADR-0014: Session shipper — `lodestar ship` and the `lodestar.session_ship@1` wire format

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Nandan
- **Related:** ADR-0010 (signed approvals), ADR-0015 (approval channel), `docs/reference/public-api.md`

## Context

A session's event log lives only on the machine that produced it. The read
side renders it three ways (markdown report, local viewer, OTLP spans), but
there is no first-class way to move the **raw envelopes** to another
machine — a shared collector, a remote viewer, an archive. The OTLP export
is lossy by design (action-centric spans, not envelopes), so it cannot serve
as the transfer format. External integrators that want to consume whole
sessions need a documented, versioned wire format and a CLI that applies the
locked v0.2 sensitivity gate **client-side, before anything leaves the
machine** — the same redaction discipline `lodestar otel export` already
enforces.

Two constraints shape the design:

1. **The envelope schema is locked.** `EventEnvelope` must not grow fields
   for shipping; the architecture freeze and the `event-log-canonical-hash`
   probe (payload_hash == canonicalHash(payload)) both forbid it.
2. **Redaction must not break tamper evidence.** A redacted payload cannot
   match its `payload_hash`; a receiver must be able to distinguish
   "redacted by the sender" from "tampered in transit".

## Decision

A new read-side batch-export package, `@qmilab/lodestar-ship`, shaped
exactly like `@qmilab/lodestar-otel-exporter` (read log → pure transform →
deliver at the I/O edge), with the CLI verb `lodestar ship`:

```
lodestar ship <session-id>
  [--project <id>] [--log-root <path>]
  --endpoint <base-url>                 # POST {base}/v1/events
  [--header k=v ...]
  [--token-env LODESTAR_SHIP_TOKEN]     # → Authorization: Bearer <value>
  [--sensitivity-ceiling public|internal|confidential|secret]   # default: internal
  [--out <file> | --stdout]             # dry-run, mutually exclusive with --endpoint
```

**Wire format `lodestar.session_ship@1`** — NDJSON body,
`Content-Type: application/x-ndjson`:

- Line 1, the manifest record:
  `{"kind":"lodestar.session_ship","version":1,"project_id":…,"session_id":…,"event_count":N,"ceiling":…,"redacted_count":M}`
- Lines 2..N+1, one record per event in `seq` order:
  `{"v":1,"redacted":false,"envelope":{…verbatim EventEnvelope…}}` — or, for
  content above the ceiling, `{"v":1,"redacted":true,"payload_sensitivity":…,
  "envelope":{…payload replaced by {"lodestar.redacted":true}, payload_hash
  UNCHANGED…}}`.

The **wrapper record carries the redaction flag; the envelope is never
mutated schema-wise**, and a redacted record keeps the *original*
`payload_hash` — the receiver verifies the hash for every `redacted:false`
record and treats the retained hash on `redacted:true` records as a
commitment that can be verified later under higher clearance. This mirrors
the otel-exporter's `{"lodestar.redacted":true, "lodestar.payload_hash":…}`
marker exactly.

Sensitivity per event type comes from the payload's own `sensitivity` field
(observations/claims/beliefs) or the action mapping
(`contentSensitivityForAction`); **unknown event types fail closed**
(payload redacted) — the same posture as `sensitivityRank`. Prerequisite:
the gate primitives (`SENSITIVITY_ORDER`, `sensitivityRank`,
`isAboveCeiling`, the action mapping) graduate from the otel-exporter into
`@qmilab/lodestar-core` (they derive from core's `SensitivitySchema`
already), with re-exports left behind (non-breaking).

**Receiver contract** (documented so any collector can implement it):
dedupe key is `(project_id, session_id, seq)`; a re-ship is idempotent
retry-all (2xx accepted / non-2xx whole-POST failed; no partial semantics);
`seq` strictly increasing within a POST; one bounded POST per session in v0
(the size ceiling is documented, not silently chunked). The bearer token is
never logged, never enters the manifest, and is redacted from error
messages (the SQL adapter's DSN-redaction discipline).

**Probes (spec-first):** `ship-respects-sensitivity-ceiling` (a local
capture server asserts an above-ceiling payload's bytes never appear in the
POST body while the marker + original hash do) and `ship-wire-roundtrip`
(receiver re-verifies every unredacted `payload_hash`; redacted records are
flagged, not hash-mismatched).

## Consequences

- Whole sessions become portable to any compatible collector with the
  locked export gate applied before egress; the report/viewer read side can
  run anywhere the wire format is ingested.
- Tamper evidence survives redaction; a receiver can prove integrity of
  everything it is cleared to see.
- One more published package (both `PUBLISH_ORDER` lists + root devDeps for
  probe resolution).
- Live tail/streaming is explicitly out of scope — shipping is batch, like
  `otel export`; liveness is the receiver's dedupe contract making re-ships
  cheap.

## Alternatives considered

- **Extend `@qmilab/lodestar-trace`** — rejected: trace is the
  dependency-light pure-projection package; network/auth concerns don't
  belong in it.
- **Extend the otel-exporter** — rejected: different wire format and
  different consumers; conflating "spans for trace tools" with "envelopes
  for session transfer" muddies both contracts.
- **Add a `redacted` field to `EventEnvelope`** — rejected: core schema is
  locked, and it would break the canonical-hash invariant for every reader.
- **OTLP as the transfer format** — rejected: lossy by design; cannot
  reconstruct the chain or re-verify payload hashes.
- **A streaming/daemon mode (`--follow`)** — deferred: it tempts a
  cross-process writer topology the event log deliberately does not
  support.
