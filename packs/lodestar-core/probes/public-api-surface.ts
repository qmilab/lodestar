#!/usr/bin/env bun
/**
 * Probe: public_api_surface
 *
 * The executable counterpart to `docs/reference/public-api.md`. That page is
 * Lodestar's stability contract: the exported surfaces external integrators may
 * pin against, which change shape only with a minor bump + a CHANGELOG entry —
 * never in a patch. This probe imports every declared-stable symbol and pins it
 * two ways, so a breaking drift fails CI the same way any other spec violation
 * does:
 *
 *  1. **Compile-time** — each function/type is assigned to its documented
 *     signature via `pinType<…>(real)`, and each schema's documented fields are
 *     read off the parsed result into typed locals. A removed symbol, a retyped
 *     parameter, a narrowed return, or a renamed/dropped field fails
 *     `typecheck:packs` (the strict-TS gate every probe runs under in CI).
 *  2. **Runtime** — each schema round-trips a canonical valid example and
 *     rejects a known-invalid one; each pure function is exercised for its
 *     documented behavior (determinism, hash stability, the log layout, the
 *     signed-resolution reject set, the OTLP IR shape).
 *
 * Scope: the **## Stable** table plus the shipped **first-release** surfaces
 * (`lodestar.session_ship@1`). The approval **transport** seam `ApprovalChannel`
 * (ADR-0015 / #134) is pinned below — it landed after the probe was first written
 * and joined the Stable table; this probe is its executable mirror. The
 * declarative **action-policy document** family (`PolicySchema` & co., #135) is
 * pinned below too — the wire format external policy authors / distributors build
 * against, document-shape only (the verdict semantics stay the engine's contract).
 * The trust-pack registry wire shapes (#136) — the `lodestar.probe-pack.json`
 * manifest, the immutable `PackSourceRef`, the `lodestar.pack-index.json` discovery
 * index, and the `badges/*.badge.json` verification badge — are pinned below as well;
 * wire-shape only (the verify-on-load crypto stays `@qmilab/lodestar-core/crypto`).
 *
 * Assertions (per surface): the symbol imports, its signature matches the
 * ledger, and — for schemas — a valid payload parses and an invalid one is
 * rejected; for pure functions, the documented behavior holds.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type ApprovalRequirement,
  ApprovalRequirementSchema,
  CALIBRATION_COMPUTED_EVENT_TYPE,
  CALIBRATION_COMPUTED_SCHEMA_VERSION,
  CalibrationComputedPayloadSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  GitPackSourceSchema,
  LocalPackSourceSchema,
  NpmPackSourceSchema,
  PACK_BADGES_DIRNAME,
  PACK_BADGE_FILE_SUFFIX,
  PACK_BADGE_SPEC_VERSION,
  PACK_INDEX_FILENAME,
  PACK_INDEX_SPEC_VERSION,
  PROBE_PACK_MANIFEST_FILENAME,
  PROBE_PACK_SPEC_VERSION,
  type PackBadge,
  type PackBadgeKind,
  PackBadgeKindSchema,
  PackBadgeSchema,
  type PackBadgeSubject,
  PackBadgeSubjectSchema,
  type PackContentDigest,
  PackContentDigestSchema,
  type PackFileDigest,
  PackFileDigestSchema,
  type PackIndex,
  type PackIndexBadgeSummary,
  PackIndexBadgeSummarySchema,
  type PackIndexEntry,
  PackIndexEntrySchema,
  type PackIndexPublisherKey,
  PackIndexPublisherKeySchema,
  PackIndexSchema,
  type PackSourceRef,
  PackSourceRefSchema,
  type Policy,
  type PolicyEffect,
  PolicyEffectSchema,
  type PolicyMatch,
  PolicyMatchSchema,
  type PolicyRule,
  PolicyRuleSchema,
  PolicySchema,
  type ProbeEntry,
  ProbeEntrySchema,
  type ProbePackManifest,
  ProbePackManifestSchema,
  type ProbePackSourceType,
  ProbePackSourceTypeSchema,
  type ProbeResultsBadge,
  ProbeResultsBadgeSchema,
  type RequiredAuthority,
  RequiredAuthoritySchema,
  SENTINEL_ALERTED_EVENT_TYPE,
  SENTINEL_ALERTED_SCHEMA_VERSION,
  type SecurityScanBadge,
  SecurityScanBadgeSchema,
  SentinelAlertPayloadSchema,
  type SentinelEntry,
  SentinelEntrySchema,
  SentinelSeveritySchema,
  SentinelSubjectSchema,
  type UnsignedPackBadge,
} from "@qmilab/lodestar-core"
import { EventLogReader, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  type ApprovalChannel,
  type ApprovalChannelConfig,
  ApprovalChannelConfigSchema,
  ApprovalResolutionSchema,
  FileApprovalChannel,
  type HttpApprovalChannel,
  type SecretValue,
  approvalResolutionPath,
  approvalsChannelDir,
  createApprovalChannel,
  httpChannelForbidsUnsigned,
} from "@qmilab/lodestar-guard-mcp"
import {
  buildTrace,
  isoToUnixNano,
  spanIdFor,
  toOtlpTraceJson,
  traceIdFor,
} from "@qmilab/lodestar-otel-exporter"
import {
  ApprovalSignatureError,
  assertValidApproverKeys,
  canonicalApprovalResolutionHash,
  generateApproverKeyPair,
  signApprovalResolution,
  verifyApprovalSignature,
} from "@qmilab/lodestar-policy-kernel"
import { ShipManifestSchema, ShipRecordSchema } from "@qmilab/lodestar-ship"
import {
  type ChainProjection,
  type PendingApproval,
  type RenderOptions,
  type WireProjection,
  pendingApprovals,
  projectChain,
  renderReport,
  toWireProjection,
} from "@qmilab/lodestar-trace"

// ─── compile-time signature pins ──────────────────────────────────────────
//
// `pinType<Expected>(real)` asserts `real` is assignable to the documented
// signature `Expected`. The body is empty — the assertion is purely the type
// argument against the argument's inferred type, erased at runtime. A breaking
// drift (param retyped, return narrowed, arity grown) fails `typecheck:packs`.
function pinType<Expected>(_value: Expected): void {
  /* type-only assertion; no runtime effect */
}

// @qmilab/lodestar-event-log
pinType<(value: unknown) => string>(canonicalHash)
pinType<new (rootDir: string) => EventLogReader>(EventLogReader)
pinType<(projectId: string) => Promise<EventEnvelope[]>>(
  EventLogReader.prototype.readAll as EventLogReader["readAll"],
)
pinType<(projectId: string, sessionId: string) => Promise<EventEnvelope[]>>(
  EventLogReader.prototype.readSession as EventLogReader["readSession"],
)

// @qmilab/lodestar-trace — pure projections, no I/O
pinType<
  (events: EventEnvelope[], opts: { session_id: string; project_id: string }) => ChainProjection
>(projectChain)
pinType<(projection: ChainProjection, opts?: RenderOptions) => string>(renderReport)
pinType<(events: EventEnvelope[]) => PendingApproval[]>(pendingApprovals)
pinType<(projection: ChainProjection) => WireProjection>(toWireProjection)

// @qmilab/lodestar-otel-exporter — deterministic ids + the OTLP IR
pinType<(projectId: string, sessionId: string) => string>(traceIdFor)
pinType<(projectId: string, sessionId: string, kind: string, localId: string) => string>(spanIdFor)
pinType<(iso: string | undefined) => string>(isoToUnixNano)

// @qmilab/lodestar-policy-kernel — the signed-approval surface
pinType<
  (doc: {
    request_id: string
    action_id: string
    kind: "granted" | "denied"
    approver_id: string
    reason?: string
    at: string
  }) => string
>(canonicalApprovalResolutionHash)
pinType<(keys: ReadonlyArray<{ actor_id: string; public_key: string }>) => void>(
  assertValidApproverKeys,
)

// @qmilab/lodestar-guard (re-exported from -guard-mcp) — the approval transport
// seam (ADR-0015). `createApprovalChannel` is the documented public constructor;
// `FileApprovalChannel` / `HttpApprovalChannel` are its `ApprovalChannel` outputs.
pinType<
  (
    config: ApprovalChannelConfig,
    ctx: { logRoot: string; resolveToken?: (envName: string) => SecretValue },
  ) => ApprovalChannel
>(createApprovalChannel)
pinType<new (logRoot: string) => ApprovalChannel>(FileApprovalChannel)
pinType<
  (approvals: {
    channel?: { kind?: string }
    authorized_keys?: ReadonlyArray<unknown>
    allow_unsigned?: boolean
  }) => { ok: true } | { ok: false; reason: string }
>(httpChannelForbidsUnsigned)
// Both classes are `ApprovalChannel` implementations (asserted at the type level,
// so a drift in `fetch` / `announce` / `consume` fails `typecheck:packs`). The
// `ApprovalChannel` interface itself is pinned by these assignments referencing it.
const _fileIsChannel: ApprovalChannel = new FileApprovalChannel("/x")
void _fileIsChannel
type HttpIsChannel = InstanceType<typeof HttpApprovalChannel> extends ApprovalChannel ? true : false
const _httpIsChannel: HttpIsChannel = true
void _httpIsChannel

// ─── runtime checks ───────────────────────────────────────────────────────

const notes: string[] = []
const failures: string[] = []

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    notes.push(`✓ ${label}`)
  } catch (err) {
    failures.push(`✗ ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const HEX = /^[0-9a-f]+$/

// canonical example payloads used by several schema round-trips
const validEnvelope = {
  id: "evt-1",
  seq: 0,
  type: "decision.made",
  schema_version: "1",
  project_id: "proj",
  session_id: "sess",
  actor_id: "actor",
  timestamp: "2026-01-01T00:00:00.000Z",
  logical_clock: 0,
  causal_parent_ids: [],
  payload_hash: canonicalHash({ ok: true }),
  payload: { ok: true },
  versions: {},
}

// ── @qmilab/lodestar-core: EventEnvelope ──────────────────────────────────
await check("core: EventEnvelopeSchema parses + exposes every documented field", () => {
  const parsed = EventEnvelopeSchema.safeParse(validEnvelope)
  expect(parsed.success, `valid envelope rejected: ${JSON.stringify(parsed.error?.issues)}`)
  const e: EventEnvelope = parsed.data
  // Reading each documented field pins the shape at compile time too.
  const id: string = e.id
  const seq: number = e.seq
  const type: string = e.type
  const schemaVersion: string = e.schema_version
  const projectId: string = e.project_id
  const sessionId: string = e.session_id
  const actorId: string = e.actor_id
  const ts: string = e.timestamp
  const clock: number = e.logical_clock
  const parents: string[] = e.causal_parent_ids
  const hash: string = e.payload_hash
  const payload: unknown = e.payload
  void [id, seq, type, schemaVersion, projectId, sessionId, actorId, ts, clock, parents, payload]
  void e.versions
  void e.signature
  expect(hash === canonicalHash({ ok: true }), "payload_hash !== canonicalHash(payload)")
})
await check("core: EventEnvelopeSchema rejects a malformed envelope (missing seq)", () => {
  const { seq: _seq, ...noSeq } = validEnvelope
  expect(!EventEnvelopeSchema.safeParse(noSeq).success, "envelope without seq was accepted")
})

// ── @qmilab/lodestar-core: calibration.computed@1 ─────────────────────────
const metrics = {
  n: 0,
  mean_confidence: 0,
  empirical_accuracy: 0,
  brier_score: 0,
  ece: 0,
  calibration_gap: 0,
  overconfident: false,
}
const validCalibration = {
  computation_id: "calc-1",
  triggered_by: "cli",
  // empty window ⟺ zero-sample report (the schema's biconditional refinement)
  cursor: { from_seq: 5, to_seq: 5 },
  report: {
    sample_count: 0,
    classes: [],
    overall: metrics,
    flagged_classes: [],
    config: {
      bins: 10,
      min_samples: 1,
      ece_threshold: 0.1,
      gap_threshold: 0.1,
      outcome_sources: ["action_outcome"],
      include_synthetic_authority: false,
    },
  },
  computed_at: "2026-01-01T00:00:00.000Z",
}
await check(
  "core: CalibrationComputedPayloadSchema round-trips + exposes documented fields",
  () => {
    const parsed = CalibrationComputedPayloadSchema.safeParse(validCalibration)
    expect(
      parsed.success,
      `valid calibration payload rejected: ${JSON.stringify(parsed.error?.issues)}`,
    )
    const computationId: string = parsed.data.computation_id
    const triggeredBy: string = parsed.data.triggered_by
    const fromSeq: number = parsed.data.cursor.from_seq
    const toSeq: number = parsed.data.cursor.to_seq
    const sampleCount: number = parsed.data.report.sample_count
    const computedAt: string = parsed.data.computed_at
    void [computationId, triggeredBy, fromSeq, toSeq, sampleCount, computedAt]
  },
)
await check(
  "core: CalibrationComputedPayloadSchema enforces window⟺sample-count refinement",
  () => {
    const lying = { ...validCalibration, cursor: { from_seq: 0, to_seq: 9 } } // populated window, zero samples
    expect(
      !CalibrationComputedPayloadSchema.safeParse(lying).success,
      "non-replayable cursor accepted",
    )
  },
)
await check("core: calibration.computed@1 type + version constants are stable literals", () => {
  const eventType: "calibration.computed" = CALIBRATION_COMPUTED_EVENT_TYPE
  const version: "1" = CALIBRATION_COMPUTED_SCHEMA_VERSION
  expect(eventType === "calibration.computed", `event type drifted: ${eventType}`)
  expect(version === "1", `schema version drifted: ${version}`)
})

// ── @qmilab/lodestar-core: sentinel.alerted@1 ─────────────────────────────
const validAlert = {
  alert_id: "alert-1",
  sentinel_name: "suspicious-memory-origin",
  rule: "external-egress-after-untrusted-read",
  severity: "critical",
  subject: { kind: "belief", id: "belief-1" },
  message: "a poisoned read fed a downstream egress",
  observed_event_ids: ["evt-1"],
  detail: {},
  detected_at: "2026-01-01T00:00:00.000Z",
}
await check("core: SentinelAlertPayloadSchema round-trips + exposes documented fields", () => {
  const parsed = SentinelAlertPayloadSchema.safeParse(validAlert)
  expect(parsed.success, `valid alert rejected: ${JSON.stringify(parsed.error?.issues)}`)
  const alertId: string = parsed.data.alert_id
  const sentinelName: string = parsed.data.sentinel_name
  const rule: string = parsed.data.rule
  const message: string = parsed.data.message
  const observed: string[] = parsed.data.observed_event_ids
  const detail: Record<string, unknown> = parsed.data.detail
  const detectedAt: string = parsed.data.detected_at
  void [alertId, sentinelName, rule, message, observed, detail, detectedAt]
})
await check("core: SentinelAlertPayloadSchema requires ≥1 observed_event_id", () => {
  const empty = { ...validAlert, observed_event_ids: [] }
  expect(
    !SentinelAlertPayloadSchema.safeParse(empty).success,
    "alert with no observed events accepted",
  )
})
await check("core: SentinelSubjectSchema pins the subject-kind enum", () => {
  expect(
    SentinelSubjectSchema.safeParse({ kind: "belief", id: "b" }).success,
    "valid subject rejected",
  )
  expect(
    !SentinelSubjectSchema.safeParse({ kind: "nope", id: "b" }).success,
    "unknown subject kind accepted",
  )
})
await check("core: SentinelSeveritySchema pins the severity enum", () => {
  expect(SentinelSeveritySchema.safeParse("critical").success, "valid severity rejected")
  expect(!SentinelSeveritySchema.safeParse("fatal").success, "unknown severity accepted")
})
await check("core: sentinel.alerted@1 type + version constants are stable literals", () => {
  const eventType: "sentinel.alerted" = SENTINEL_ALERTED_EVENT_TYPE
  const version: "1" = SENTINEL_ALERTED_SCHEMA_VERSION
  expect(eventType === "sentinel.alerted", `event type drifted: ${eventType}`)
  expect(version === "1", `schema version drifted: ${version}`)
})

// ── @qmilab/lodestar-core: the declarative action-policy document ─────────
const validPolicy = {
  id: "policy-egress",
  version: "1.0.0",
  rules: [
    {
      match: {
        tool: "git.*",
        max_blast_radius: "project",
        reversibility: ["reversible", "compensable"],
        required_level_lte: 3,
      },
      effect: "allow",
      reason: "in-project git up to L3 is allowed",
    },
    {
      match: { tool: "http.request" },
      effect: "require_approval",
      approval: {
        required_authority: { min_trust_baseline: 0.9, sensitivity_clearance: "secret" },
      },
      reason: "external HTTP egress requires sign-off",
    },
    { match: {}, effect: "deny", reason: "structural deny default, made explicit" },
  ],
  signature: {
    signer_id: "operator",
    payload_hash: canonicalHash({ id: "policy-egress", version: "1.0.0", rules: [] }),
    algorithm: "ed25519",
    signature: "ZmFrZS1zaWduYXR1cmU=",
    at: "2026-01-01T00:00:00.000Z",
  },
  signed_by: "operator",
}
await check("core: PolicySchema round-trips a signed document + exposes documented fields", () => {
  const parsed = PolicySchema.safeParse(validPolicy)
  expect(parsed.success, `valid policy rejected: ${JSON.stringify(parsed.error?.issues)}`)
  const policy: Policy = parsed.data
  const id: string = policy.id
  const version: string = policy.version
  const rules: PolicyRule[] = policy.rules
  const signer: string | undefined = policy.signed_by
  void [id, version, signer]
  expect(rules.length === 3, `expected 3 rules, got ${rules.length}`)

  // the require_approval rule carries its authority; reading each field pins the
  // { match, effect, approval?, reason } shape at compile time too.
  const rule = rules[1]
  expect(rule !== undefined, "rule[1] missing from the round-trip")
  const match: PolicyMatch = rule.match
  const effect: PolicyEffect = rule.effect
  const reason: string = rule.reason
  const approval: ApprovalRequirement | undefined = rule.approval
  void [match, reason]
  expect(effect === "require_approval", "rule[1] effect not round-tripped")
  const authority: RequiredAuthority | undefined = approval?.required_authority
  expect(authority?.min_trust_baseline === 0.9, "required_authority not round-tripped")
  expect(authority?.sensitivity_clearance === "secret", "sensitivity_clearance not round-tripped")
  // the signed-policy envelope round-trips with its documented fields
  expect(policy.signature?.algorithm === "ed25519", "signature envelope algorithm drifted")
  expect(policy.signature?.signer_id === "operator", "signature envelope signer_id drifted")
})
await check("core: PolicyEffectSchema pins the wire effect enum", () => {
  for (const e of ["allow", "deny", "require_approval"] as const) {
    const effect: PolicyEffect = e
    expect(PolicyEffectSchema.safeParse(effect).success, `valid effect '${e}' rejected`)
  }
  // `hold` is the engine's runtime verdict, not a wire effect — it must not leak in.
  expect(
    !PolicyEffectSchema.safeParse("hold").success,
    "the runtime verdict 'hold' leaked into the wire effect enum",
  )
})
await check("core: PolicyRuleSchema accepts approval only on a require_approval rule", () => {
  const ok = PolicyRuleSchema.safeParse({
    match: { tool: "http.*" },
    effect: "require_approval",
    approval: { required_authority: {} },
    reason: "needs sign-off",
  })
  expect(
    ok.success,
    `require_approval rule with approval rejected: ${JSON.stringify(ok.error?.issues)}`,
  )
  const bad = PolicyRuleSchema.safeParse({
    match: { tool: "http.*" },
    effect: "allow",
    approval: { required_authority: {} },
    reason: "an allow rule cannot carry approval authority",
  })
  expect(!bad.success, "approval was accepted on a non-require_approval rule")
})
await check("core: ApprovalRequirementSchema wraps an optional, bounded required_authority", () => {
  const withAuthority = ApprovalRequirementSchema.safeParse({
    required_authority: { min_trust_baseline: 0.8 },
  })
  expect(withAuthority.success, "approval requirement with authority rejected")
  // an empty approval object is valid — "any configured resolver may approve".
  const empty: ApprovalRequirement = ApprovalRequirementSchema.parse({})
  void empty
  expect(
    !ApprovalRequirementSchema.safeParse({ required_authority: { min_trust_baseline: 2 } }).success,
    "approval requirement passed an out-of-range trust baseline",
  )
})
await check(
  "core: PolicyMatchSchema is all-AND with an empty-match wildcard, bounded to the trust ladder",
  () => {
    const empty: PolicyMatch = PolicyMatchSchema.parse({})
    void empty // an empty match is the documented wildcard
    expect(
      PolicyMatchSchema.safeParse({ required_level_lte: 4 }).success,
      "a valid trust-level bound was rejected",
    )
    expect(
      !PolicyMatchSchema.safeParse({ required_level_lte: 6 }).success,
      "a trust level above the 0–5 ladder was accepted",
    )
    expect(
      !PolicyMatchSchema.safeParse({ reversibility: ["sometimes"] }).success,
      "an unknown reversibility was accepted",
    )
    expect(
      !PolicyMatchSchema.safeParse({ max_blast_radius: "galaxy" }).success,
      "an unknown blast radius was accepted",
    )
  },
)
await check("core: RequiredAuthoritySchema pins the approver-constraint shape", () => {
  const parsed = RequiredAuthoritySchema.safeParse({
    min_trust_baseline: 0.5,
    sensitivity_clearance: "confidential",
  })
  expect(parsed.success, `valid authority rejected: ${JSON.stringify(parsed.error?.issues)}`)
  const authority: RequiredAuthority = parsed.data
  void authority
  expect(RequiredAuthoritySchema.safeParse({}).success, "empty authority (any resolver) rejected")
  expect(
    !RequiredAuthoritySchema.safeParse({ min_trust_baseline: 1.5 }).success,
    "an out-of-range trust baseline was accepted",
  )
  expect(
    !RequiredAuthoritySchema.safeParse({ sensitivity_clearance: "ultra" }).success,
    "an unknown clearance was accepted",
  )
})
await check("core: PolicySchema enforces the signed_by ↔ signature.signer_id binding", () => {
  // signature present but signed_by missing → rejected
  const { signed_by: _drop, ...noSignedBy } = validPolicy
  expect(
    !PolicySchema.safeParse(noSignedBy).success,
    "a signed policy with no signed_by was accepted",
  )
  // signed_by present but ≠ signature.signer_id → rejected
  expect(
    !PolicySchema.safeParse({ ...validPolicy, signed_by: "someone-else" }).success,
    "a signed_by that disagrees with signer_id was accepted",
  )
  // signed_by present on an unsigned draft → rejected
  const { signature: _sig, ...unsignedWithSignedBy } = validPolicy
  expect(
    !PolicySchema.safeParse(unsignedWithSignedBy).success,
    "signed_by on an unsigned draft was accepted",
  )
  // a clean unsigned draft (neither field) parses
  const { signature: _s, signed_by: _sb, ...draft } = validPolicy
  expect(PolicySchema.safeParse(draft).success, "a clean unsigned draft was rejected")
})

// ── @qmilab/lodestar-core: the lodestar.probe-pack.json manifest ──────────
const validManifest = {
  name: "example-pack",
  version: "1.0.0",
  spec_version: "1",
  source_type: "npm",
  description: "an example pack",
  coverage_areas: ["prompt-injection"],
  invariants: ["no-self-promote"],
  probes: [{ name: "example-probe", file: "probes/example.ts" }],
  sentinels: [{ id: "low-confidence-action" }],
  author_id: "pack-author",
  content_digest: {
    algorithm: "sha256",
    files: [{ path: "probes/example.ts", sha256: "a".repeat(64) }],
  },
  signature: {
    signer_id: "pack-author",
    payload_hash: "b".repeat(64),
    algorithm: "ed25519",
    signature: "ZmFrZQ==",
    at: "2026-01-01T00:00:00.000Z",
  },
}
await check("core: ProbePackManifestSchema round-trips a signed manifest + exposes fields", () => {
  const parsed = ProbePackManifestSchema.safeParse(validManifest)
  expect(parsed.success, `valid manifest rejected: ${JSON.stringify(parsed.error?.issues)}`)
  const manifest: ProbePackManifest = parsed.data
  const name: string = manifest.name
  const version: string = manifest.version
  const sourceType: ProbePackSourceType = manifest.source_type
  void [name, version, sourceType]

  const probe = manifest.probes[0]
  expect(probe !== undefined, "manifest dropped its probe entry")
  const entry: ProbeEntry = probe
  expect(
    entry.name === "example-probe" && entry.file === "probes/example.ts",
    "probe entry drifted",
  )

  const sentinel = manifest.sentinels?.[0]
  expect(sentinel !== undefined, "manifest dropped its sentinel entry")
  const sentinelEntry: SentinelEntry = sentinel
  expect(sentinelEntry.id === "low-confidence-action", "sentinel entry drifted")

  // content_digest is part of the canonical (signed) document — its per-file shape
  // is what binds the probe bytes.
  const digest: PackContentDigest | undefined = manifest.content_digest
  expect(digest?.algorithm === "sha256", "content_digest algorithm drifted")
  const fileDigest: PackFileDigest | undefined = digest?.files[0]
  expect(fileDigest?.sha256.length === 64, "content_digest per-file sha256 not round-tripped")
  expect(manifest.signature?.algorithm === "ed25519", "signature envelope drifted")
})
await check("core: ProbePackManifestSchema pins spec_version + requires ≥1 probe", () => {
  expect(
    !ProbePackManifestSchema.safeParse({ ...validManifest, spec_version: "2" }).success,
    "an unknown manifest spec_version was accepted",
  )
  expect(
    !ProbePackManifestSchema.safeParse({ ...validManifest, probes: [] }).success,
    "a manifest with no probes was accepted",
  )
})
await check("core: ProbeEntrySchema rejects an absolute probe file path", () => {
  expect(
    ProbeEntrySchema.safeParse({ name: "p", file: "probes/p.ts" }).success,
    "a valid relative probe file was rejected",
  )
  expect(
    !ProbeEntrySchema.safeParse({ name: "p", file: "/etc/passwd" }).success,
    "an absolute (POSIX) probe file was accepted",
  )
  expect(
    !ProbeEntrySchema.safeParse({ name: "p", file: "C:\\evil.ts" }).success,
    "a drive-letter probe file was accepted",
  )
})
await check("core: SentinelEntry / PackFileDigest / source-type sub-shapes hold", () => {
  expect(
    SentinelEntrySchema.safeParse({ id: "anomalous-tool-sequence" }).success,
    "valid sentinel id rejected",
  )
  expect(
    !SentinelEntrySchema.safeParse({ id: "Not Kebab" }).success,
    "non-kebab sentinel id accepted",
  )
  expect(
    PackFileDigestSchema.safeParse({ path: "probes/x.ts", sha256: "0".repeat(64) }).success,
    "valid file digest rejected",
  )
  expect(
    !PackFileDigestSchema.safeParse({ path: "probes/x.ts", sha256: "nothex" }).success,
    "a non-sha256 file digest was accepted",
  )
  expect(
    PackContentDigestSchema.safeParse(validManifest.content_digest).success,
    "valid content digest rejected",
  )
  for (const t of ["local", "npm", "git"] as const) {
    const source: ProbePackSourceType = t
    expect(ProbePackSourceTypeSchema.safeParse(source).success, `valid source_type '${t}' rejected`)
  }
  expect(!ProbePackSourceTypeSchema.safeParse("ftp").success, "an unknown source_type was accepted")
  expect(PROBE_PACK_SPEC_VERSION === "1", "PROBE_PACK_SPEC_VERSION drifted")
  expect(
    PROBE_PACK_MANIFEST_FILENAME === "lodestar.probe-pack.json",
    "PROBE_PACK_MANIFEST_FILENAME drifted",
  )
})

// ── @qmilab/lodestar-core: the immutable PackSourceRef ─────────────────────
await check("core: PackSourceRef pins immutability — npm exact version + git full SHA", () => {
  const npm = NpmPackSourceSchema.safeParse({
    type: "npm",
    package: "@scope/example-pack",
    version: "1.0.0",
    integrity: "sha512-AAAA",
  })
  expect(npm.success, `valid npm source rejected: ${JSON.stringify(npm.error?.issues)}`)
  // a range / dist-tag is not an immutable artifact — rejected
  expect(
    !NpmPackSourceSchema.safeParse({
      type: "npm",
      package: "example-pack",
      version: "^1.0.0",
      integrity: "sha512-AAAA",
    }).success,
    "an npm version range was accepted (not immutable)",
  )
  expect(
    !NpmPackSourceSchema.safeParse({
      type: "npm",
      package: "example-pack",
      version: "latest",
      integrity: "sha512-AAAA",
    }).success,
    "an npm dist-tag 'latest' was accepted (not immutable)",
  )
  const git = GitPackSourceSchema.safeParse({
    type: "git",
    url: "https://example.test/pack.git",
    commit: "a".repeat(40),
  })
  expect(git.success, `valid git source rejected: ${JSON.stringify(git.error?.issues)}`)
  // a mutable ref (branch / short SHA) is rejected
  expect(
    !GitPackSourceSchema.safeParse({
      type: "git",
      url: "https://example.test/pack.git",
      commit: "main",
    }).success,
    "a git branch ref was accepted (not immutable)",
  )
  expect(
    !GitPackSourceSchema.safeParse({
      type: "git",
      url: "https://example.test/pack.git",
      commit: "a".repeat(7),
    }).success,
    "a short git SHA was accepted (not immutable)",
  )
  // the discriminated union routes by `type`; local is the no-fetch case
  expect(
    LocalPackSourceSchema.safeParse({ type: "local", path: "./pack" }).success,
    "valid local source rejected",
  )
  const ref: PackSourceRef = PackSourceRefSchema.parse({ type: "local", path: "./pack" })
  expect(ref.type === "local", "PackSourceRef did not discriminate by type")
})

// ── @qmilab/lodestar-core: the lodestar.pack-index.json discovery index ────
const validIndex = {
  index_version: "1",
  description: "example discovery index",
  packs: [
    {
      name: "example-pack",
      version: "1.0.0",
      source: {
        type: "npm",
        package: "@scope/example-pack",
        version: "1.0.0",
        integrity: "sha512-AAAA",
      },
      author_id: "pack-author",
      description: "an example pack",
      coverage_areas: ["prompt-injection"],
      invariants: ["no-self-promote"],
      badges: [{ kind: "probe_results", attester_id: "scanner-co" }],
    },
  ],
  publisher_id: "index-publisher",
  generated_at: "2026-01-01T00:00:00.000Z",
  signature: {
    signer_id: "index-publisher",
    payload_hash: "c".repeat(64),
    algorithm: "ed25519",
    signature: "ZmFrZQ==",
    at: "2026-01-01T00:00:00.000Z",
  },
}
await check(
  "core: PackIndexSchema round-trips a signed index + the entry resolves a PackSourceRef",
  () => {
    const parsed = PackIndexSchema.safeParse(validIndex)
    expect(parsed.success, `valid index rejected: ${JSON.stringify(parsed.error?.issues)}`)
    const index: PackIndex = parsed.data
    const entry = index.packs[0]
    expect(entry !== undefined, "index dropped its entry")
    const listing: PackIndexEntry = entry
    expect(listing.name === "example-pack", "index entry name drifted")
    // the entry's source is the same immutable PackSourceRef `pack add` consumes
    const source: PackSourceRef = listing.source
    expect(source.type === "npm", "index entry source is not a PackSourceRef")
    const badge = listing.badges?.[0]
    expect(badge !== undefined, "index dropped its advisory badge summary")
    const summary: PackIndexBadgeSummary = badge
    expect(summary.kind === "probe_results", "advisory badge summary drifted")
  },
)
await check("core: PackIndexSchema pins index_version + its sub-shapes", () => {
  expect(
    !PackIndexSchema.safeParse({ ...validIndex, index_version: "2" }).success,
    "an unknown index_version was accepted",
  )
  // the entry's free-form taxonomy defaults to [] (searchable, additive)
  const entry = PackIndexEntrySchema.parse({
    name: "p",
    version: "1.0.0",
    source: { type: "local", path: "./p" },
  })
  expect(
    Array.isArray(entry.coverage_areas) && entry.coverage_areas.length === 0,
    "entry taxonomy default drifted",
  )
  expect(
    PackIndexBadgeSummarySchema.safeParse({ kind: "security_scan", attester_id: "x" }).success,
    "valid badge summary rejected",
  )
  // the index-publisher key is the third trust root the consumer pins
  const key: PackIndexPublisherKey = PackIndexPublisherKeySchema.parse({
    publisher_id: "index-publisher",
    public_key: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
  })
  expect(key.publisher_id === "index-publisher", "index publisher key drifted")
  expect(PACK_INDEX_SPEC_VERSION === "1", "PACK_INDEX_SPEC_VERSION drifted")
  expect(PACK_INDEX_FILENAME === "lodestar.pack-index.json", "PACK_INDEX_FILENAME drifted")
})

// ── @qmilab/lodestar-core: verification badges (badges/*.badge.json) ───────
const validProbeResultsBadge = {
  badge_version: "1",
  kind: "probe_results",
  subject: { pack: "example-pack", version: "1.0.0", manifest_hash: "d".repeat(64) },
  attester_id: "scanner-co",
  issued_at: "2026-01-01T00:00:00.000Z",
  result: { ok: true, total: 10, passed: 10, failed: 0, harness_version: "0.4.0" },
  signature: {
    signer_id: "scanner-co",
    payload_hash: "e".repeat(64),
    algorithm: "ed25519",
    signature: "ZmFrZQ==",
    at: "2026-01-01T00:00:00.000Z",
  },
}
const validSecurityScanBadge = {
  badge_version: "1",
  kind: "security_scan",
  subject: { pack: "example-pack", version: "1.0.0", manifest_hash: "d".repeat(64) },
  attester_id: "scanner-co",
  issued_at: "2026-01-01T00:00:00.000Z",
  result: { status: "clean", findings_count: 0 },
  signature: {
    signer_id: "scanner-co",
    payload_hash: "f".repeat(64),
    algorithm: "ed25519",
    signature: "ZmFrZQ==",
    at: "2026-01-01T00:00:00.000Z",
  },
}
await check("core: PackBadgeSchema round-trips both kinds, discriminated by kind", () => {
  const pr = ProbeResultsBadgeSchema.safeParse(validProbeResultsBadge)
  expect(pr.success, `probe_results badge rejected: ${JSON.stringify(pr.error?.issues)}`)
  const prBadge: ProbeResultsBadge = pr.data
  expect(prBadge.result.ok === true && prBadge.result.total === 10, "probe_results body drifted")

  const sc = SecurityScanBadgeSchema.safeParse(validSecurityScanBadge)
  expect(sc.success, `security_scan badge rejected: ${JSON.stringify(sc.error?.issues)}`)
  const scBadge: SecurityScanBadge = sc.data
  expect(scBadge.result.status === "clean", "security_scan body drifted")

  // the union discriminates by `kind`; the subject binds the badge to exact bytes
  const badge: PackBadge = PackBadgeSchema.parse(validProbeResultsBadge)
  const kind: PackBadgeKind = badge.kind
  expect(kind === "probe_results", "PackBadge did not discriminate by kind")
  const subject: PackBadgeSubject = badge.subject
  expect(subject.manifest_hash.length === 64, "badge subject manifest_hash not round-tripped")
})
await check(
  "core: a badge is REQUIRED-signed; unsigned/bad subject/bad version is rejected",
  () => {
    // a badge is by definition signed — an unsigned file is malformed, not a loose badge
    const { signature: _sig, ...unsigned } = validProbeResultsBadge
    expect(!PackBadgeSchema.safeParse(unsigned).success, "an unsigned badge was accepted")
    // `UnsignedPackBadge` is the pre-signing view (the canonical-hash input) — derived
    // from a parsed badge so its discriminant `kind` is the literal the union needs.
    const { signature: _omit, ...preSign } = ProbeResultsBadgeSchema.parse(validProbeResultsBadge)
    const unsignedView: UnsignedPackBadge = preSign
    void unsignedView
    // a non-hex subject manifest_hash is rejected (the mis-attach binding is 64-hex)
    expect(
      !PackBadgeSubjectSchema.safeParse({ pack: "p", version: "1.0.0", manifest_hash: "short" })
        .success,
      "a non-hex manifest_hash was accepted",
    )
    expect(
      !PackBadgeSchema.safeParse({ ...validProbeResultsBadge, badge_version: "2" }).success,
      "an unknown badge_version was accepted",
    )
    expect(PackBadgeKindSchema.safeParse("probe_results").success, "valid badge kind rejected")
    expect(!PackBadgeKindSchema.safeParse("trust_me").success, "an unknown badge kind was accepted")
    expect(PACK_BADGE_SPEC_VERSION === "1", "PACK_BADGE_SPEC_VERSION drifted")
    expect(PACK_BADGES_DIRNAME === "badges", "PACK_BADGES_DIRNAME drifted")
    expect(PACK_BADGE_FILE_SUFFIX === ".badge.json", "PACK_BADGE_FILE_SUFFIX drifted")
  },
)

// ── @qmilab/lodestar-event-log: canonicalHash + EventLogReader layout ─────
await check("event-log: canonicalHash is key-order-independent and 64 hex chars", () => {
  const a = canonicalHash({ a: 1, b: 2 })
  const b = canonicalHash({ b: 2, a: 1 })
  expect(a === b, "canonicalHash depends on key insertion order")
  expect(a.length === 64 && HEX.test(a), `not a sha-256 hex digest: ${a}`)
  expect(canonicalHash({ a: 1 }) !== a, "distinct payloads collided")
})
await check(
  "event-log: EventLogReader reads the documented <root>/<project>/YYYY-MM-DD.ndjson layout",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lodestar-api-surface-"))
    try {
      const projectDir = join(root, validEnvelope.project_id)
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, "2026-01-01.ndjson"),
        `${JSON.stringify(validEnvelope)}\n`,
        "utf8",
      )

      const reader = new EventLogReader(root)
      const all = await reader.readAll(validEnvelope.project_id)
      expect(all.length === 1, `expected 1 envelope from readAll, got ${all.length}`)
      expect(all[0]?.seq === 0, "readAll did not round-trip the envelope")
      expect(
        all[0]?.payload_hash === canonicalHash(all[0]?.payload),
        "round-tripped payload_hash !== canonicalHash(payload)",
      )
      const session = await reader.readSession(validEnvelope.project_id, validEnvelope.session_id)
      expect(session.length === 1, `expected 1 envelope from readSession, got ${session.length}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

// ── @qmilab/lodestar-trace: projectChain / renderReport / pendingApprovals ─
await check("trace: projectChain is a tolerant pure projection (unknown types retained)", () => {
  const unknownEvent = EventEnvelopeSchema.parse({ ...validEnvelope, type: "some.unknown.type@9" })
  const projection = projectChain([unknownEvent], {
    session_id: validEnvelope.session_id,
    project_id: validEnvelope.project_id,
  })
  expect(projection.session_id === validEnvelope.session_id, "session_id not projected")
  expect(projection.actor_ids instanceof Set, "actor_ids is not a Set (documented sharp edge)")
  expect(projection.raw_events.length === 1, "unknown event type was not retained in raw_events")
  expect(Array.isArray(projection.beliefs), "ChainProjection.beliefs missing")
})
await check("trace: renderReport returns a string for a projection", () => {
  const projection = projectChain([], { session_id: "s", project_id: "p" })
  const report: string = renderReport(projection, { title: "surface probe" })
  expect(
    typeof report === "string" && report.includes("surface probe"),
    "report did not honor title",
  )
})
await check("trace: pendingApprovals derives the open-hold queue, read-only", () => {
  const requestPayload = {
    request_id: "r1",
    action_id: "a1",
    reason: "needs sign-off",
    required_authority: { min_trust_baseline: 0.9 },
    requested_at: "2026-01-01T00:00:00.000Z",
  }
  const requested = EventEnvelopeSchema.parse({
    ...validEnvelope,
    id: "req-1",
    type: "approval.requested",
    payload_hash: canonicalHash(requestPayload),
    payload: requestPayload,
  })
  const queue: PendingApproval[] = pendingApprovals([requested])
  expect(queue.length === 1, `expected 1 pending approval, got ${queue.length}`)
  const p = queue[0]
  expect(p?.status === "pending", "pending approval status is not 'pending'")
  expect(p?.request_id === "r1" && p?.action_id === "a1", "pending approval did not carry ids")
})
await check(
  "trace: toWireProjection makes a ChainProjection JSON-safe (Set→array, raw_events dropped), purely",
  () => {
    const event = EventEnvelopeSchema.parse({ ...validEnvelope, type: "some.unknown.type@9" })
    const projection = projectChain([event], {
      session_id: validEnvelope.session_id,
      project_id: validEnvelope.project_id,
    })
    // preconditions: the two fields the serializer exists to fix are present
    expect(projection.actor_ids instanceof Set, "precondition: projectChain actor_ids is not a Set")
    expect(projection.raw_events.length === 1, "precondition: raw_events not populated")

    const wire: WireProjection = toWireProjection(projection)
    expect(Array.isArray(wire.actor_ids), "wire actor_ids is not an array")
    expect(
      wire.actor_ids.includes(validEnvelope.actor_id),
      "wire actor_ids dropped the projected actor",
    )
    expect(!("raw_events" in wire), "wire projection retained the heavy raw_events")

    // pure: the source projection is not mutated
    expect(projection.actor_ids instanceof Set, "toWireProjection mutated its input's actor_ids")
    expect(projection.raw_events.length === 1, "toWireProjection mutated its input's raw_events")

    // JSON-safe: actor_ids round-trips as a populated array, not the `{}` a Set yields
    const roundTripped = JSON.parse(JSON.stringify(wire)) as { actor_ids: unknown }
    expect(
      Array.isArray(roundTripped.actor_ids) &&
        roundTripped.actor_ids.length === wire.actor_ids.length,
      "actor_ids did not survive JSON round-trip as an array",
    )
  },
)

// ── @qmilab/lodestar-otel-exporter: deterministic ids + the OTLP IR ───────
await check("otel: traceIdFor is deterministic and 32 hex chars", () => {
  const a = traceIdFor("proj", "sess")
  expect(a === traceIdFor("proj", "sess"), "traceIdFor is not deterministic")
  expect(a.length === 32 && HEX.test(a), `not a 16-byte trace id: ${a}`)
  expect(traceIdFor("proj", "other") !== a, "distinct sessions collided on trace id")
})
await check("otel: spanIdFor is deterministic, 16 hex chars, kind-namespaced", () => {
  const a = spanIdFor("proj", "sess", "action", "x")
  expect(a === spanIdFor("proj", "sess", "action", "x"), "spanIdFor is not deterministic")
  expect(a.length === 16 && HEX.test(a), `not an 8-byte span id: ${a}`)
  expect(spanIdFor("proj", "sess", "session", "x") !== a, "distinct kinds collided on span id")
})
await check("otel: isoToUnixNano converts deterministically and fails closed to '0'", () => {
  expect(isoToUnixNano("1970-01-01T00:00:00.000Z") === "0", "epoch did not map to 0")
  expect(isoToUnixNano("1970-01-01T00:00:01.000Z") === "1000000000", "1s did not map to 1e9 ns")
  expect(isoToUnixNano(undefined) === "0", "undefined did not fail closed to 0")
  expect(isoToUnixNano("not-a-date") === "0", "unparseable timestamp did not fail closed to 0")
})
await check("otel: buildTrace → toOtlpTraceJson produces the OTLP resourceSpans IR", () => {
  const projection = projectChain([], { session_id: "sess", project_id: "proj" })
  const trace = buildTrace(projection)
  expect(trace.trace_id === traceIdFor("proj", "sess"), "buildTrace trace_id not derived from ids")
  expect(Array.isArray(trace.spans), "LodestarTrace.spans is not an array")
  const otlp = toOtlpTraceJson([trace])
  expect(Array.isArray(otlp.resourceSpans), "OTLP payload has no resourceSpans array")
  expect(otlp.resourceSpans.length === 1, "one trace did not map to one resourceSpans entry")
})

// ── @qmilab/lodestar-policy-kernel + guard-mcp: signed-approval surface ───
const validResolution = {
  request_id: "r1",
  action_id: "a1",
  kind: "granted" as const,
  approver_id: "operator",
  at: "2026-01-01T00:00:00.000Z",
}
await check("guard-mcp: ApprovalResolutionSchema round-trips the documented wire shape", () => {
  const parsed = ApprovalResolutionSchema.safeParse(validResolution)
  expect(parsed.success, `valid resolution rejected: ${JSON.stringify(parsed.error?.issues)}`)
  expect(parsed.data.kind === "granted", "resolution kind not round-tripped")
  // `expired` is never written to the side-channel — the schema must reject it.
  expect(
    !ApprovalResolutionSchema.safeParse({ ...validResolution, kind: "expired" }).success,
    "side-channel resolution accepted kind 'expired'",
  )
})
await check(
  "guard-mcp: side-channel layout is <log_root>/.approvals/<project_id>/<request_id>.json",
  () => {
    const dir = approvalsChannelDir("/log", "proj")
    expect(dir === join("/log", ".approvals", "proj"), `channel dir layout drifted: ${dir}`)
    const path = approvalResolutionPath("/log", "proj", "r1")
    expect(
      path === join("/log", ".approvals", "proj", "r1.json"),
      `resolution path layout drifted: ${path}`,
    )
  },
)

// ── @qmilab/lodestar-guard: the ApprovalChannel transport seam (ADR-0015) ──
await check(
  "guard: ApprovalChannelConfigSchema round-trips file + http, rejects the invalid",
  () => {
    const file = ApprovalChannelConfigSchema.safeParse({ kind: "file" })
    expect(file.success && file.data.kind === "file", "file channel config rejected")
    const http = ApprovalChannelConfigSchema.safeParse({
      kind: "http",
      endpoint: "https://approvals.example/",
    })
    expect(
      http.success,
      `valid http channel config rejected: ${JSON.stringify(http.error?.issues)}`,
    )
    if (http.success && http.data.kind === "http") {
      // The documented defaults are applied (egress ceiling, timeout, body cap).
      expect(
        http.data.announce_sensitivity_ceiling === "internal",
        "announce ceiling default drifted",
      )
      expect(typeof http.data.timeout_ms === "number", "http timeout default missing")
      expect(typeof http.data.max_body_bytes === "number", "http body-cap default missing")
    }
    // The discriminated union is closed, and an http endpoint must be a valid URL.
    expect(
      !ApprovalChannelConfigSchema.safeParse({ kind: "smtp", endpoint: "x" }).success,
      "an unknown channel kind was accepted",
    )
    expect(
      !ApprovalChannelConfigSchema.safeParse({ kind: "http", endpoint: "not a url" }).success,
      "an http channel accepted a non-URL endpoint",
    )
  },
)
await check("guard: httpChannelForbidsUnsigned closes the unsigned-remote hole", () => {
  // The file channel is always allowed (its unsigned local mode is the documented escape).
  expect(httpChannelForbidsUnsigned({ channel: { kind: "file" } }).ok, "file channel flagged")
  // An http channel with no pinned key, or with allow_unsigned, is unrepresentable.
  expect(
    !httpChannelForbidsUnsigned({ channel: { kind: "http" }, authorized_keys: [] }).ok,
    "http channel with no pinned key accepted",
  )
  expect(
    !httpChannelForbidsUnsigned({
      channel: { kind: "http" },
      authorized_keys: [{}],
      allow_unsigned: true,
    }).ok,
    "http channel with allow_unsigned accepted",
  )
  // An http channel with a pinned key and no allow_unsigned is allowed.
  expect(
    httpChannelForbidsUnsigned({ channel: { kind: "http" }, authorized_keys: [{}] }).ok,
    "http channel with a pinned key rejected",
  )
})
await check("guard: createApprovalChannel builds the file channel as an ApprovalChannel", () => {
  const channel: ApprovalChannel = createApprovalChannel({ kind: "file" }, { logRoot: "/tmp/x" })
  expect(typeof channel.fetch === "function", "file channel exposes no fetch()")
  // `consume` is optional on the interface but present on the file channel; `announce`
  // is absent (the file channel has no notify surface) — both documented.
  expect(typeof channel.consume === "function", "file channel exposes no consume()")
  expect(channel.announce === undefined, "file channel unexpectedly grew an announce()")
})

await check("policy-kernel: assertValidApproverKeys validates pinned SPKI keys", () => {
  const { publicKeyPem } = generateApproverKeyPair()
  assertValidApproverKeys([{ actor_id: "operator", public_key: publicKeyPem }])
  let threw = false
  try {
    assertValidApproverKeys([{ actor_id: "operator", public_key: "not-a-pem" }])
  } catch (err) {
    threw = err instanceof ApprovalSignatureError
  }
  expect(threw, "a corrupt pinned key did not raise ApprovalSignatureError")
})
await check("policy-kernel: sign → verify round-trip + the contractual reject set", () => {
  const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
  const authorizedKeys = [{ actor_id: "operator", public_key: publicKeyPem }]
  const signature = signApprovalResolution(validResolution, privateKeyPem)
  expect(
    signature.payload_hash === canonicalApprovalResolutionHash(validResolution),
    "signature does not bind the canonical resolution hash",
  )

  // authentic → returns normally
  verifyApprovalSignature(validResolution, signature, { authorizedKeys })

  const rejects = (label: string, fn: () => void) => {
    let threw = false
    try {
      fn()
    } catch (err) {
      threw = err instanceof ApprovalSignatureError
    }
    expect(threw, `${label} was not rejected with ApprovalSignatureError`)
  }
  // unsigned without the explicit opt-out
  rejects("unsigned resolution", () =>
    verifyApprovalSignature(validResolution, undefined, { authorizedKeys }),
  )
  // tampered: a different document under the same signature → hash mismatch
  rejects("tampered resolution", () =>
    verifyApprovalSignature({ ...validResolution, action_id: "a2" }, signature, { authorizedKeys }),
  )
  // unpinned signer: the trust root is empty
  rejects("unpinned signer", () =>
    verifyApprovalSignature(validResolution, signature, { authorizedKeys: [] }),
  )
  // the explicit allow_unsigned opt-out lets an unsigned resolution through
  verifyApprovalSignature(validResolution, undefined, { authorizedKeys, allowUnsigned: true })
})

// ── @qmilab/lodestar-ship: lodestar.session_ship@1 wire format ────────────
await check("ship: ShipManifestSchema pins the session_ship@1 manifest record", () => {
  const manifest = {
    kind: "lodestar.session_ship",
    version: 1,
    project_id: "proj",
    session_id: "sess",
    event_count: 1,
    ceiling: "internal",
    redacted_count: 0,
  }
  const parsed = ShipManifestSchema.safeParse(manifest)
  expect(parsed.success, `valid manifest rejected: ${JSON.stringify(parsed.error?.issues)}`)
  expect(parsed.data.kind === "lodestar.session_ship", "manifest kind drifted")
  expect(
    !ShipManifestSchema.safeParse({ ...manifest, kind: "other" }).success,
    "manifest accepted a foreign wire kind",
  )
})
await check("ship: ShipRecordSchema discriminates redacted vs unredacted wrapper records", () => {
  const unredacted = { v: 1, redacted: false, envelope: validEnvelope }
  const redacted = {
    v: 1,
    redacted: true,
    payload_sensitivity: "secret",
    envelope: { ...validEnvelope, payload: { "lodestar.redacted": true } },
  }
  const u = ShipRecordSchema.safeParse(unredacted)
  const r = ShipRecordSchema.safeParse(redacted)
  expect(u.success, `unredacted record rejected: ${JSON.stringify(u.error?.issues)}`)
  expect(r.success, `redacted record rejected: ${JSON.stringify(r.error?.issues)}`)
  // a redacted record MUST carry payload_sensitivity (the discriminated-union shape)
  expect(
    !ShipRecordSchema.safeParse({ v: 1, redacted: true, envelope: validEnvelope }).success,
    "redacted record accepted without payload_sensitivity",
  )
})

// ─── report ───────────────────────────────────────────────────────────────
console.log("─".repeat(72))
console.log("probe: public_api_surface")
console.log("─".repeat(72))
const passed = failures.length === 0
console.log(`status: ${passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(`  pinned ${notes.length} stable surface(s); ${failures.length} drift(s)`)
for (const line of notes) console.log(`  ${line}`)
for (const line of failures) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!passed) process.exit(1)
