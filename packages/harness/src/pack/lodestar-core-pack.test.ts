import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { loadProbePack } from "./loader.js"

// The first-party pack lives at the repo root under packs/lodestar-core.
// From this test file (packages/harness/src/pack) that is four levels up.
const PACK_DIR = join(import.meta.dir, "../../../../packs/lodestar-core")

describe("packs/lodestar-core (first-party pack)", () => {
  test("loads cleanly through the v0 loader", async () => {
    const pack = await loadProbePack(PACK_DIR, { allowUnsigned: true })

    expect(pack.manifest.name).toBe("lodestar-core")
    expect(pack.manifest.source_type).toBe("local")
    expect(pack.manifest.spec_version).toBe("1")
    expect(pack.probes.length).toBeGreaterThan(0)
  })

  // Drift guard: the manifest and the probes/ directory must stay in sync.
  // If someone adds a probe file but forgets the manifest entry (or removes
  // one), this fails — the manifest is the spec, not a stale snapshot.
  test("declares exactly the .ts files present in probes/", async () => {
    const pack = await loadProbePack(PACK_DIR, { allowUnsigned: true })

    const onDisk = (await readdir(join(PACK_DIR, "probes"))).filter((f) => f.endsWith(".ts")).sort()
    const declared = pack.probes.map((p) => p.file.replace(/^probes\//, "")).sort()

    expect(declared).toEqual(onDisk)
  })
})
