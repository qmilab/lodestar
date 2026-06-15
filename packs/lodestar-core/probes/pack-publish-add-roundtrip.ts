#!/usr/bin/env bun
/**
 * Probe: pack_publish_add_roundtrip
 *
 * The author + consumer flow end-to-end (#90, ADR-0019). `lodestar pack publish`
 * (here `publishProbePack`) signs a pack's manifest after freezing its files;
 * `lodestar pack add` (here `addProbePack`) resolves a pinned source via a
 * non-executing fetch, verifies the signature + content digest against pinned
 * author keys BEFORE any pack code could run, then installs + records the pin.
 *
 *   A. PUBLISH — an unsigned pack is signed in place: the on-disk manifest gains a
 *      content_digest over its frozen probe files, an author_id, and an Ed25519
 *      signature, and publish self-verifies the result (it derives the public key
 *      from the private one and re-loads through the consumer's exact path).
 *   B. ADD (roundtrip) — the published pack resolves from a local source, verifies
 *      against the pinned author key, installs to a stable dir (the installed copy
 *      re-verified), and records the immutable pin + the canonical manifest hash in
 *      a lockfile.
 *   C. TAMPERED BYTES — a probe file swapped after signing fails `add` on the
 *      content-digest check, even though the signature still verifies.
 *   D. TAMPERED MANIFEST — a manifest field edited after signing fails `add` on the
 *      signature (payload_hash) check.
 *   E. UNPINNED AUTHOR — a validly signed pack whose author is not pinned is
 *      rejected (the trust root), and allow_unsigned does NOT excuse it.
 *   F. NO KEY LEAK — the author's private key never appears in the written
 *      manifest, the publish result, or the recorded lockfile.
 *
 * Everything runs offline over temp directories; no network, no subprocess.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_SPEC_VERSION,
  type ProbePackManifest,
  canonicalProbePackManifestHash,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import {
  ProbePackError,
  addProbePack,
  publishProbePack,
  readPackLockfile,
} from "@qmilab/lodestar-harness"

const AUTHOR_ID = "acme-pack-author"
const AT = "2026-01-01T00:00:00.000Z"
const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\nprocess.exit(0)\n"

/** Write an unsigned pack (manifest + one probe file) into `dir`; returns the dir. */
async function writeUnsignedPack(dir: string): Promise<string> {
  await mkdir(join(dir, "probes"), { recursive: true })
  await writeFile(join(dir, PROBE_FILE), PROBE_BODY, "utf8")
  const manifest: ProbePackManifest = {
    name: "acme-safety-pack",
    version: "1.2.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    description: "A demo pack for the publish/add roundtrip.",
    coverage_areas: ["pack_registry"],
    invariants: ["pack_publish_add_roundtrip"],
    probes: [{ name: "sample", file: PROBE_FILE }],
  }
  await writeFile(
    join(dir, "lodestar.probe-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )
  return dir
}

async function assertRejects(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof ProbePackError)) throw err
    if (!err.message.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`expected rejection mentioning '${needle}', got: ${err.message}`)
    }
    return
  }
  throw new Error(`expected a ProbePackError mentioning '${needle}', but the call succeeded`)
}

async function run(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  const workspace = await mkdtemp(join(tmpdir(), "lodestar-pack-roundtrip-"))
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()

  try {
    // ── A — PUBLISH ──────────────────────────────────────────────────────────
    const packDir = await writeUnsignedPack(join(workspace, "pack"))
    const published = await publishProbePack({
      target: packDir,
      authorId: AUTHOR_ID,
      privateKeyPem,
      at: AT,
    })
    if (published.manifest.signature === undefined) throw new Error("publish produced no signature")
    if (published.manifest.author_id !== AUTHOR_ID) throw new Error("author_id not set on publish")
    if (published.contentDigest.files.length !== 1)
      throw new Error("content_digest should cover the one probe file")
    if (published.publicKeyPem.trim() !== publicKeyPem.trim())
      throw new Error("publish derived a public key that differs from the author keypair")
    // The on-disk manifest is now the signed one (publish self-verified it, so a
    // round-trip through the consumer's load path already succeeded).
    const onDisk = JSON.parse(
      await readFile(join(packDir, "lodestar.probe-pack.json"), "utf8"),
    ) as ProbePackManifest
    if (onDisk.signature?.algorithm !== "ed25519" || onDisk.content_digest === undefined)
      throw new Error("on-disk manifest is not a signed, content-bound manifest")
    details.push(
      "A: publish freezes files → content_digest + author_id + Ed25519 signature, self-verified ✓",
    )

    // ── B — ADD (roundtrip) ──────────────────────────────────────────────────
    const installRoot = join(workspace, "installed")
    const lockfilePath = join(workspace, "packs.lock.json")
    const added = await addProbePack({
      ref: { type: "local", path: packDir },
      authorizedAuthorKeys: [{ actor_id: AUTHOR_ID, public_key: publicKeyPem }],
      at: AT,
      installRoot,
      lockfilePath,
    })
    if (added.installedRoot === undefined) throw new Error("add did not install the pack")
    // The installed copy must itself load + verify (the TOCTOU re-verify ran).
    await readFile(join(added.installedRoot, PROBE_FILE), "utf8")
    if (added.lockEntry === undefined) throw new Error("add did not record a lock entry")
    const expectedHash = canonicalProbePackManifestHash(published.manifest)
    if (added.lockEntry.manifest_hash !== expectedHash)
      throw new Error("lock entry manifest_hash does not bind the verified manifest")
    if (added.lockEntry.author_id !== AUTHOR_ID || added.lockEntry.source.type !== "local")
      throw new Error("lock entry did not record the author + pinned source")
    // The lockfile is on disk and re-readable as the recorded pin.
    const lock = await readPackLockfile(lockfilePath)
    if (lock.packs.length !== 1 || lock.packs[0]?.name !== "acme-safety-pack")
      throw new Error("lockfile does not contain exactly the added pack")
    details.push(
      "B: add resolves → verifies → installs (copy re-verified) → records the pinned hash ✓",
    )

    // ── C — TAMPERED BYTES (post-signing) ────────────────────────────────────
    const tamperBytes = await writeUnsignedPack(join(workspace, "tamper-bytes"))
    await publishProbePack({ target: tamperBytes, authorId: AUTHOR_ID, privateKeyPem, at: AT })
    // Swap a probe byte AFTER signing — the signature still verifies, the digest does not.
    await writeFile(join(tamperBytes, PROBE_FILE), `${PROBE_BODY}// injected\n`, "utf8")
    await assertRejects(
      () =>
        addProbePack({
          ref: { type: "local", path: tamperBytes },
          authorizedAuthorKeys: [{ actor_id: AUTHOR_ID, public_key: publicKeyPem }],
          at: AT,
        }),
      "content digest mismatch",
    )
    details.push("C: a probe byte swapped after signing → rejected on the content digest ✓")

    // ── D — TAMPERED MANIFEST (post-signing) ─────────────────────────────────
    const tamperManifest = await writeUnsignedPack(join(workspace, "tamper-manifest"))
    await publishProbePack({ target: tamperManifest, authorId: AUTHOR_ID, privateKeyPem, at: AT })
    const manifestPath = join(tamperManifest, "lodestar.probe-pack.json")
    const signed = JSON.parse(await readFile(manifestPath, "utf8")) as ProbePackManifest
    // Edit a signed field without re-signing — the payload_hash no longer matches.
    signed.version = "9.9.9"
    await writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, "utf8")
    await assertRejects(
      () =>
        addProbePack({
          ref: { type: "local", path: tamperManifest },
          authorizedAuthorKeys: [{ actor_id: AUTHOR_ID, public_key: publicKeyPem }],
          at: AT,
        }),
      "payload_hash",
    )
    details.push("D: a manifest field edited after signing → rejected on the signature ✓")

    // ── E — UNPINNED AUTHOR ──────────────────────────────────────────────────
    // The validly signed pack from A, added with NO pinned author. The trust root:
    // a signature is necessary but not sufficient — the signer must be pinned.
    await assertRejects(
      () => addProbePack({ ref: { type: "local", path: packDir }, at: AT }),
      "not in the operator-pinned key set",
    )
    // allow_unsigned must NOT excuse a present signature from an un-pinned author.
    await assertRejects(
      () => addProbePack({ ref: { type: "local", path: packDir }, allowUnsigned: true, at: AT }),
      "not in the operator-pinned key set",
    )
    details.push("E: a signed pack from an UN-pinned author → rejected; allow_unsigned no excuse ✓")

    // ── F — NO KEY LEAK ──────────────────────────────────────────────────────
    // The private key must never surface in any artifact the flow produces.
    const privateBody = privateKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
    const haystacks = [
      JSON.stringify(published),
      await readFile(join(packDir, "lodestar.probe-pack.json"), "utf8"),
      await readFile(lockfilePath, "utf8"),
    ]
    for (const h of haystacks) {
      if (privateBody.length > 0 && h.includes(privateBody))
        throw new Error("the author private key leaked into a produced artifact")
    }
    details.push("F: the author private key never surfaces in the manifest, result, or lockfile ✓")
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
console.log("probe: pack_publish_add_roundtrip")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
