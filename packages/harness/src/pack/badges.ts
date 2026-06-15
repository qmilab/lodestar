import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  PACK_BADGES_DIRNAME,
  PACK_BADGE_FILE_SUFFIX,
  PACK_BADGE_SPEC_VERSION,
  type PackBadge,
  PackBadgeSchema,
  type PackBadgeSubject,
  type PinnedPublicKeys,
  type ProbeResultsBadge,
  type SecurityScanBadge,
  type SecurityScanBadgeResult,
  assertBadgeAppliesTo,
  canonicalProbePackManifestHash,
  signPackBadge,
  verifyPackBadgeSignature,
} from "@qmilab/lodestar-core"
import type { ProbePackManifest } from "@qmilab/lodestar-core"
import type { PackRunResult } from "../runner.js"
import { ProbePackError } from "./errors.js"
import type { LoadedProbePack } from "./loader.js"

/**
 * Verification badges — the harness's I/O side (ADR-0020, #89).
 *
 * Core owns the badge wire format and the pure sign/verify/applicability checks;
 * this is the filesystem half: discovering `badges/*.badge.json` at a pack root,
 * classifying each into the advisory verified/unverified/not-applicable/malformed
 * surface, building the two badge kinds, and writing one in place. Same
 * core-owns-format / harness-owns-resolution split the loader follows.
 *
 * The verification surface is **advisory** (ADR-0016 §3): {@link verifyPackBadges}
 * returns a classification per badge and never throws on a *badge* failure — only a
 * trusted badge (`status: "verified"`) counts, and everything else is surfaced as
 * exactly what it is. `addProbePack` consumes this and never gates on it.
 */

/** How a badge fared against the pack and the pinned attester keys. */
export type BadgeVerificationStatus = "verified" | "unverified" | "not_applicable" | "malformed"

/**
 * The result of classifying one badge file. Only `status: "verified"` is trusted;
 * `not_applicable` is a mis-attached badge (subject does not match this pack),
 * `unverified` is a forged / un-pinned-attester / tampered badge, and `malformed`
 * is a file that did not parse as a badge at all.
 */
export interface BadgeVerification {
  /** Badge file path relative to the pack root, e.g. `badges/acme.probe_results.badge.json`. */
  file: string
  status: BadgeVerificationStatus
  /** The parsed badge — present unless the file was malformed. */
  badge?: PackBadge
  /** Why a non-`verified` badge is not trusted (for display); absent when verified. */
  reason?: string
}

export interface VerifyPackBadgesOptions {
  /**
   * Operator-pinned **attester** public keys (`attester_id → SPKI PEM`) — the badge
   * trust root, distinct from author keys. Absent / empty means no badge can be
   * trusted (every signed badge surfaces as `unverified`), which is the secure
   * default: a badge is only signal if its attester is one the operator pinned.
   */
  authorizedAttesterKeys?: PinnedPublicKeys
}

interface RawBadge {
  file: string
  badge?: PackBadge
  parseError?: string
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Read every `badges/*.badge.json` at a pack root, parsing each against the badge
 * schema. A missing `badges/` directory is normal and yields `[]`. A file that does
 * not parse (unreadable, bad JSON, schema failure) is returned with a `parseError`
 * rather than thrown — it surfaces downstream as a `malformed` badge. A non-ENOENT
 * failure to read the directory itself is exceptional and does throw (a genuine
 * filesystem fault is not a badge-trust outcome).
 */
export async function readPackBadges(packRoot: string): Promise<RawBadge[]> {
  const dir = join(packRoot, PACK_BADGES_DIRNAME)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new ProbePackError(`Could not read pack badges directory: ${dir}`, { cause: err })
  }

  const raw: RawBadge[] = []
  for (const name of names.filter((n) => n.endsWith(PACK_BADGE_FILE_SUFFIX)).sort()) {
    const rel = `${PACK_BADGES_DIRNAME}/${name}`
    let text: string
    try {
      text = await readFile(join(dir, name), "utf8")
    } catch (err) {
      raw.push({ file: rel, parseError: `unreadable badge file: ${errMessage(err)}` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      raw.push({ file: rel, parseError: "not valid JSON" })
      continue
    }
    const parsed = PackBadgeSchema.safeParse(json)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      raw.push({ file: rel, parseError: `not a valid badge: ${issues}` })
      continue
    }
    raw.push({ file: rel, badge: parsed.data })
  }
  return raw
}

/**
 * Read and classify every badge at a pack root against the operator-pinned attester
 * keys. For each badge two independent checks run — applicability (the
 * `subject.manifest_hash` matches *this* pack, defeating mis-attach) then signature
 * (verifies against a pinned attester, defeating forgery) — and the badge lands in
 * the first failing bucket. Advisory: a badge failure is a classification, never an
 * exception.
 */
export async function verifyPackBadges(
  pack: Pick<LoadedProbePack, "manifest" | "root">,
  options: VerifyPackBadgesOptions = {},
): Promise<BadgeVerification[]> {
  const raw = await readPackBadges(pack.root)
  if (raw.length === 0) return []

  const expected = {
    packName: pack.manifest.name,
    packVersion: pack.manifest.version,
    manifestHash: canonicalProbePackManifestHash(pack.manifest),
  }
  const attesterKeys = options.authorizedAttesterKeys ?? []
  const makeError = (m: string) => new ProbePackError(m)

  const results: BadgeVerification[] = []
  for (const r of raw) {
    if (r.badge === undefined) {
      results.push({ file: r.file, status: "malformed", reason: r.parseError })
      continue
    }
    const badge = r.badge
    // Applicability first, so a mis-attached badge is distinguishable from a forged
    // one in the surfaced status (both are untrusted, but for different reasons).
    try {
      assertBadgeAppliesTo(badge, expected, makeError)
    } catch (err) {
      results.push({ file: r.file, status: "not_applicable", badge, reason: errMessage(err) })
      continue
    }
    try {
      verifyPackBadgeSignature(badge, { authorizedAttesterKeys: attesterKeys, makeError })
    } catch (err) {
      results.push({ file: r.file, status: "unverified", badge, reason: errMessage(err) })
      continue
    }
    results.push({ file: r.file, status: "verified", badge })
  }
  return results
}

/** The pack subject (identity + manifest-hash binding) a badge attests over. */
function subjectFor(manifest: ProbePackManifest): PackBadgeSubject {
  return {
    pack: manifest.name,
    version: manifest.version,
    manifest_hash: canonicalProbePackManifestHash(manifest),
  }
}

/** Common inputs for issuing (signing) a badge. The key never leaves this call. */
export interface AttestBadgeOptions {
  /** The attesting authority's signer id — written as `attester_id` and bound to the signature. */
  attesterId: string
  /** The attester's Ed25519 PKCS#8 PEM private key. Never logged or returned. */
  privateKeyPem: string
  /** Issuance timestamp (ISO 8601). Caller-supplied, keeping this deterministic. */
  at: string
}

/**
 * Build and sign a `probe_results` badge from a harness run over the pack — the
 * natural signed summary of `lodestar harness run`. The badge binds to the pack's
 * canonical manifest hash, so it is only trusted over the exact bytes that ran.
 * Probe names are included by default (so a consumer sees what was exercised); pass
 * `includeProbeNames: false` to omit them.
 */
export function buildProbeResultsBadge(
  manifest: ProbePackManifest,
  run: Pick<PackRunResult, "ok" | "total" | "passed" | "failed" | "outcomes">,
  options: AttestBadgeOptions & { harnessVersion: string; includeProbeNames?: boolean },
): ProbeResultsBadge {
  const unsigned: Omit<ProbeResultsBadge, "signature"> = {
    badge_version: PACK_BADGE_SPEC_VERSION,
    kind: "probe_results",
    subject: subjectFor(manifest),
    attester_id: options.attesterId,
    issued_at: options.at,
    result: {
      ok: run.ok,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      harness_version: options.harnessVersion,
      ...(options.includeProbeNames === false ? {} : { probes: run.outcomes.map((o) => o.name) }),
    },
  }
  return signPackBadge(unsigned, {
    privateKeyPem: options.privateKeyPem,
    at: options.at,
    makeError: (m) => new ProbePackError(m),
  })
}

/**
 * Build and sign a `security_scan` badge over a **provided** scan result. The
 * scanner that produces the result is out of scope for the open repo (ADR-0016 §4);
 * this signs whatever verdict it is handed, binding it to the pack's manifest hash.
 */
export function buildSecurityScanBadge(
  manifest: ProbePackManifest,
  scan: SecurityScanBadgeResult,
  options: AttestBadgeOptions,
): SecurityScanBadge {
  const unsigned: Omit<SecurityScanBadge, "signature"> = {
    badge_version: PACK_BADGE_SPEC_VERSION,
    kind: "security_scan",
    subject: subjectFor(manifest),
    attester_id: options.attesterId,
    issued_at: options.at,
    result: scan,
  }
  return signPackBadge(unsigned, {
    privateKeyPem: options.privateKeyPem,
    at: options.at,
    makeError: (m) => new ProbePackError(m),
  })
}

/** Sanitise an attester id into a safe single filename component. */
function badgeFileSlug(attesterId: string): string {
  const slug = attesterId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_")
  return slug.length > 0 ? slug : "attester"
}

/**
 * Write a signed badge into the pack's `badges/` directory as
 * `<attester>.<kind>.badge.json`, atomically (temp + rename). Creates `badges/` if
 * absent. A re-issue by the same attester for the same kind overwrites the prior
 * file (one current attestation per attester+kind). Returns the path written.
 */
export async function writePackBadge(packRoot: string, badge: PackBadge): Promise<string> {
  const dir = join(packRoot, PACK_BADGES_DIRNAME)
  await mkdir(dir, { recursive: true })
  const filename = `${badgeFileSlug(badge.attester_id)}.${badge.kind}${PACK_BADGE_FILE_SUFFIX}`
  const full = join(dir, filename)
  const tmp = `${full}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(badge, null, 2)}\n`, "utf8")
    await rename(tmp, full)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new ProbePackError(`Could not write badge to ${full}`, { cause: err })
  }
  return full
}
