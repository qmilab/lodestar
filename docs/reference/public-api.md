# Public API stability

Lodestar is pre-1.0 (`0.x`), where semver alone promises nothing. This page
is the explicit contract on top of it: which exported surfaces external
integrators can pin against, and which may still move.

**The rule.** A **stable** export changes shape only with a minor version
bump and a CHANGELOG entry — never in a patch release. An **experimental**
export may change in any release. Everything not listed here is
experimental by default. The `public-api-surface` probe (in
`packs/lodestar-core/`) imports every declared-stable symbol and pins its
signature both ways — at compile time (the strict-TS `typecheck:packs`
gate) and at runtime (each schema round-trips a valid payload and rejects
an invalid one; each pure function is exercised for its documented
behavior) — so a breaking drift fails CI the same way any other spec
violation does. One stable surface is not yet pinned by the probe —
`ApprovalChannel` (ADR-0015), which landed after the probe was written; a
follow-up adds it.

## Stable

| Export | Package | Contract |
| --- | --- | --- |
| `EventEnvelope`, `EventEnvelopeSchema` | `@qmilab/lodestar-core` | The envelope: `id`, `seq`, `type`, `schema_version`, `project_id`, `session_id`, `actor_id`, `timestamp`, `logical_clock`, `causal_parent_ids`, `payload_hash`, `payload`, `versions`, `signature?`. Additive growth only; payload shapes are versioned per event type via `schema_version`. |
| `EventLogReader` | `@qmilab/lodestar-event-log` | `new EventLogReader(rootDir)`; `readAll(projectId): Promise<EventEnvelope[]>` (seq order); `readSession(projectId, sessionId): Promise<EventEnvelope[]>` (logical-clock order). Log layout `<root>/<project_id>/YYYY-MM-DD.ndjson` is part of the contract. |
| `canonicalHash` | `@qmilab/lodestar-event-log` | sha-256 hex over canonical JSON (sorted keys). The tamper-evidence primitive; `payload_hash === canonicalHash(payload)` for every unredacted envelope. |
| `projectChain` | `@qmilab/lodestar-trace` | `projectChain(events: EventEnvelope[], opts: { session_id, project_id }): ChainProjection`. Pure, no I/O. **Tolerant projection is contractual**: unknown event types never throw — they are retained in `raw_events`. `ChainProjection` fields grow additively. Known sharp edge (documented, kept for now): `actor_ids` is a `Set<string>`, not JSON-safe — serialize via the viewer's `toWireProjection` pattern. |
| `renderReport` | `@qmilab/lodestar-trace` | `renderReport(projection, opts?: RenderOptions): string`. The **signature** is stable; the markdown text is explicitly *not* contractual (sections may be added or reworded). Parse the projection, not the report. |
| `pendingApprovals`, `PendingApproval` | `@qmilab/lodestar-trace` | `pendingApprovals(events: EventEnvelope[]): PendingApproval[]`. Pure, no I/O — the same family as `projectChain`. Derives the open-hold queue: every `approval.requested@1` with no matching `approval.granted@1` / `approval.denied@1` / `approval.expired@1`, oldest-first. `PendingApproval` (`{ project_id, session_id, request_id, action_id, reason, required_authority, requested_at, deadline?, status: "pending" }`) grows additively. **Read-only by construction** — surfaces *what is waiting*, never resolves it (resolution is the separate write-side surface). Re-exported unchanged from `@qmilab/lodestar-viewer` for source compatibility. |
| `signApprovalResolution`, `verifyApprovalSignature`, `canonicalApprovalResolutionHash`, `generateApproverKeyPair`, `assertValidApproverKeys`, `ApprovalSignatureError` | `@qmilab/lodestar-policy-kernel` | Ed25519 over the canonical resolution document `{ request_id, action_id, kind, approver_id, reason?, at }` (`reason` omitted when unset). Keys: SPKI PEM public / PKCS#8 PEM private. The reject set of `verifyApprovalSignature` (unsigned, tampered hash, signer mismatch, unpinned signer, non-ed25519, bad bytes) is contractual. |
| `buildTrace`, `toOtlpTraceJson`, `traceIdFor`, `spanIdFor`, `isoToUnixNano` | `@qmilab/lodestar-otel-exporter` | The OTLP IR. Deterministic ids (pure function of project/session/local ids — re-export is idempotent) and the redaction marker shape (`lodestar.redacted: true` + `lodestar.payload_hash`) are contractual. |
| `ApprovalResolutionSchema` + the side-channel layout | `@qmilab/lodestar-guard` (re-exported from `-guard-mcp`) | The resolution wire shape `{ request_id, action_id, kind, approver_id, reason?, at, signature? }` and the file channel layout `<log_root>/.approvals/<project_id>/<request_id>.json` with atomic temp-file + rename writes. Any external resolver writes exactly this. (Graduated to `-guard` by ADR-0024/0025 when the runtime gate became a second consumer; `-guard-mcp` re-exports it unchanged.) |
| `ApprovalChannel`, `FileApprovalChannel`, `HttpApprovalChannel`, `createApprovalChannel`, `ApprovalChannelConfigSchema`, `httpChannelForbidsUnsigned` | `@qmilab/lodestar-guard` (re-exported from `-guard-mcp`) | The approval **transport** seam (ADR-0015): `announce?(request)` / `fetch(ref)` / `consume?(ref)`. `fetch` returns an UNTRUSTED `ApprovalResolution` the consumer signature-verifies *after* transport — a hostile channel can only delay an approval, never forge one. `FileApprovalChannel` (default) wraps the `.approvals/` file layout; `HttpApprovalChannel` reads a remote service whose route shapes (`POST {endpoint}/v1/approvals`, `GET`/`DELETE {endpoint}/v1/approvals/{project_id}/{request_id}`) version with it. An HTTP channel requires a pinned approver key (`httpChannelForbidsUnsigned`) — an unsigned remote channel is unrepresentable. |
| `CalibrationComputedPayloadSchema`, `CALIBRATION_COMPUTED_EVENT_TYPE`, `CALIBRATION_COMPUTED_SCHEMA_VERSION` | `@qmilab/lodestar-core` | The `calibration.computed@1` event payload — the wire surface, not the harness math. `{ computation_id, triggered_by, cursor: { from_seq, to_seq }, report, computed_at }`, where `report` is `{ sample_count, classes[], overall, flagged_classes[], config }` and a metrics block is `{ n, mean_confidence, empirical_accuracy, brier_score, ece, calibration_gap, overconfident }`. Versioned from birth via the envelope `schema_version` (`"1"`); additive growth only. The `Calibrator` that *computes* these stays experimental in `-harness` — only the recorded event shape is stable. |
| `SentinelAlertPayloadSchema`, `SentinelSubjectSchema`, `SentinelSeveritySchema`, `SENTINEL_ALERTED_EVENT_TYPE`, `SENTINEL_ALERTED_SCHEMA_VERSION` | `@qmilab/lodestar-core` | The `sentinel.alerted@1` alert wire format — what a sentinel emits, not the sentinels themselves. `{ alert_id, sentinel_name, rule, severity, subject: { kind, id }, message, observed_event_ids, detail, detected_at, rationale_id? }`; `severity ∈ {info, warning, critical}`, `subject.kind ∈ {belief, action, decision, tool_sequence}`, and `observed_event_ids` are also the alert envelope's `causal_parent_ids`. `detail` is an open record by design, so a new sentinel ships without a core bump. Versioned from birth (`"1"`). The `Sentinel`/`SentinelRunner` in `-harness` stay experimental — only the emitted event shape is stable. |

## Stable from first release (planned surfaces)

| Surface | Where | Contract |
| --- | --- | --- |
| `lodestar.session_ship@1` wire format | `@qmilab/lodestar-ship` (ADR-0014) | NDJSON: one manifest record, then one wrapper record per event (`{ v, redacted, envelope }`); redacted records keep the original `payload_hash`. Receiver dedupe key `(project_id, session_id, seq)`; re-ship is idempotent. Versioned from birth. (`ApprovalChannel`, ADR-0015, has landed and moved to the **Stable** table above.) |

## Experimental

May change in any release; pin at your own risk:

- `loadSessionEvents`, `findProjectForSession`, `defaultLogRoot`,
  `describeEvent`, `findEventById` (`@qmilab/lodestar-trace`) — CLI
  conveniences, deliberately sharper-edged than the projection core.
- `listSessions`, `readAllEvents`, `toWireProjection`, `startViewer`
  (`@qmilab/lodestar-viewer`) — CLI/server conveniences over the log root.
  (`pendingApprovals` / `PendingApproval` have graduated to
  `@qmilab/lodestar-trace`'s stable tier; the viewer re-exports them
  unchanged.)
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
