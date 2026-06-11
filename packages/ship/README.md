# @qmilab/lodestar-ship

Move a whole governed session to another machine. `lodestar ship` reads a
session's NDJSON event log and transfers its **raw envelopes** to a remote
collector as the versioned wire format `lodestar.session_ship@1` — so a shared
collector, a remote viewer, or an archive can reconstruct the full epistemic
chain and re-verify every payload hash.

It is the transfer sibling of `@qmilab/lodestar-otel-exporter`. The OTLP export
is lossy by design (action-centric spans); this is lossless: envelopes ship
verbatim, in `seq` order, with their tamper-evidence intact.

It is a **read-side, batch** shipper — it reads a finished log and POSTs it. No
SDK, no daemon, no new runtime dependencies.

## The sensitivity gate (client-side, before egress)

Content above a configured **sensitivity ceiling** (default `internal`) never
leaves the machine. A record whose source sensitivity outranks the ceiling
ships **redacted**: the wrapper is flagged `redacted: true`, the envelope's
`payload` is replaced with `{ "lodestar.redacted": true }`, and the original
`payload_hash` is **kept** — a commitment the receiver can verify later under
higher clearance, and the thing that lets it tell sender-redaction from
in-transit tampering.

The gate **fails closed**: an event whose sensitivity can't be positively
determined (a decision, an outcome, a future event type) is treated as `secret`
and withheld by default — but the whole session is still portable at
`--sensitivity-ceiling secret`. An invalid ceiling throws; it never fails open.

## The wire format — `lodestar.session_ship@1`

NDJSON, `Content-Type: application/x-ndjson`, POSTed to `{endpoint}/v1/events`:

```jsonc
// line 1 — manifest
{"kind":"lodestar.session_ship","version":1,"project_id":"p","session_id":"s","event_count":4,"ceiling":"internal","redacted_count":1}
// line 2 — unredacted: the envelope ships verbatim
{"v":1,"redacted":false,"envelope":{ /* …EventEnvelope… */ }}
// line 3 — redacted: payload replaced, payload_hash kept
{"v":1,"redacted":true,"payload_sensitivity":"secret","envelope":{ /* payload = {"lodestar.redacted":true} */ }}
```

**Receiver contract.** Dedupe key `(project_id, session_id, seq)`; a re-ship is
an idempotent retry-all (2xx accepted, non-2xx ⇒ the whole POST failed); `seq`
strictly increasing within a POST; one bounded POST per session in v0. Verify
`payload_hash == canonicalHash(payload)` for every `redacted:false` record.

## Usage

```bash
# Dry run: print the NDJSON for a session (no collector needed)
lodestar ship <session-id> --stdout

# Ship to a collector, authenticating with a token from the environment
LODESTAR_SHIP_TOKEN=… lodestar ship <session-id> --endpoint https://collector.example.com

# Raise the ceiling to transfer the whole session; write to a file instead
lodestar ship <session-id> --sensitivity-ceiling secret --out session.ndjson
```

The bearer token is read from `--token-env` (default `LODESTAR_SHIP_TOKEN`),
never from argv; it becomes `Authorization: Bearer <value>` on the POST and is
never logged, never in the manifest, and scrubbed from error messages. For other
credential headers (API keys, custom tokens) use `--secret-header NAME=ENV_VAR`,
which reads the value from an env var. `--header` is for **non-secret** headers
only: credential-looking names (`authorization`, `cookie`, `*token*`, `*api-key*`,
`*secret*`, …) are refused there so a secret can't slip in through argv.

Programmatically:

```ts
import { shipSession } from "@qmilab/lodestar-ship"

const summary = await shipSession({
  sessionId: "my-session",
  endpoint: "https://collector.example.com",
  sensitivityCeiling: "internal",
})
// → { event_count, redacted_count, ceiling, byte_count, delivered, … }
```

## License

Apache-2.0
