import { z } from "zod"
import { SignatureSchema } from "./actor.js"

/**
 * Verification badges (ADR-0020, #89) — the registry's second trust axis.
 *
 * A signed manifest (ADR-0017) proves *authorship*: who produced these exact bytes.
 * A **badge** is the orthogonal axis — an attestation *about* a pack, issued by an
 * attesting authority and verified locally against a **separate** pinned trust root
 * (the operator's pinned *attester* keys, distinct from author keys; see
 * `PackAttesterKeySchema` in `./pack-registry.ts`). Two kinds in v1.5:
 *
 *  - `probe_results` — "pack P at this exact version passed (or failed) a probe
 *    run", the natural signed summary of a `lodestar harness run`.
 *  - `security_scan` — "pack P was scanned, status clean / findings". The *format*
 *    and *local verification* are open; the scanner that actually runs the scan and
 *    the authority that issues trusted badges at scale are the commercial surface
 *    (ADR-0016 §4).
 *
 * A badge is **attached to — not baked into** — the manifest: it lives in a
 * `badges/` directory at the pack root, one `*.badge.json` file per attestation,
 * outside the manifest's `content_digest`. So badges accrue without re-signing the
 * manifest and without disturbing the author signature, and a `probe_results` badge
 * (which can only exist *after* the pack is signed) has somewhere to live.
 *
 * Two properties make a badge trustworthy without trusting any index or registry:
 *  - **Subject binding** (`subject.manifest_hash`) defeats *mis-attach* — a badge
 *    legitimately signed over pack A, moved onto pack B by a hostile index, fails
 *    because B's recomputed manifest hash ≠ the badge's subject hash.
 *  - **The signature** defeats *forgery* — an attacker can copy a public subject but
 *    cannot sign against a pinned attester key whose private half they do not hold.
 *
 * Badges are **advisory trust signal, not a runtime gate** (ADR-0016 §3): the
 * consumer surfaces verified-vs-unverified and never *blocks* on them.
 */

/**
 * The badge-format spec version (the schema's own version, not a pack's). Bumped
 * only when the badge shape changes in a way an older verifier cannot read — the
 * same discipline as {@link PROBE_PACK_SPEC_VERSION}. Adding an optional field is
 * not a bump; adding a new `kind` or re-typing a field is.
 */
export const PACK_BADGE_SPEC_VERSION = "1" as const

/** What a badge attests. `probe_results` summarises a harness run; `security_scan` a scan. */
export const PackBadgeKindSchema = z.enum(["probe_results", "security_scan"])
export type PackBadgeKind = z.infer<typeof PackBadgeKindSchema>

/**
 * What a badge is *about*: the pack identity plus the canonical manifest hash that
 * binds it to the exact signed bytes. `manifest_hash` is the load-bearing field —
 * it is `canonicalProbePackManifestHash(manifest)`, which transitively binds the
 * `content_digest` and thus the probe bytes. A verifier recomputes it over the pack
 * it is actually looking at and rejects a badge whose subject hash differs (the
 * mis-attach defence). `pack` / `version` are the human-readable identity and are
 * cross-checked for consistency.
 */
export const PackBadgeSubjectSchema = z
  .object({
    pack: z.string().min(1).describe("The pack's manifest name the badge attests over."),
    version: z.string().min(1).describe("The pack's manifest version the badge attests over."),
    manifest_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "manifest_hash must be 64 lowercase hex characters")
      .describe(
        "Canonical manifest hash (sha-256 hex) binding the badge to the exact signed pack bytes. Recomputed and compared by the verifier — a mismatch means the badge was mis-attached.",
      ),
  })
  .describe("The pack a badge attests over, bound to the exact bytes by manifest_hash.")
export type PackBadgeSubject = z.infer<typeof PackBadgeSubjectSchema>

/**
 * The result a `probe_results` badge carries: the signed summary of a harness run
 * over the pack. Counts plus the harness version that ran them; `probes` is the
 * optional list of probe names so a consumer can see *what* was exercised.
 */
export const ProbeResultsBadgeResultSchema = z
  .object({
    ok: z.boolean().describe("True when every probe in the run passed."),
    total: z.number().int().nonnegative().describe("Total probes run."),
    passed: z.number().int().nonnegative().describe("Probes that passed."),
    failed: z.number().int().nonnegative().describe("Probes that failed."),
    harness_version: z
      .string()
      .min(1)
      .describe("Version of the harness that produced the run (provenance for the result)."),
    probes: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional list of the probe names run, so a consumer sees what was exercised."),
  })
  .describe("The signed summary of a probe run — the body of a probe_results badge.")
export type ProbeResultsBadgeResult = z.infer<typeof ProbeResultsBadgeResultSchema>

/** A security scan's verdict: clean, or findings present. */
export const SecurityScanStatusSchema = z.enum(["clean", "findings"])
export type SecurityScanStatus = z.infer<typeof SecurityScanStatusSchema>

/**
 * The result a `security_scan` badge carries: scan status over the pack. The
 * *format* is open; the scanner that produces this is out of scope for the open
 * repo (ADR-0016 §4), so this signs a *provided* result rather than running a scan.
 */
export const SecurityScanBadgeResultSchema = z
  .object({
    status: SecurityScanStatusSchema.describe("clean — no findings; findings — at least one."),
    findings_count: z.number().int().nonnegative().describe("Number of findings (0 when clean)."),
    scanner: z
      .string()
      .min(1)
      .optional()
      .describe("Free-form scanner identifier/label that produced the result."),
    summary: z.string().optional().describe("Optional human-readable one-line summary."),
  })
  .describe("A scan verdict — the body of a security_scan badge.")
export type SecurityScanBadgeResult = z.infer<typeof SecurityScanBadgeResultSchema>

// The shared, kind-independent badge fields. Each kind specialises `kind` + `result`.
const badgeBase = {
  badge_version: z
    .literal(PACK_BADGE_SPEC_VERSION)
    .describe("Badge-format spec version. A verifier rejects a version it does not understand."),
  subject: PackBadgeSubjectSchema,
  attester_id: z
    .string()
    .min(1)
    .describe(
      "The attesting authority's signer id. Must equal signature.signer_id and be in the operator-pinned attester-key set for the badge to be trusted.",
    ),
  issued_at: z.string().datetime().describe("When the attestation was issued (ISO 8601)."),
  // A badge is by definition signed — `signature` is REQUIRED (unlike a manifest,
  // which has an allow_unsigned path). An on-disk file with no signature is not a
  // badge; the verifier surfaces it as malformed rather than parsing it loosely.
  signature: SignatureSchema.describe(
    "Ed25519 signature over the canonical badge (every field except this one). Verified against operator-pinned attester keys; required.",
  ),
}

export const ProbeResultsBadgeSchema = z
  .object({
    ...badgeBase,
    kind: z.literal("probe_results"),
    result: ProbeResultsBadgeResultSchema,
  })
  .describe("A signed attestation that a pack passed (or failed) a probe run.")
export type ProbeResultsBadge = z.infer<typeof ProbeResultsBadgeSchema>

export const SecurityScanBadgeSchema = z
  .object({
    ...badgeBase,
    kind: z.literal("security_scan"),
    result: SecurityScanBadgeResultSchema,
  })
  .describe("A signed attestation of a pack's security-scan status.")
export type SecurityScanBadge = z.infer<typeof SecurityScanBadgeSchema>

/**
 * A verification badge — a small signed attestation over a pack, discriminated by
 * `kind`. Lives as a `badges/<name>.badge.json` file at the pack root (the harness
 * loader reads + verifies these; the schema does no I/O).
 */
export const PackBadgeSchema = z.discriminatedUnion("kind", [
  ProbeResultsBadgeSchema,
  SecurityScanBadgeSchema,
])
export type PackBadge = z.infer<typeof PackBadgeSchema>

// Distributive Omit so the unsigned view keeps each kind's `result` typing intact
// (a plain `Omit<PackBadge, …>` over a union collapses to the common fields).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * A badge without its detached `signature`: what the canonical hash is computed
 * over, and what a producer assembles *before* signing. The signature cannot cover
 * itself, so signing strips this field, hashes, signs, and re-attaches.
 */
export type UnsignedPackBadge = DistributiveOmit<PackBadge, "signature">

/**
 * The directory at a pack root that holds its badges, and the suffix each badge
 * file carries. Defined as constants so the producer (writer) and the consumer
 * (loader) agree. Badges live here — outside the manifest and its `content_digest`
 * — so they accrue independently of the author signature.
 */
export const PACK_BADGES_DIRNAME = "badges" as const
export const PACK_BADGE_FILE_SUFFIX = ".badge.json" as const
