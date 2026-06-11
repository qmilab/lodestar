# @qmilab/lodestar-ship — CLAUDE.md

The session shipper. A **read-side, batch** transfer of a session's *raw*
event-log envelopes to a remote collector as the versioned NDJSON wire format
`lodestar.session_ship@1`. The transfer sibling of
`@qmilab/lodestar-otel-exporter`: same read-only stance, but a lossless,
hash-verifiable **envelope** format (not lossy OTLP spans) meant to reconstruct
the whole chain on the far side. ADR-0014.

## What lives here

A pure builder with the I/O at the edge:

```
log ──(trace.loadSessionEvents)──▶ EventEnvelope[] ──(buildShipBatch)──▶ ShipBatch
                                                                            │
                                          (serializeBatch) ──▶ NDJSON ──▶ POST /v1/events
                                                                          └▶ --out / --stdout
```

- `src/wire.ts` — **pure, no I/O**. `buildShipBatch()` re-sorts the envelopes
  into `seq` order, applies the sensitivity gate per event, and produces the
  manifest + wrapper records; `serializeBatch()` renders the NDJSON body. Owns
  the `ShipManifestSchema` / `ShipRecordSchema` Zod contracts and
  `payloadContentSensitivity()`. This is where the redaction discipline lives.
- `src/ship.ts` — the only module that does I/O. `shipSession()` reads via
  `@qmilab/lodestar-trace`, builds the batch, and either POSTs the NDJSON to a
  collector, writes it to a file, or returns it for stdout. Owns the bounded
  single-POST ceiling and bearer-token redaction from error text.

## The wire format — `lodestar.session_ship@1`

NDJSON body, `Content-Type: application/x-ndjson`:

- **Line 1, the manifest:**
  `{"kind":"lodestar.session_ship","version":1,"project_id":…,"session_id":…,"event_count":N,"ceiling":…,"redacted_count":M}`
- **Lines 2..N+1, one wrapper record per event in `seq` order:**
  - unredacted — `{"v":1,"redacted":false,"envelope":{…verbatim EventEnvelope…}}`
  - redacted — `{"v":1,"redacted":true,"payload_sensitivity":…,"envelope":{…payload replaced by {"lodestar.redacted":true}, payload_hash UNCHANGED…}}`

**Receiver contract** (documented so any collector can implement it): dedupe key
is `(project_id, session_id, seq)`; a re-ship is an idempotent retry-all (2xx
accepted / non-2xx ⇒ the whole POST failed; no partial semantics); `seq` is
strictly increasing within a POST; one bounded POST per session in v0 (the size
ceiling is enforced, never silently chunked). A receiver re-verifies
`payload_hash == canonicalHash(payload)` for every `redacted:false` record and
treats the retained hash on a `redacted:true` record as a commitment to verify
later under higher clearance.

## Invariants

1. **Read-only.** This package never writes the event log. `shipSession` is
   `readFile` + pure build; the only writes are the operator-requested `--out`
   file or the POST body — that is output, not the log.
2. **The envelope schema is never grown for shipping.** The redaction flag and
   `payload_sensitivity` live on the *wrapper*, never on the `EventEnvelope`.
   Growing the envelope would break the locked core schema and the
   `event-log-canonical-hash` invariant for every reader.
3. **Redaction preserves tamper evidence.** A redacted record replaces only the
   `payload` (with `REDACTED_PAYLOAD`) and keeps the original `payload_hash`.
   Never recompute the hash of the marker — the receiver must be able to verify
   the withheld content later, and to distinguish sender-redaction from
   in-transit tampering.
4. **Sensitivity gate is load-bearing and fails closed.** Per-event source
   sensitivity is trusted only when the raw payload **validates** against a known
   content schema — a Claim/Belief/Observation's own `sensitivity`, or a validated
   Action's `contract.data_sensitivity` via `contentSensitivityForAction`. A bare
   blob with a `sensitivity`-looking field (a custom or agent-emitted event) does
   NOT validate and is treated as `secret` — the shipper handles raw envelopes, so
   it must verify the shape before trusting the label. Decisions, outcomes,
   approval records, forged/custom events, and future event types are therefore
   withheld at every ceiling below `secret`, yet the whole session is still
   portable at `--sensitivity-ceiling secret`. The default ceiling is `internal`.
   An invalid ceiling **throws** (never fails open).
5. **The credential never leaks.** The bearer token is read from a named env
   var by the CLI (never argv), is never in the manifest, never in the NDJSON
   body, and is scrubbed from every error message (a server that echoes it back
   gets `«redacted»`). The CLI also **refuses a credential header**
   (`authorization` / `cookie` / `proxy-authorization`) supplied via `--header`,
   so there is no argv backdoor around `--token-env`.

## What does not live here

- A streaming / `--follow` daemon — out of scope. Shipping is batch, like
  `otel export`; liveness is the receiver's cheap-re-ship dedupe contract.
- The receiver / collector itself — this package only produces the wire format
  and the documented contract; storing it is the collector's job.
- Any mutation of the chain. This is transfer, not transformation: envelopes
  ship verbatim or redacted, never rewritten.

## When you change the wire format

1. Bump the version (`lodestar.session_ship@2`) — never silently change `@1`.
   The format is stable from first release (`docs/reference/public-api.md`).
2. Keep `buildShipBatch` pure and dependency-free; keep I/O in `ship.ts`.
3. Keep the two probes green — they are the spec:
   `ship-respects-sensitivity-ceiling` (above-ceiling bytes never hit the wire;
   marker + original hash do) and `ship-wire-roundtrip` (every unredacted
   `payload_hash` re-verifies; redacted records are flagged, not mismatched).
