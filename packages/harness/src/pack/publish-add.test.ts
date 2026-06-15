import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PackSourceRef,
  type ProbePackManifest,
  canonicalProbePackManifestHash,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import { addProbePack, lockfileSafeSource } from "./add.js"
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

  test("an install target inside the source skips the self-copy and preserves the source", async () => {
    // `pack add .` with the default `.lodestar/packs` install dir under the pack:
    // dest is a descendant of the source, so a copy would self-recurse and the rm
    // could delete the source. The source root is its own stable install instead.
    const dir = await writePack()
    await publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem, at: AT })
    const added = await addProbePack({
      ref: { type: "local", path: dir },
      authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      at: AT,
      installRoot: join(dir, ".lodestar/packs"),
    })
    // The install resolved to the source itself (no copy), and the source survives.
    expect(added.installedRoot).toBe(dir)
    await expect(readFile(join(dir, "probes/sample.ts"), "utf8")).resolves.toContain(
      "export const x",
    )
  })

  test("a symlinked local root is materialized as a real, stable install copy", async () => {
    // Resolution may hand back a symlinked root; copying it with dereference:false
    // would make the install a symlink back to the source, so later edits to the
    // source silently change the "installed" bytes. The install must be a real copy.
    const real = await writePack()
    await publishProbePack({ target: real, authorId: AUTHOR, privateKeyPem, at: AT })
    const link = join(tmpRoot, `link-${counter++}`)
    await symlink(real, link, "dir")
    const installRoot = join(tmpRoot, `install-sym-${counter++}`)

    const added = await addProbePack({
      ref: { type: "local", path: link },
      authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      at: AT,
      installRoot,
    })
    const installed = added.installedRoot ?? ""
    // The installed root is a real directory, NOT a symlink aliasing the source.
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    expect((await lstat(installed)).isDirectory()).toBe(true)
    // Editing the original source does not change the installed (stable) bytes.
    await writeFile(join(real, "probes/sample.ts"), "export const x = 999\n", "utf8")
    await expect(readFile(join(installed, "probes/sample.ts"), "utf8")).resolves.toContain(
      "export const x = 1",
    )
  })

  test("overlap is detected through a symlinked source root (no self-copy)", async () => {
    // The source is reached via a symlink, and the install dir is inside the
    // source's REAL tree. A lexical overlap check on the symlink path would miss
    // this and attempt to copy the resolved source into its own subtree; the real-
    // path comparison catches it and takes the in-place shortcut instead.
    const real = await writePack()
    await publishProbePack({ target: real, authorId: AUTHOR, privateKeyPem, at: AT })
    const link = join(tmpRoot, `link-overlap-${counter++}`)
    await symlink(real, link, "dir")

    const added = await addProbePack({
      ref: { type: "local", path: link },
      authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      at: AT,
      installRoot: join(real, ".lodestar/packs"), // inside the source's real tree
    })
    // No self-copy: the source root (the ref path) is returned, and it survives.
    expect(added.installedRoot).toBe(link)
    await expect(readFile(join(real, "probes/sample.ts"), "utf8")).resolves.toContain(
      "export const x = 1",
    )
  })

  test("a malformed lockfile fails before any install bytes are written", async () => {
    // The lockfile is recorded before the install, so a bad lockfile fails fast
    // and never leaves an orphan install with no matching audit record.
    const dir = await writePack()
    await publishProbePack({ target: dir, authorId: AUTHOR, privateKeyPem, at: AT })
    const badLock = join(tmpRoot, `bad-lock-${counter++}.json`)
    await writeFile(badLock, "{ not valid json", "utf8")
    const installRoot = join(tmpRoot, `install-orphan-${counter++}`)

    await expect(
      addProbePack({
        ref: { type: "local", path: dir },
        authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
        at: AT,
        installRoot,
        lockfilePath: badLock,
      }),
    ).rejects.toThrow(ProbePackError)
    // No orphan install: the install dir was never created.
    await expect(stat(installRoot)).rejects.toThrow()
  })
})

describe("lockfileSafeSource", () => {
  test("strips credentials from a git source URL before recording", () => {
    const ref: PackSourceRef = {
      type: "git",
      url: "https://alice:s3cret@example.com/acme/packs.git",
      commit: "a".repeat(40),
    }
    const safe = lockfileSafeSource(ref)
    expect(safe.type).toBe("git")
    if (safe.type === "git") {
      expect(safe.url).toBe("https://example.com/acme/packs.git")
      expect(safe.url).not.toContain("s3cret")
      expect(safe.commit).toBe(ref.commit) // the pin identity is preserved
    }
  })

  test("leaves a credential-free git URL and an scp-like remote unchanged", () => {
    const https: PackSourceRef = {
      type: "git",
      url: "https://example.com/acme/packs.git",
      commit: "b".repeat(40),
    }
    expect(lockfileSafeSource(https)).toEqual(https)
    // scp-like (git@host:path) is not a parseable URL — no userinfo secret to strip.
    const scp: PackSourceRef = {
      type: "git",
      url: "git@example.com:acme/packs.git",
      commit: "c".repeat(40),
    }
    expect(lockfileSafeSource(scp)).toEqual(scp)
  })

  test("preserves the SSH login user (not a secret, needed to fetch the remote)", () => {
    const ssh: PackSourceRef = {
      type: "git",
      url: "ssh://git@github.com/acme/packs.git",
      commit: "d".repeat(40),
    }
    // The lone `git@` username over ssh:// is the SSH login, kept for reproduction.
    expect(lockfileSafeSource(ssh)).toEqual(ssh)
    // But an ssh URL that still carries a password has it stripped.
    const sshPw: PackSourceRef = {
      type: "git",
      url: "ssh://git:s3cret@github.com/acme/packs.git",
      commit: "e".repeat(40),
    }
    const safe = lockfileSafeSource(sshPw)
    if (safe.type === "git") expect(safe.url).not.toContain("s3cret")
  })

  test("strips a lone token-as-username over https", () => {
    const tokenUser: PackSourceRef = {
      type: "git",
      url: "https://ghp_tok3n@github.com/acme/packs.git",
      commit: "f".repeat(40),
    }
    const safe = lockfileSafeSource(tokenUser)
    if (safe.type === "git") {
      expect(safe.url).not.toContain("ghp_tok3n")
      expect(safe.url).toBe("https://github.com/acme/packs.git")
    }
  })

  test("strips credentials from a credentialed npm registry URL", () => {
    const ref: PackSourceRef = {
      type: "npm",
      package: "@acme/pack",
      version: "1.0.0",
      integrity: "sha512-x",
      registry: "https://tok3n:@npm.example.com",
    }
    const safe = lockfileSafeSource(ref)
    if (safe.type === "npm") expect(safe.registry).not.toContain("tok3n")
  })

  test("leaves a local source unchanged", () => {
    const ref: PackSourceRef = { type: "local", path: "/some/pack" }
    expect(lockfileSafeSource(ref)).toEqual(ref)
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
