import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_MANIFEST_FILENAME,
  type PackContentDigest,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { ProbePackError, loadProbePack } from "./loader.js"

let tmpRoot: string
let packCounter = 0

const validManifest = (overrides: Partial<ProbePackManifest> = {}): Record<string, unknown> => ({
  name: "test-pack",
  version: "0.1.0",
  spec_version: "1",
  source_type: "local",
  coverage_areas: ["memory_firewall"],
  invariants: ["no_self_promotion"],
  probes: [{ name: "probe-one", file: "probes/probe-one.ts" }],
  ...overrides,
})

/**
 * Materialise a pack directory. `manifest` is written verbatim (a string
 * lets us test malformed JSON; an object is JSON-stringified). `probeFiles`
 * are created relative to the pack root so file-existence checks pass.
 */
async function makePack(opts: {
  manifest: unknown
  probeFiles?: string[]
}): Promise<string> {
  const dir = join(tmpRoot, `pack-${packCounter++}`)
  await mkdir(dir, { recursive: true })
  for (const rel of opts.probeFiles ?? []) {
    const full = join(dir, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, "// dummy probe\n")
  }
  const body = typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest)
  await writeFile(join(dir, PROBE_PACK_MANIFEST_FILENAME), body)
  return dir
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lodestar-pack-test-"))
})

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("loadProbePack", () => {
  test("loads a valid local pack and resolves probe files to absolute paths", async () => {
    const dir = await makePack({
      manifest: validManifest(),
      probeFiles: ["probes/probe-one.ts"],
    })

    const pack = await loadProbePack(dir, { allowUnsigned: true })

    expect(pack.manifest.name).toBe("test-pack")
    expect(pack.root).toBe(dir)
    expect(pack.probes).toHaveLength(1)
    expect(pack.probes[0]?.name).toBe("probe-one")
    expect(pack.probes[0]?.file).toBe("probes/probe-one.ts")
    expect(pack.probes[0]?.path).toBe(join(dir, "probes/probe-one.ts"))
  })

  test("accepts the manifest file path directly, not just the directory", async () => {
    const dir = await makePack({
      manifest: validManifest(),
      probeFiles: ["probes/probe-one.ts"],
    })

    const pack = await loadProbePack(join(dir, PROBE_PACK_MANIFEST_FILENAME), {
      allowUnsigned: true,
    })
    expect(pack.manifest.name).toBe("test-pack")
  })

  test("throws when the target path does not exist", async () => {
    await expect(
      loadProbePack(join(tmpRoot, "nope-does-not-exist"), { allowUnsigned: true }),
    ).rejects.toBeInstanceOf(ProbePackError)
  })

  test("throws when the directory has no manifest", async () => {
    const dir = join(tmpRoot, "empty-dir")
    await mkdir(dir, { recursive: true })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /No lodestar\.probe-pack\.json/,
    )
  })

  test("throws on malformed JSON", async () => {
    const dir = await makePack({ manifest: "{ not valid json", probeFiles: [] })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/not valid JSON/)
  })

  test("throws on a schema-invalid manifest (missing required field)", async () => {
    const m = validManifest()
    m.probes = undefined
    const dir = await makePack({ manifest: m })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/failed validation/)
  })

  test("throws on a non-kebab-case pack name", async () => {
    const dir = await makePack({ manifest: validManifest({ name: "Test_Pack" }) })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/failed validation/)
  })

  test("rejects an unknown spec_version", async () => {
    const dir = await makePack({
      manifest: validManifest({ spec_version: "2" as ProbePackManifest["spec_version"] }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/failed validation/)
  })

  test("loads a local directory regardless of declared source_type (#86: bytes are present)", async () => {
    // Once the bytes are on disk, source_type is advisory — the npm/git resolvers
    // (loadProbePackFromSource) fetch to a confined dir, then this loads it. So a
    // directory whose manifest declares npm/git loads directly.
    for (const source_type of ["npm", "git"] as const) {
      const dir = await makePack({
        manifest: validManifest({ source_type }),
        probeFiles: ["probes/probe-one.ts"],
      })
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      expect(pack.manifest.source_type).toBe(source_type)
      expect(pack.probes).toHaveLength(1)
    }
  })

  test("throws when a declared probe file is missing", async () => {
    const dir = await makePack({ manifest: validManifest(), probeFiles: [] })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/file not found/)
  })

  test("rejects a probe file that escapes the pack root", async () => {
    const dir = await makePack({
      manifest: validManifest({
        probes: [{ name: "escaper", file: "../../../../etc/passwd" }],
      }),
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /outside the pack root/,
    )
  })

  test("rejects a probe file that escapes the pack root via a symlink", async () => {
    // A real file outside the pack root, then a probe symlink pointing
    // at it — the lexical path stays inside the pack, but realpath
    // resolves outside. This is the case a plain stat() would miss.
    const outsideSecret = join(tmpRoot, `outside-secret-${packCounter}.ts`)
    await writeFile(outsideSecret, "// pretend this is /etc/passwd\n")
    const dir = await makePack({
      manifest: validManifest({ probes: [{ name: "escaper", file: "probes/escaper.ts" }] }),
    })
    await mkdir(join(dir, "probes"), { recursive: true })
    await symlink(outsideSecret, join(dir, "probes/escaper.ts"))

    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /outside the pack root via a symlink/,
    )
  })

  test("accepts an in-pack symlink (real target stays inside the root)", async () => {
    const dir = await makePack({
      manifest: validManifest({ probes: [{ name: "linked", file: "probes/linked.ts" }] }),
      probeFiles: ["probes/real.ts"],
    })
    await symlink(join(dir, "probes/real.ts"), join(dir, "probes/linked.ts"))

    const pack = await loadProbePack(dir, { allowUnsigned: true })
    expect(pack.probes[0]?.name).toBe("linked")
  })

  test("accepts an in-pack path whose segment merely starts with dots", async () => {
    const dir = await makePack({
      manifest: validManifest({ probes: [{ name: "dotted", file: "..fixtures/probe.ts" }] }),
      probeFiles: ["..fixtures/probe.ts"],
    })
    const pack = await loadProbePack(dir, { allowUnsigned: true })
    expect(pack.probes[0]?.name).toBe("dotted")
    expect(pack.probes[0]?.path).toBe(join(dir, "..fixtures/probe.ts"))
  })

  test("rejects an absolute probe file path", async () => {
    const dir = await makePack({
      manifest: validManifest({ probes: [{ name: "abs", file: "/var/tmp/probe.ts" }] }),
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/failed validation/)
  })

  test("rejects a non-regular file (FIFO) at a probe path", async () => {
    const dir = await makePack({
      manifest: validManifest({ probes: [{ name: "fifo", file: "probes/fifo.ts" }] }),
    })
    await mkdir(join(dir, "probes"), { recursive: true })
    const made = Bun.spawnSync(["mkfifo", join(dir, "probes/fifo.ts")])
    if (!made.success) return // mkfifo unavailable on this platform; nothing to assert

    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/not a regular file/)
  })

  test("rejects duplicate probe names", async () => {
    const dir = await makePack({
      manifest: validManifest({
        probes: [
          { name: "dup", file: "probes/a.ts" },
          { name: "dup", file: "probes/b.ts" },
        ],
      }),
      probeFiles: ["probes/a.ts", "probes/b.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/more than once/)
  })

  test("resolves to an empty sentinels array when the manifest omits the field", async () => {
    const dir = await makePack({
      manifest: validManifest(),
      probeFiles: ["probes/probe-one.ts"],
    })
    const pack = await loadProbePack(dir, { allowUnsigned: true })
    // `sentinels` is an optional manifest field; absent means the pack ships
    // none, which the loader surfaces as an empty resolved array.
    expect(pack.sentinels).toEqual([])
  })

  test("resolves declared sentinels to first-party factories, in manifest order", async () => {
    const dir = await makePack({
      manifest: validManifest({
        sentinels: [{ id: "low-confidence-action" }, { id: "anomalous-tool-sequence" }],
      }),
      probeFiles: ["probes/probe-one.ts"],
    })
    const pack = await loadProbePack(dir, { allowUnsigned: true })

    expect(pack.sentinels.map((s) => s.id)).toEqual([
      "low-confidence-action",
      "anomalous-tool-sequence",
    ])
    // The resolved factory constructs the matching sentinel; load itself
    // never constructs one (it resolves the factory only), so this is the
    // host's call exercised here.
    const instance = pack.sentinels[0]?.create()
    expect(instance?.name).toBe("low-confidence-action")
  })

  test("rejects an unknown sentinel id with a clear error", async () => {
    const dir = await makePack({
      manifest: validManifest({ sentinels: [{ id: "does-not-exist" }] }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /unknown sentinel id 'does-not-exist'/,
    )
  })

  // `constructor` passes the kebab-case id regex and, on a plain-object
  // registry, would resolve to the inherited Object.prototype.constructor —
  // slipping past the unknown-id check. The loader must reject it like any
  // other unknown id rather than producing a bogus non-Sentinel.
  test("rejects a prototype-polluting sentinel id ('constructor')", async () => {
    const dir = await makePack({
      manifest: validManifest({ sentinels: [{ id: "constructor" }] }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /unknown sentinel id 'constructor'/,
    )
  })

  test("rejects duplicate sentinel ids", async () => {
    const dir = await makePack({
      manifest: validManifest({
        sentinels: [{ id: "low-confidence-action" }, { id: "low-confidence-action" }],
      }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(
      /sentinel id 'low-confidence-action' more than once/,
    )
  })

  test("rejects a non-kebab-case sentinel id at schema validation", async () => {
    const dir = await makePack({
      manifest: validManifest({ sentinels: [{ id: "Not_Kebab" }] }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { allowUnsigned: true })).rejects.toThrow(/failed validation/)
  })
})

// Verify-on-load (#88, ADR-0017). `makePack` writes each probe file with the
// fixed body below, so a content digest over it is reproducible. The three
// probes in packs/lodestar-core exercise this end-to-end; these pin the loader's
// own behaviour at the unit level.
const DUMMY_PROBE_BODY = "// dummy probe\n"
const AUTHOR = "pack-author"

function digestFor(paths: string[]): PackContentDigest {
  const files = paths
    .map((p) => ({ path: p, sha256: createHash("sha256").update(DUMMY_PROBE_BODY).digest("hex") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { algorithm: "sha256", files }
}

function signManifest(
  privateKeyPem: string,
  overrides: Partial<ProbePackManifest> = {},
): ProbePackManifest {
  const unsigned = {
    ...(validManifest() as unknown as ProbePackManifest),
    author_id: AUTHOR,
    content_digest: digestFor(["probes/probe-one.ts"]),
    ...overrides,
  }
  return {
    ...unsigned,
    signature: signProbePackManifest(unsigned, {
      authorId: AUTHOR,
      privateKeyPem,
      at: "2026-01-01T00:00:00.000Z",
    }),
  }
}

describe("loadProbePack verify-on-load", () => {
  test("loads a manifest signed by a pinned author", async () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const dir = await makePack({
      manifest: signManifest(privateKeyPem),
      probeFiles: ["probes/probe-one.ts"],
    })
    const pack = await loadProbePack(dir, {
      authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
    })
    expect(pack.manifest.name).toBe("test-pack")
  })

  test("rejects an unsigned manifest with no allowUnsigned", async () => {
    const dir = await makePack({ manifest: validManifest(), probeFiles: ["probes/probe-one.ts"] })
    await expect(loadProbePack(dir, { authorizedAuthorKeys: [] })).rejects.toThrow(/is unsigned/)
  })

  test("rejects a signature from an un-pinned author", async () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const dir = await makePack({
      manifest: signManifest(privateKeyPem),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir, { authorizedAuthorKeys: [] })).rejects.toThrow(
      /not in the operator-pinned/,
    )
  })

  test("rejects swapped probe bytes under a still-valid signature", async () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const dir = await makePack({
      manifest: signManifest(privateKeyPem),
      probeFiles: ["probes/probe-one.ts"],
    })
    // Overwrite the probe file's bytes without touching the (still-valid) manifest.
    await writeFile(join(dir, "probes/probe-one.ts"), "// tampered\n")
    await expect(
      loadProbePack(dir, {
        authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      }),
    ).rejects.toThrow(/has been modified since it was signed/)
  })

  test("rejects a signed manifest with no content_digest", async () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const unsigned = { ...(validManifest() as unknown as ProbePackManifest), author_id: AUTHOR }
    const manifest: ProbePackManifest = {
      ...unsigned,
      signature: signProbePackManifest(unsigned, {
        authorId: AUTHOR,
        privateKeyPem,
        at: "2026-01-01T00:00:00.000Z",
      }),
    }
    const dir = await makePack({ manifest, probeFiles: ["probes/probe-one.ts"] })
    await expect(
      loadProbePack(dir, {
        authorizedAuthorKeys: [{ actor_id: AUTHOR, public_key: publicKeyPem }],
      }),
    ).rejects.toThrow(/no content_digest/)
  })
})
