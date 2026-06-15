#!/usr/bin/env bun
/**
 * Probe: unverified_badge_not_trusted
 *
 * Verification badges are the registry's second trust axis (#89, ADR-0020):
 * locally-verifiable signed attestations — `probe_results` / `security_scan` —
 * **attached to** a pack in its `badges/` directory, verified against a **separate**
 * pinned **attester** trust root. They are *advisory*: surfaced before install,
 * never a gate. The load-bearing property (threat-model §5): a compromised index can
 * strip or mis-attach badges, but it cannot forge one that verifies — and an
 * unverified or unpinned-attester badge is shown as exactly that and **never counted
 * as trusted**.
 *
 *   A. VERIFIED — a `probe_results` badge signed by an attester the consumer pins,
 *      bound to the pack's manifest hash, is surfaced as `verified` (trusted).
 *   B. UNPINNED ATTESTER — the same valid badge, added with NO attester pinned, is
 *      surfaced as `unverified` and never trusted. The pack still adds (advisory).
 *   C. FORGED — a badge that *claims* the pinned attester id but was signed by a
 *      different (attacker) key fails signature verification → `unverified`.
 *   D. MIS-ATTACHED — a badge legitimately signed by the pinned attester but issued
 *      over *different* bytes (a different manifest hash), dropped into this pack, is
 *      surfaced as `not_applicable` even though its signature verifies.
 *   E. TAMPERED — a verified badge edited after signing fails on the payload hash →
 *      `unverified`.
 *   F. MALFORMED + ADVISORY — a junk badge file is surfaced as `malformed`, and in
 *      EVERY case above the pack itself still verifies and adds: a badge never gates.
 *
 * Everything runs offline over temp directories; no network, no subprocess. The
 * harness run a real `probe_results` badge would summarise is faked here with a fixed
 * result so the probe stays inert (the CLI's `pack attest` runs the real probes).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_SPEC_VERSION,
  type ProbePackManifest,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import {
  type AddedProbePack,
  type BadgeVerification,
  type PackRunResult,
  addProbePack,
  buildProbeResultsBadge,
  publishProbePack,
  writePackBadge,
} from "@qmilab/lodestar-harness"

const AUTHOR_ID = "acme-pack-author"
const ATTESTER_ID = "acme-scanner"
const AT = "2026-01-01T00:00:00.000Z"
const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\nprocess.exit(0)\n"

/** A fixed, inert run result the probe_results badge summarises (no real run here). */
const FAKE_RUN: Pick<PackRunResult, "ok" | "total" | "passed" | "failed" | "outcomes"> = {
  ok: true,
  total: 1,
  passed: 1,
  failed: 0,
  outcomes: [
    {
      name: "sample",
      file: PROBE_FILE,
      passed: true,
      exit_code: 0,
      signal: null,
      duration_ms: 1,
      started_at: AT,
      stdout: "",
      stderr: "",
    },
  ],
}

/** Write an unsigned pack (manifest + one probe file) into `dir`; returns the dir. */
async function writeUnsignedPack(dir: string, name: string): Promise<string> {
  await mkdir(join(dir, "probes"), { recursive: true })
  await writeFile(join(dir, PROBE_FILE), PROBE_BODY, "utf8")
  const manifest: ProbePackManifest = {
    name,
    version: "1.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    description: "A demo pack for the badge-trust probe.",
    coverage_areas: ["pack_registry"],
    invariants: ["unverified_badge_not_trusted"],
    probes: [{ name: "sample", file: PROBE_FILE }],
  }
  await writeFile(
    join(dir, "lodestar.probe-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )
  return dir
}

/**
 * Publish (sign) a freshly written pack and return its dir + the signed manifest. The
 * signed manifest is what badges bind to (its canonical hash) and what `add`
 * recomputes, so the two agree.
 */
async function signedPack(
  workspace: string,
  dirName: string,
  packName: string,
  authorPriv: string,
): Promise<{ dir: string; manifest: ProbePackManifest }> {
  const dir = await writeUnsignedPack(join(workspace, dirName), packName)
  const published = await publishProbePack({
    target: dir,
    authorId: AUTHOR_ID,
    privateKeyPem: authorPriv,
    at: AT,
  })
  return { dir, manifest: published.manifest }
}

function only(badges: BadgeVerification[]): BadgeVerification {
  if (badges.length !== 1) {
    throw new Error(`expected exactly one badge, got ${badges.length}`)
  }
  return badges[0] as BadgeVerification
}

async function run(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  const workspace = await mkdtemp(join(tmpdir(), "lodestar-badge-trust-"))
  const author = generateEd25519KeyPair()
  const attester = generateEd25519KeyPair()
  const attacker = generateEd25519KeyPair()
  const pinnedAuthor = [{ actor_id: AUTHOR_ID, public_key: author.publicKeyPem }]
  const pinnedAttester = [{ actor_id: ATTESTER_ID, public_key: attester.publicKeyPem }]

  /** add a local pack, asserting the pack itself verified (advisory: never gated). */
  async function add(
    dir: string,
    attesterKeys: typeof pinnedAttester | [],
  ): Promise<AddedProbePack> {
    const added = await addProbePack({
      ref: { type: "local", path: dir },
      authorizedAuthorKeys: pinnedAuthor,
      authorizedAttesterKeys: attesterKeys,
      at: AT,
    })
    // The pack ALWAYS verifies — a badge outcome never blocks the add.
    if (added.pack.manifest.author_id !== AUTHOR_ID) {
      throw new Error("the pack itself failed to verify — a badge must never gate the add")
    }
    return added
  }

  try {
    // ── A — VERIFIED ────────────────────────────────────────────────────────────
    const good = await signedPack(workspace, "good", "good-pack", author.privateKeyPem)
    const goodBadge = buildProbeResultsBadge(good.manifest, FAKE_RUN, {
      attesterId: ATTESTER_ID,
      privateKeyPem: attester.privateKeyPem,
      at: AT,
      harnessVersion: "probe",
    })
    await writePackBadge(good.dir, goodBadge)
    const verified = only((await add(good.dir, pinnedAttester)).badges)
    if (verified.status !== "verified") {
      throw new Error(`a pinned-attester badge should be verified, got '${verified.status}'`)
    }
    details.push("A: a badge signed by a PINNED attester, bound to the manifest hash → verified ✓")

    // ── B — UNPINNED ATTESTER ─────────────────────────────────────────────────────
    const unpinned = only((await add(good.dir, [])).badges)
    if (unpinned.status !== "unverified") {
      throw new Error(`an unpinned-attester badge should be unverified, got '${unpinned.status}'`)
    }
    details.push("B: the SAME badge with no attester pinned → unverified, never trusted ✓")

    // ── C — FORGED ────────────────────────────────────────────────────────────────
    // A badge that claims the pinned attester id but was signed by an attacker's key.
    const forgedPack = await signedPack(workspace, "forged", "forged-pack", author.privateKeyPem)
    const forgedBadge = buildProbeResultsBadge(forgedPack.manifest, FAKE_RUN, {
      attesterId: ATTESTER_ID, // claims the pinned attester…
      privateKeyPem: attacker.privateKeyPem, // …but signed by the attacker.
      at: AT,
      harnessVersion: "probe",
    })
    await writePackBadge(forgedPack.dir, forgedBadge)
    const forged = only((await add(forgedPack.dir, pinnedAttester)).badges)
    if (forged.status !== "unverified") {
      throw new Error(`a forged badge should be unverified, got '${forged.status}'`)
    }
    details.push("C: a badge claiming the pinned attester but signed by another key → unverified ✓")

    // ── D — MIS-ATTACHED ───────────────────────────────────────────────────────────
    // A badge legitimately signed by the pinned attester, but issued over DIFFERENT
    // bytes (a different manifest), dropped into this pack. Its signature verifies; its
    // subject manifest_hash does not match this pack — the mis-attach defence.
    const misPack = await signedPack(workspace, "mis", "mis-pack", author.privateKeyPem)
    const otherManifest: ProbePackManifest = {
      ...misPack.manifest,
      name: "other-pack",
      version: "9.9.9",
    }
    const misBadge = buildProbeResultsBadge(otherManifest, FAKE_RUN, {
      attesterId: ATTESTER_ID,
      privateKeyPem: attester.privateKeyPem, // a genuine signature by the pinned attester
      at: AT,
      harnessVersion: "probe",
    })
    await writePackBadge(misPack.dir, misBadge)
    const misAttached = only((await add(misPack.dir, pinnedAttester)).badges)
    if (misAttached.status !== "not_applicable") {
      throw new Error(`a mis-attached badge should be not_applicable, got '${misAttached.status}'`)
    }
    details.push("D: a validly-signed badge issued over different bytes → not_applicable ✓")

    // ── E — TAMPERED ────────────────────────────────────────────────────────────────
    const tamperPack = await signedPack(workspace, "tamper", "tamper-pack", author.privateKeyPem)
    const tamperBadge = buildProbeResultsBadge(tamperPack.manifest, FAKE_RUN, {
      attesterId: ATTESTER_ID,
      privateKeyPem: attester.privateKeyPem,
      at: AT,
      harnessVersion: "probe",
    })
    const tamperPath = await writePackBadge(tamperPack.dir, tamperBadge)
    // Edit the badge's result AFTER signing — the canonical hash no longer matches.
    const onDisk = JSON.parse(await readFile(tamperPath, "utf8")) as Record<string, unknown>
    onDisk.result = { ...(onDisk.result as object), ok: false, failed: 99 }
    await writeFile(tamperPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8")
    const tampered = only((await add(tamperPack.dir, pinnedAttester)).badges)
    if (tampered.status !== "unverified") {
      throw new Error(`a tampered badge should be unverified, got '${tampered.status}'`)
    }
    details.push("E: a badge edited after signing → unverified (payload hash) ✓")

    // ── F — MALFORMED + ADVISORY ──────────────────────────────────────────────────
    const junkPack = await signedPack(workspace, "junk", "junk-pack", author.privateKeyPem)
    await mkdir(join(junkPack.dir, "badges"), { recursive: true })
    await writeFile(join(junkPack.dir, "badges", "broken.badge.json"), "{not valid json", "utf8")
    const malformed = only((await add(junkPack.dir, pinnedAttester)).badges)
    if (malformed.status !== "malformed") {
      throw new Error(`a junk badge file should be malformed, got '${malformed.status}'`)
    }
    // Advisory has been asserted in every `add` above (the pack always verified); a
    // pack carrying ONLY a malformed/forged badge still adds.
    details.push(
      "F: a junk badge file → malformed; in every case the pack still verifies (advisory) ✓",
    )

    // ── G — UNREADABLE badges/ PATH NEVER GATES (Codex review, PR #118) ──────────
    // A pack can ship `badges` as a regular file (or an EACCES dir / malformed
    // archive entry): readdir throws ENOTDIR/EACCES, not ENOENT. That must NOT fail
    // an otherwise-verified pack — badge state is advisory, never a gate.
    const gatePack = await signedPack(workspace, "gate", "gate-pack", author.privateKeyPem)
    await writeFile(join(gatePack.dir, "badges"), "i am a file, not a directory", "utf8")
    const unreadable = only((await add(gatePack.dir, pinnedAttester)).badges)
    if (unreadable.status !== "malformed") {
      throw new Error(`an unreadable badges/ path should be malformed, got '${unreadable.status}'`)
    }
    details.push(
      "G: a `badges` path that is not a readable directory → malformed, the pack still adds ✓",
    )
  } catch (err) {
    return {
      passed: false,
      details: [...details, `FAIL: ${err instanceof Error ? err.message : String(err)}`],
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: unverified_badge_not_trusted")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
