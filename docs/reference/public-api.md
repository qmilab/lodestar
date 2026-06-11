# Public API stability

Lodestar is pre-1.0 (`0.x`), where semver alone promises nothing. This page
is the explicit contract on top of it: which exported surfaces external
integrators can pin against, and which may still move.

**The rule.** A **stable** export changes shape only with a minor version
bump and a CHANGELOG entry — never in a patch release. An **experimental**
export may change in any release. Everything not listed here is
experimental by default. A `public-api-surface` probe (planned alongside
this ledger) imports every declared-stable symbol and type-asserts its
signature, so a breaking drift fails CI the same way any other spec
violation does.

## Stable

| Export | Package | Contract |
| --- | --- | --- |
| `EventEnvelope`, `EventEnvelopeSchema` | `@qmilab/lodestar-core` | The envelope: `id`, `seq`, `type`, `schema_version`, `project_id`, `session_id`, `actor_id`, `timestamp`, `logical_clock`, `causal_parent_ids`, `payload_hash`, `payload`, `versions`, `signature?`. Additive growth only; payload shapes are versioned per event type via `schema_version`. |
| `EventLogReader` | `@qmilab/lodestar-event-log` | `new EventLogReader(rootDir)`; `readAll(projectId): Promise<EventEnvelope[]>` (seq order); `readSession(projectId, sessionId): Promise<EventEnvelope[]>` (logical-clock order). Log layout `<root>/<project_id>/YYYY-MM-DD.ndjson` is part of the contract. |
| `canonicalHash` | `@qmilab/lodestar-event-log` | sha-256 hex over canonical JSON (sorted keys). The tamper-evidence primitive; `payload_hash === canonicalHash(payload)` for every unredacted envelope. |
| `projectChain` | `@qmilab/lodestar-trace` | `projectChain(events: EventEnvelope[], opts: { session_id, project_id }): ChainProjection`. Pure, no I/O. **Tolerant projection is contractual**: unknown event types never throw — they are retained in `raw_events`. `ChainProjection` fields grow additively. Known sharp edge (documented, kept for now): `actor_ids` is a `Set<string>`, not JSON-safe — serialize via the viewer's `toWireProjection` pattern. |
| `renderReport` | `@qmilab/lodestar-trace` | `renderReport(projection, opts?: RenderOptions): string`. The **signature** is stable; the markdown text is explicitly *not* contractual (sections may be added or reworded). Parse the projection, not the report. |
| `signApprovalResolution`, `verifyApprovalSignature`, `canonicalApprovalResolutionHash`, `generateApproverKeyPair`, `assertValidApproverKeys`, `ApprovalSignatureError` | `@qmilab/lodestar-policy-kernel` | Ed25519 over the canonical resolution document `{ request_id, action_id, kind, approver_id, reason?, at }` (`reason` omitted when unset). Keys: SPKI PEM public / PKCS#8 PEM private. The reject set of `verifyApprovalSignature` (unsigned, tampered hash, signer mismatch, unpinned signer, non-ed25519, bad bytes) is contractual. |
| `buildTrace`, `toOtlpTraceJson`, `traceIdFor`, `spanIdFor`, `isoToUnixNano` | `@qmilab/lodestar-otel-exporter` | The OTLP IR. Deterministic ids (pure function of project/session/local ids — re-export is idempotent) and the redaction marker shape (`lodestar.redacted: true` + `lodestar.payload_hash`) are contractual. |
| `ApprovalResolutionSchema` + the side-channel layout | `@qmilab/lodestar-guard-mcp` | The resolution wire shape `{ request_id, action_id, kind, approver_id, reason?, at, signature? }` and the file channel layout `<log_root>/.approvals/<project_id>/<request_id>.json` with atomic temp-file + rename writes. Any external resolver writes exactly this. |

## Stable from first release (planned surfaces)

| Surface | Where | Contract |
| --- | --- | --- |
| `lodestar.session_ship@1` wire format | `@qmilab/lodestar-ship` (ADR-0014) | NDJSON: one manifest record, then one wrapper record per event (`{ v, redacted, envelope }`); redacted records keep the original `payload_hash`. Receiver dedupe key `(project_id, session_id, seq)`; re-ship is idempotent. Versioned from birth. |
| `ApprovalChannel` | `@qmilab/lodestar-guard-mcp` (ADR-0015) | `announce?(request)` / `fetch(ref)` / `consume?(ref)`; `fetch` returns an untrusted `ApprovalResolution` that the proxy verifies before promotion. The HTTP channel's route shapes (`GET/POST/DELETE {endpoint}/v1/approvals/…`) version with it. |

## Experimental

May change in any release; pin at your own risk:

- `loadSessionEvents`, `findProjectForSession`, `defaultLogRoot`,
  `describeEvent`, `findEventById` (`@qmilab/lodestar-trace`) — CLI
  conveniences, deliberately sharper-edged than the projection core.
- `listSessions`, `pendingApprovals`, `readAllEvents`, `toWireProjection`,
  `startViewer` (`@qmilab/lodestar-viewer`) — `pendingApprovals` is slated to
  graduate into `@qmilab/lodestar-trace` (with a viewer re-export); it joins
  the stable tier there.
- `exportSession` options (`@qmilab/lodestar-otel-exporter`) — the CLI-shaped
  wrapper around the stable IR.
- Everything in `@qmilab/lodestar-harness`, the firewall store interfaces,
  and the cognitive-core extractor/linker seams — evolving with the probe
  surface.

## Notes for integrators

- The event log is the source of truth; every read-side surface here is a
  pure projection over `EventEnvelope[]`. If a projection lacks something,
  read the envelopes.
- The report markdown and the viewer SPA are presentation, not API. Build on
  `projectChain` / the OTLP IR / the ship wire format instead.
- Sensitivity gating is load-bearing on every export path: content above the
  configured ceiling ships as structural metadata plus `payload_hash` only.
  Treat a redaction marker as a verifiable commitment, not an error.
