import { describe, expect, test } from "bun:test"
import { FIRST_PARTY_SENTINELS } from "./registry.js"

describe("FIRST_PARTY_SENTINELS", () => {
  test("ships exactly the three first-party sentinels", () => {
    expect(Object.keys(FIRST_PARTY_SENTINELS).sort()).toEqual([
      "anomalous-tool-sequence",
      "low-confidence-action",
      "suspicious-memory-origin",
    ])
  })

  // The id a pack manifest references, the registry key, and the
  // `sentinel_name` stamped on every alert must be the same string. Keying
  // the registry by anything other than the sentinel's own `name` would let
  // them drift, so assert they match for every entry.
  test("each registry key equals the constructed sentinel's name", () => {
    for (const [id, create] of Object.entries(FIRST_PARTY_SENTINELS)) {
      expect(create().name).toBe(id)
    }
  })

  // Sentinels are stateful (per-session accumulators), so the registry must
  // hand out a fresh instance per call — never a shared singleton that would
  // bleed state across runners.
  test("returns a fresh instance on each call", () => {
    const create = FIRST_PARTY_SENTINELS["low-confidence-action"]
    expect(create).toBeDefined()
    expect(create?.()).not.toBe(create?.())
  })
})
