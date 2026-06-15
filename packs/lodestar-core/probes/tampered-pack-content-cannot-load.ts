#!/usr/bin/env bun
/**
 * Probe: tampered_pack_content_cannot_load
 *
 * The content-binding half of the signed-manifest trust root (#88, ADR-0016 §2,
 * ADR-0017) — the Codex-flagged supply-chain hole. A signature over only the
 * manifest *declaration* (names + version) is not enough: a re-pointed git tag or
 * a re-published npm artifact can swap a probe's *bytes* under a still-valid
 * signature. The fix: the signed manifest carries a `content_digest` (a per-file
 * sha-256 over the declared probe files), and the loader recomputes that digest
 * over the on-disk files and rejects a mismatch.
 *
 *   A. CONTROL — a signed pack with a matching content digest loads.
 *   B. SWAPPED BYTES — after signing, a probe file's bytes are changed on disk
 *      WITHOUT touching the manifest. The manifest signature is still perfectly
 *      valid (the declaration is unchanged), yet the load is REJECTED because the
 *      on-disk file no longer matches the signed digest. This is the property a
 *      declaration-only signature cannot give.
 *   C. ADDED FILE — a file present in the signed digest is fine, but a probe file
 *      whose bytes were never signed (digest entry removed) is rejected.
 *   D. NO DIGEST — a manifest that is signed but carries NO content_digest is
 *      rejected: a signature that binds only names, not bytes, is refused outright
 *      rather than silently accepted.
 *
 * The headline is B: a valid signature is necessary but not sufficient — the bytes
 * must be the bytes that were signed.
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
const FILES = [
  { path: "alpha.ts", content: "#!/usr/bin/env bun\nexport const a = 1\n" },
  { path: "beta.ts", content: "#!/usr/bin/env bun\nexport const b = 2\n" },
]

function contentDigest(files: { path: string; content: string }[]): PackContentDigest {
  const entries = files
    .map((f) => ({ path: f.path, sha256: createHash("sha256").update(f.content).digest("hex") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { algorithm: "sha256", files: entries }
}

function manifestFor(files: { path: string; content: string }[]): ProbePackManifest {
  return {
    name: "probe-content-pack",
    version: "0.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    coverage_areas: ["pack_signing"],
    invariants: ["pack_content_digest"],
    probes: files.map((f) => ({ name: f.path.replace(/\.ts$/, ""), file: f.path })),
  }
}

/**
 * Sign a manifest. `digestOver` is the file set the content_digest is computed
 * over (defaults to the declared files); passing a different set lets a case forge
 * a digest/file mismatch. `omitDigest` produces a signed manifest with NO digest.
 */
function sign(
  privateKeyPem: string,
  opts: {
    digestOver?: { path: string; content: string }[]
    omitDigest?: boolean
  } = {},
): ProbePackManifest {
  const unsigned: ProbePackManifest = {
    ...manifestFor(FILES),
    author_id: AUTHOR_ID,
    ...(opts.omitDigest ? {} : { content_digest: contentDigest(opts.digestOver ?? FILES) }),
  }
  const signature = signProbePackManifest(unsigned, { authorId: AUTHOR_ID, privateKeyPem, at: AT })
  return { ...unsigned, signature }
}

/** Write a pack dir, optionally with the on-disk file bytes diverging from `onDisk`. */
async function writePack(
  manifest: ProbePackManifest,
  onDisk: { path: string; content: string }[] = FILES,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-probe-content-"))
  for (const f of onDisk) await writeFile(join(dir, f.path), f.content)
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

    // ── A — control: signed pack, on-disk bytes match the digest → loads ─────
    const ok = await loadProbePack(await writePack(sign(operator.privateKeyPem)), {
      authorizedAuthorKeys: pinned,
    })
    if (ok.probes.length !== 2) throw new Error("A: control signed pack failed to load")
    details.push("A: signed pack whose on-disk bytes match the digest → loads ✓")

    // ── B — bytes swapped after signing; signature still valid → rejected ────
    const swapped = [
      FILES[0]!,
      { path: "beta.ts", content: "#!/usr/bin/env bun\nexport const b = 999 // swapped\n" },
    ]
    await assertRejects(
      async () =>
        loadProbePack(await writePack(sign(operator.privateKeyPem), swapped), {
          authorizedAuthorKeys: pinned,
        }),
      "has been modified since it was signed",
    )
    details.push(
      "B: a probe file's bytes swapped after signing → content-digest mismatch (signature still valid) ✓",
    )

    // ── C — a file's digest entry was never signed (signed over fewer files) ─
    // The manifest declares + ships both files, but the signed digest only covers
    // alpha.ts, so beta.ts is present on disk but absent from the signed digest.
    await assertRejects(
      async () =>
        loadProbePack(await writePack(sign(operator.privateKeyPem, { digestOver: [FILES[0]!] })), {
          authorizedAuthorKeys: pinned,
        }),
      "not in the signed content_digest",
    )
    details.push("C: a shipped probe file absent from the signed digest → rejected ✓")

    // ── D — signed but carrying no content_digest at all → rejected ──────────
    await assertRejects(
      async () =>
        loadProbePack(await writePack(sign(operator.privateKeyPem, { omitDigest: true })), {
          authorizedAuthorKeys: pinned,
        }),
      "no content_digest",
    )
    details.push(
      "D: a signed manifest with no content_digest (binds names, not bytes) → rejected ✓",
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
console.log("probe: tampered_pack_content_cannot_load")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
