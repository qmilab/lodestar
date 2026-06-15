import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ProbePackManifest,
  canonicalProbePackManifestHash,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import { addProbePack } from "./add.js"
import { ProbePackError } from "./errors.js"
import { readPackLockfile, upsertPackLockEntry } from "./lockfile.js"
import { publishProbePack } from "./publish.js"
import { readPackTrustConfig } from "./trust-config.js"

const AT = "2026-01-01T00:00:00.000Z"
const AUTHOR = "test-author"
const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()

let tmpRoot: string
let counter = 0

const manifest = (overrides: Partial<ProbePackManifest> = {}): ProbePackManifest => ({
  name: "demo-pack",
  version: "0.1.0",
  spec_version: "1",
  source_type: "local",
  coverage_areas: ["demo"],
  invariants: ["demo_invariant"],
  probes: [{ name: "sample", file: "probes/sample.ts" }],
  ...overrides,
})

/** Write an unsigned pack (manifest + one probe) into a fresh temp dir. */
async function writePack(m: ProbePackManifest = manifest()): Promise<string> {
  const dir = join(tmpRoot, `pack-${counter++}`)
  await mkdir(join(dir, "probes"), { recursive: true })
  await writeFile(join(dir, "probes/sample.ts"), "export const x = 1\n", "utf8")
  await writeFile(join(dir, "lodestar.probe-pack.json"), `${JSON.stringify(m, null, 2)}\n`, "utf8")
  return dir
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lodestar-publish-add-"))
})
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe("publishProbePack", () => {
  test("signs a pack in place: author_id + content_digest + signature, and self-verifies", async () => {
    const dir = await writePack()
    const published = await publishProbePack({
      target: dir,
      authorId: AUTHOR,
      privateKeyPem,
      at: AT,
    })

    expect(published.manifest.author_id).toBe(AUTHOR)
    expect(published.manifest.signature?.algorithm).toBe("ed25519")
    expect(published.contentDigest.files).toHaveLength(1)
    // The derived public key matches the keypair (used for self-verify + the pin).
    expect(published.publicKeyPem.trim()).toBe(publicKeyPem.trim())

    const onDisk = JSON.parse(
      await readFile(join(dir, "lodestar.probe-pack.json"), "utf8"),
    ) as ProbePackManifest
    expect(onDisk.signature).toBeDefined()
    expect(onDisk.content_digest).toBeDefined()
    // manifestHash matches the canonical hash of what was written.
    expect(published.manifestHash).toBe(canonicalProbePackManifestHash(onDisk))
  })

  test("re-publishing strips the stale signature and re-signs (idempotent shape)", async () => {
    const dir = await writePack()
    const first = await publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem, at: AT })
    // Re-publish the now-signed pack: it must still produce a valid, self-verifying
    // manifest (the old signature is dropped before re-signing, not double-wrapped).
    const second = await publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem, at: AT })
    expect(second.manifest.signature).toBeDefined()
    // Same files + same author + same `at` ⇒ identical canonical hash.
    expect(second.manifestHash).toBe(first.manifestHash)
  })

  test("sourceType override rewrites the manifest's declared channel", async () => {
    const dir = await writePack()
    const published = await publishProbePack({
      target: dir,
      authorId: AUTHOR,
      privateKeyPem,
      at: AT,
      sourceType: "npm",
    })
    expect(published.manifest.source_type).toBe("npm")
  })

  test("rejects a non-Ed25519 private key before touching the manifest", async () => {
    const dir = await writePack()
    const { privateKey } = (await import("node:crypto")).generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    await expect(
      publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem: rsaPem, at: AT }),
    ).rejects.toThrow(ProbePackError)
    // The manifest must be untouched (still unsigned) after the rejection.
    const onDisk = JSON.parse(
      await readFile(join(dir, "lodestar.probe-pack.json"), "utf8"),
    ) as ProbePackManifest
    expect(onDisk.signature).toBeUndefined()
  })
})

describe("addProbePack (local source)", () => {
  test("resolves, verifies, installs (re-verified), and records the pin", async () => {
    const dir = await writePack()
    const published = await publishProbePack({
      target: dir,
      authorId: AUTHOR,
      privateKeyPem,
      at: AT,
    })
    const installRoot = join(tmpRoot, `install-${counter++}`)
    const lockfilePath = join(tmpRoot, `lock-${counter++}.json`)

    const added = await addProbePack({
      ref: { type: "local", path: dir },
      authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      at: AT,
      installRoot,
      lockfilePath,
    })

    expect(added.installedRoot).toBe(join(installRoot, "demo-pack"))
    // The installed probe file exists (the copy + re-verify succeeded).
    const installedProbe = await readFile(
      join(added.installedRoot ?? "", "probes/sample.ts"),
      "utf8",
    )
    expect(installedProbe).toContain("export const x")
    expect(added.lockEntry?.manifest_hash).toBe(canonicalProbePackManifestHash(published.manifest))
    expect(added.lockEntry?.author_id).toBe(AUTHOR)

    const lock = await readPackLockfile(lockfilePath)
    expect(lock.packs).toHaveLength(1)
    expect(lock.packs[0]?.name).toBe("demo-pack")
  })

  test("a signed pack from an un-pinned author is rejected (the trust root)", async () => {
    const dir = await writePack()
    await publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem, at: AT })
    await expect(addProbePack({ ref: { type: "local", path: dir }, at: AT })).rejects.toThrow(
      /not in the operator-pinned key set/,
    )
  })
})

describe("lockfile", () => {
  test("readPackLockfile returns an empty lockfile when the file is absent", async () => {
    const lock = await readPackLockfile(join(tmpRoot, "does-not-exist.json"))
    expect(lock.lockfile_version).toBe("1")
    expect(lock.packs).toEqual([])
  })

  test("upsert replaces the entry for a name and keeps the list sorted", async () => {
    const path = join(tmpRoot, `lock-upsert-${counter++}.json`)
    const base = {
      version: "1.0.0",
      source: { type: "local" as const, path: "/x" },
      manifest_hash: "a".repeat(64),
      added_at: AT,
    }
    await upsertPackLockEntry(path, { name: "zeta", ...base })
    await upsertPackLockEntry(path, { name: "alpha", ...base })
    // Re-add 'zeta' with a new hash — it replaces, not duplicates.
    await upsertPackLockEntry(path, { name: "zeta", ...base, manifest_hash: "b".repeat(64) })

    const lock = await readPackLockfile(path)
    expect(lock.packs.map((p) => p.name)).toEqual(["alpha", "zeta"])
    expect(lock.packs.find((p) => p.name === "zeta")?.manifest_hash).toBe("b".repeat(64))
  })
})

describe("trust-config", () => {
  test("absent default-path config resolves to an empty key set (secure default)", async () => {
    const cfg = await readPackTrustConfig(join(tmpRoot, "no-trust.json"))
    expect(cfg.author_keys).toEqual([])
  })

  test("an explicitly-required but absent config is an error, not a silent empty", async () => {
    await expect(
      readPackTrustConfig(join(tmpRoot, "no-trust.json"), { required: true }),
    ).rejects.toThrow(ProbePackError)
  })

  test("a malformed config is rejected", async () => {
    const path = join(tmpRoot, `bad-trust-${counter++}.json`)
    await writeFile(path, '{ "author_keys": "not-an-array" }', "utf8")
    await expect(readPackTrustConfig(path)).rejects.toThrow(ProbePackError)
  })
})
