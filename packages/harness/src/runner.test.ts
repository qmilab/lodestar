import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { loadProbePack } from "./pack/loader.js"
import { formatProbeReport } from "./probe.js"
import { eventLogRecorder } from "./recorder.js"
import { type ProbeRunOutcome, runPack } from "./runner.js"

/**
 * Build a throwaway local pack on disk with the given probe sources.
 * Each entry is `[fileName, body]`; the body is a standalone bun script.
 */
async function makeFixturePack(
  name: string,
  probes: Array<[file: string, body: string]>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-pack-"))
  const manifest = {
    name,
    version: "0.0.0",
    spec_version: "1",
    source_type: "local",
    coverage_areas: ["test"],
    invariants: ["test"],
    probes: probes.map(([file]) => ({ name: file.replace(/\.ts$/, ""), file })),
  }
  await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
  for (const [file, body] of probes) {
    await writeFile(join(dir, file), body)
  }
  return dir
}

describe("runPack", () => {
  test("runs every probe and aggregates pass/fail by exit code", async () => {
    const dir = await makeFixturePack("fixture-mixed", [
      ["ok.ts", "console.log('probe ok'); process.exit(0)\n"],
      ["bad.ts", "console.log('probe boom'); process.exit(2)\n"],
    ])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const seen: ProbeRunOutcome[] = []
      const result = await runPack(pack, { onResult: (o) => seen.push(o) })

      expect(result.total).toBe(2)
      expect(result.passed).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.ok).toBe(false)
      expect(seen).toHaveLength(2)

      const ok = result.outcomes.find((o) => o.name === "ok")
      const bad = result.outcomes.find((o) => o.name === "bad")
      expect(ok?.passed).toBe(true)
      expect(ok?.exit_code).toBe(0)
      expect(ok?.stdout).toContain("probe ok")
      expect(bad?.passed).toBe(false)
      expect(bad?.exit_code).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("caps captured output so a runaway probe cannot exhaust memory", async () => {
    // Print well past the 256 KiB per-stream cap.
    const dir = await makeFixturePack("fixture-loud", [
      ["loud.ts", "console.log('x'.repeat(400 * 1024)); process.exit(0)\n"],
    ])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const result = await runPack(pack)
      const loud = result.outcomes[0]
      expect(loud?.passed).toBe(true)
      // Bounded: cap (256 KiB) + the truncation marker, not the full 400 KiB.
      expect(loud?.stdout.length).toBeLessThan(300 * 1024)
      expect(loud?.stdout).toContain("output truncated")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a failing probe does not abort the rest of the run", async () => {
    const dir = await makeFixturePack("fixture-order", [
      ["a.ts", "process.exit(1)\n"],
      ["b.ts", "process.exit(0)\n"],
    ])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const result = await runPack(pack)
      expect(result.outcomes.map((o) => o.name)).toEqual(["a", "b"])
      expect(result.passed).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records each run as a synthetic observation in the event log", async () => {
    _resetEventLogStateForTests()
    const dir = await makeFixturePack("fixture-record", [
      ["ok.ts", "process.exit(0)\n"],
      ["bad.ts", "process.exit(1)\n"],
    ])
    const logRoot = await mkdtemp(join(tmpdir(), "lodestar-log-"))
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const record = eventLogRecorder({
        root: logRoot,
        project_id: "proj-test",
        session_id: "sess-test",
        actor_id: "actor-test",
      })
      await runPack(pack, { record })

      const events = await new EventLogReader(logRoot).readSession("proj-test", "sess-test")
      const recorded = events.filter((e) => e.type === "observation.recorded")
      expect(recorded).toHaveLength(2)
      for (const e of recorded) {
        const obs = e.payload as { schema: string; trust: string; payload: { passed: boolean } }
        expect(obs.schema).toBe("harness.probe_run@1")
        expect(obs.trust).toBe("synthetic")
        expect(typeof obs.payload.passed).toBe("boolean")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(logRoot, { recursive: true, force: true })
    }
  })
})

describe("formatProbeReport", () => {
  test("renders the canonical banner the first-party probes print", () => {
    const out = formatProbeReport("demo-probe", { passed: true, details: ["one", "two"] })
    expect(out).toContain("probe: demo-probe")
    expect(out).toContain("status: PASS ✓")
    expect(out).toContain("  one")
    expect(out).toContain("  two")
  })

  test("marks a failed result", () => {
    const out = formatProbeReport("demo-probe", { passed: false, details: [] })
    expect(out).toContain("status: FAIL ✗")
  })
})
