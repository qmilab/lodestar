#!/usr/bin/env bun
/**
 * Probe: pack_manifest_signature_required
 *
 * The registry trust root (#88, ADR-0017). A probe pack's manifest carries an
 * Ed25519 signature by the pack author; the consumer pins trusted author keys and
 * the harness loader verifies the signature **on load** against that pinned set.
 *
 * This probe locks the signature-required contract and the `allow_unsigned`
 * opt-out semantics — the secure-by-default behaviour that mirrors the approval
 * side-channel (`verifyApprovalSignature`):
 *
 *   A. SIGNED + PINNED — a manifest signed by the pinned author key loads, and the
 *      probes resolve.
 *   B. UNSIGNED, no opt-out — a manifest with no signature is REJECTED by default;
 *      an external pack cannot load unsigned.
 *   C. UNSIGNED + allow_unsigned — the explicit opt-out (first-party in-repo packs
 *      / local dev) lets an unsigned pack load. No silent default — the caller
 *      asks for it.
 *   D. SIGNED but author NOT pinned — a perfectly valid signature from an author
 *      the operator has not pinned is REJECTED. Pinning is the trust root, not the
 *      mere presence of a signature.
 *   E. allow_unsigned does NOT weaken a PRESENT signature — a manifest carrying a
 *      tampered signature is still rejected even with allow_unsigned set; the
 *      opt-out governs only the *absent*-signature case.
 *
 * If any case is wrong, an external pack could load without an authentic,
 * operator-trusted signature — the hole the registry exists to close.
 */

import { createHash } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_SPEC_VERSION,
  type PackContentDigest,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { ProbePackError, loadProbePack } from "@qmilab/lodestar-harness"

const AUTHOR_ID = "trusted-pack-author"
const AT = "2026-01-01T00:00:00.000Z"
const PROBE_FILES = [{ path: "noop.ts", content: "#!/usr/bin/env bun\nexport {}\n" }]

function contentDigest(files: { path: string; content: string }[]): PackContentDigest {
  const entries = files
    .map((f) => ({ path: f.path, sha256: createHash("sha256").update(f.content).digest("hex") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { algorithm: "sha256", files: entries }
}

function baseManifest(): ProbePackManifest {
  return {
    name: "probe-signed-pack",
    version: "0.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    coverage_areas: ["pack_signing"],
    invariants: ["pack_signature"],
    probes: PROBE_FILES.map((f) => ({ name: f.path.replace(/\.ts$/, ""), file: f.path })),
  }
}

function signedManifest(privateKeyPem: string, authorId = AUTHOR_ID): ProbePackManifest {
  const unsigned: ProbePackManifest = {
    ...baseManifest(),
    author_id: authorId,
    content_digest: contentDigest(PROBE_FILES),
  }
  const signature = signProbePackManifest(unsigned, { authorId, privateKeyPem, at: AT })
  return { ...unsigned, signature }
}

async function writePack(manifest: ProbePackManifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-probe-sigreq-"))
  for (const f of PROBE_FILES) await writeFile(join(dir, f.path), f.content)
  await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
  return dir
}

async function assertRejects(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ProbePackError && err.message.includes(needle)) return
    throw new Error(`expected a ProbePackError containing "${needle}", got: ${String(err)}`)
  }
  throw new Error(`expected rejection containing "${needle}" but the load succeeded`)
}

async function run(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  try {
    const operator = generateEd25519KeyPair()
    const pinned = [{ actor_id: AUTHOR_ID, public_key: operator.publicKeyPem }]

    // ── A — signed by the pinned author → loads ──────────────────────────────
    const packA = await loadProbePack(await writePack(signedManifest(operator.privateKeyPem)), {
      authorizedAuthorKeys: pinned,
    })
    if (packA.probes.length !== 1 || packA.probes[0]?.name !== "noop") {
      throw new Error("A: signed+pinned pack did not resolve its probe")
    }
    details.push("A: signed by the pinned author key → loads, probe resolved ✓")

    // ── B — unsigned, no opt-out → rejected ──────────────────────────────────
    await assertRejects(
      async () => loadProbePack(await writePack(baseManifest()), { authorizedAuthorKeys: pinned }),
      "is unsigned",
    )
    details.push("B: unsigned manifest with no allow_unsigned → rejected ✓")

    // ── C — unsigned + explicit opt-out → loads ──────────────────────────────
    const packC = await loadProbePack(await writePack(baseManifest()), { allowUnsigned: true })
    if (packC.probes.length !== 1) throw new Error("C: allow_unsigned pack did not resolve")
    details.push("C: unsigned manifest under explicit allow_unsigned → loads ✓")

    // ── D — signed but author not pinned → rejected ──────────────────────────
    await assertRejects(
      async () =>
        loadProbePack(await writePack(signedManifest(operator.privateKeyPem)), {
          authorizedAuthorKeys: [],
        }),
      "not in the operator-pinned",
    )
    details.push(
      "D: valid signature from an UN-pinned author → rejected (pinning is the trust root) ✓",
    )

    // ── E — allow_unsigned must NOT excuse a present, tampered signature ──────
    const signed = signedManifest(operator.privateKeyPem)
    const tampered: ProbePackManifest = {
      ...signed,
      // Present signature, but its payload_hash no longer matches the manifest.
      signature: { ...signed.signature!, payload_hash: "0".repeat(64) },
    }
    await assertRejects(
      async () =>
        loadProbePack(await writePack(tampered), {
          authorizedAuthorKeys: pinned,
          allowUnsigned: true,
        }),
      "payload_hash",
    )
    details.push(
      "E: allow_unsigned does NOT excuse a present tampered signature → still rejected ✓",
    )
  } catch (err) {
    return {
      passed: false,
      details: [...details, `FAIL: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: pack_manifest_signature_required")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
