import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROBE_PACK_MANIFEST_FILENAME, type ProbePackManifest } from "@qmilab/lodestar-core"
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

    const pack = await loadProbePack(dir)

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

    const pack = await loadProbePack(join(dir, PROBE_PACK_MANIFEST_FILENAME))
    expect(pack.manifest.name).toBe("test-pack")
  })

  test("throws when the target path does not exist", async () => {
    await expect(loadProbePack(join(tmpRoot, "nope-does-not-exist"))).rejects.toBeInstanceOf(
      ProbePackError,
    )
  })

  test("throws when the directory has no manifest", async () => {
    const dir = join(tmpRoot, "empty-dir")
    await mkdir(dir, { recursive: true })
    await expect(loadProbePack(dir)).rejects.toThrow(/No lodestar\.probe-pack\.json/)
  })

  test("throws on malformed JSON", async () => {
    const dir = await makePack({ manifest: "{ not valid json", probeFiles: [] })
    await expect(loadProbePack(dir)).rejects.toThrow(/not valid JSON/)
  })

  test("throws on a schema-invalid manifest (missing required field)", async () => {
    const m = validManifest()
    m.probes = undefined
    const dir = await makePack({ manifest: m })
    await expect(loadProbePack(dir)).rejects.toThrow(/failed validation/)
  })

  test("throws on a non-kebab-case pack name", async () => {
    const dir = await makePack({ manifest: validManifest({ name: "Test_Pack" }) })
    await expect(loadProbePack(dir)).rejects.toThrow(/failed validation/)
  })

  test("rejects an unknown spec_version", async () => {
    const dir = await makePack({
      manifest: validManifest({ spec_version: "2" as ProbePackManifest["spec_version"] }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir)).rejects.toThrow(/failed validation/)
  })

  test("rejects source_type npm in v0 with a clear error", async () => {
    const dir = await makePack({
      manifest: validManifest({ source_type: "npm" }),
      probeFiles: ["probes/probe-one.ts"],
    })
    await expect(loadProbePack(dir)).rejects.toThrow(/source_type "npm"/)
  })

  test("throws when a declared probe file is missing", async () => {
    const dir = await makePack({ manifest: validManifest(), probeFiles: [] })
    await expect(loadProbePack(dir)).rejects.toThrow(/file not found/)
  })

  test("rejects a probe file that escapes the pack root", async () => {
    const dir = await makePack({
      manifest: validManifest({
        probes: [{ name: "escaper", file: "../../../../etc/passwd" }],
      }),
    })
    await expect(loadProbePack(dir)).rejects.toThrow(/outside the pack root/)
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
    await expect(loadProbePack(dir)).rejects.toThrow(/more than once/)
  })
})
