import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { loadProbePack } from "./loader.js"

// The first non-core pack lives at the repo root under
// packs/coding-agent-safety. From this test file (packages/harness/src/pack)
// that is four levels up.
const PACK_DIR = join(import.meta.dir, "../../../../packs/coding-agent-safety")

describe("packs/coding-agent-safety (first non-core pack)", () => {
  test("loads cleanly through the v0 loader", async () => {
    const pack = await loadProbePack(PACK_DIR)

    expect(pack.manifest.name).toBe("coding-agent-safety")
    expect(pack.manifest.source_type).toBe("local")
    expect(pack.manifest.spec_version).toBe("1")
    expect(pack.probes.length).toBeGreaterThan(0)
  })

  // The folded-in sentinels: the manifest declares all three first-party
  // sentinels by id, and each resolves to a factory whose instance reports
  // the same name.
  test("declares and resolves the three first-party sentinels", async () => {
    const pack = await loadProbePack(PACK_DIR)

    expect(pack.sentinels.map((s) => s.id).sort()).toEqual([
      "anomalous-tool-sequence",
      "low-confidence-action",
      "suspicious-memory-origin",
    ])
    for (const s of pack.sentinels) {
      expect(s.create().name).toBe(s.id)
    }
  })

  // Drift guard: the manifest and the probes/ directory must stay in sync.
  // If someone adds a probe file but forgets the manifest entry (or removes
  // one), this fails — the manifest is the spec, not a stale snapshot.
  test("declares exactly the .ts files present in probes/", async () => {
    const pack = await loadProbePack(PACK_DIR)

    const onDisk = (await readdir(join(PACK_DIR, "probes"))).filter((f) => f.endsWith(".ts")).sort()
    const declared = pack.probes.map((p) => p.file.replace(/^probes\//, "")).sort()

    expect(declared).toEqual(onDisk)
  })
})
