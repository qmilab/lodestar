#!/usr/bin/env bun
/**
 * Probe: forged_pack_cannot_load
 *
 * The forgery boundary of the signed-manifest trust root (#88, ADR-0017). An
 * operator pins one author key. An attacker who does NOT hold that key tries every
 * forgery they can mint locally; each must be rejected on load.
 *
 *   1. WRONG KEY — the attacker signs a manifest claiming `author_id` =
 *      `signer_id` = the pinned author, but with their OWN private key. The
 *      `payload_hash` is genuine (they recompute it freely), so the hash alone is
 *      no defence — the signature *bytes* fail against the pinned public key.
 *   2. UNPINNED SIGNER — the attacker signs honestly with their own id. The
 *      signature is internally valid, but the signer is not in the pinned set.
 *   3. SIGNER ≠ AUTHOR — a manifest whose `signature.signer_id` does not match the
 *      declared `author_id` (a signature lifted onto another author's pack).
 *   4. TAMPERED DECLARATION — a manifest legitimately signed by the pinned author,
 *      then edited after signing (a probe renamed). The recomputed canonical hash
 *      no longer matches the signed `payload_hash`.
 *
 * The control: the same author's *un-tampered* manifest loads, proving the
 * rejections are the forgery, not a broken verifier. The anti-forgery property is
 * possession of the pinned private key — which the attacker never has.
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
const ATTACKER_ID = "totally-not-the-author"
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
    name: "probe-forged-pack",
    version: "0.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    coverage_areas: ["pack_signing"],
    invariants: ["pack_signature"],
    probes: PROBE_FILES.map((f) => ({ name: f.path.replace(/\.ts$/, ""), file: f.path })),
  }
}

/** Sign a manifest declaring `authorId`, using `privateKeyPem` (possibly mismatched). */
function signAs(authorId: string, privateKeyPem: string): ProbePackManifest {
  const unsigned: ProbePackManifest = {
    ...baseManifest(),
    author_id: authorId,
    content_digest: contentDigest(PROBE_FILES),
  }
  const signature = signProbePackManifest(unsigned, { authorId, privateKeyPem, at: AT })
  return { ...unsigned, signature }
}

async function writePack(manifest: ProbePackManifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-probe-forged-pack-"))
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
    const attacker = generateEd25519KeyPair()
    const pinned = [{ actor_id: AUTHOR_ID, public_key: operator.publicKeyPem }]

    // ── Control — the real author's un-tampered manifest loads ───────────────
    const ok = await loadProbePack(await writePack(signAs(AUTHOR_ID, operator.privateKeyPem)), {
      authorizedAuthorKeys: pinned,
    })
    if (ok.probes.length !== 1) throw new Error("control: the genuine signed pack failed to load")
    details.push("control: genuine pack signed by the pinned key → loads ✓")

    // ── 1 — attacker forges the author's identity with their own key ─────────
    await assertRejects(
      async () =>
        loadProbePack(await writePack(signAs(AUTHOR_ID, attacker.privateKeyPem)), {
          authorizedAuthorKeys: pinned,
        }),
      "failed Ed25519 signature verification",
    )
    details.push(
      "1: signed as the author but with the ATTACKER's key → bytes fail against pinned key ✓",
    )

    // ── 2 — attacker signs honestly under their own (unpinned) id ────────────
    await assertRejects(
      async () =>
        loadProbePack(await writePack(signAs(ATTACKER_ID, attacker.privateKeyPem)), {
          authorizedAuthorKeys: pinned,
        }),
      "not in the operator-pinned",
    )
    details.push("2: validly signed by an UNPINNED author id → rejected ✓")

    // ── 3 — signature.signer_id lifted onto a different declared author ───────
    const lifted = signAs(AUTHOR_ID, operator.privateKeyPem)
    const liftedManifest: ProbePackManifest = {
      ...lifted,
      signature: { ...lifted.signature!, signer_id: "someone-else" },
    }
    await assertRejects(
      async () => loadProbePack(await writePack(liftedManifest), { authorizedAuthorKeys: pinned }),
      "does not match the declared signer",
    )
    details.push("3: signature signer_id ≠ declared author_id → rejected ✓")

    // ── 4 — manifest edited after signing (probe renamed) ────────────────────
    const signed = signAs(AUTHOR_ID, operator.privateKeyPem)
    const edited: ProbePackManifest = {
      ...signed,
      probes: [{ name: "renamed-after-signing", file: PROBE_FILES[0]!.path }],
    }
    await assertRejects(
      async () => loadProbePack(await writePack(edited), { authorizedAuthorKeys: pinned }),
      "payload_hash",
    )
    details.push("4: manifest declaration edited after signing → payload_hash mismatch ✓")
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
console.log("probe: forged_pack_cannot_load")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
