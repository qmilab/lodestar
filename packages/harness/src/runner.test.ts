import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { isAbsolute, join } from "node:path"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { loadProbePack } from "./pack/loader.js"
import { formatProbeReport } from "./probe.js"
import { eventLogRecorder } from "./recorder.js"
import { type ProbeRunOutcome, runPack } from "./runner.js"
import { detectSandboxMechanism, macosAllowHostError, resolveBunPath } from "./sandbox/index.js"
import { buildBwrapSandbox } from "./sandbox/linux.js"

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

// process.env requires `delete`: assigning `undefined` coerces to the literal
// string "undefined", which a spawned probe would then read as a real value.
function unsetEnv(...keys: string[]): void {
  for (const key of keys) delete process.env[key]
}

describe("scoped probe environment (#114, ADR-0022)", () => {
  // A probe that echoes what it can see in its own env, then exits 0. The test
  // reads the captured stdout, not the verdict.
  const REPORTER = [
    'console.log("SECRET=" + (process.env.LODESTAR_RUNNER_TEST_SECRET ?? "<absent>"))',
    'console.log("ALLOWED=" + (process.env.LODESTAR_RUNNER_TEST_ALLOWED ?? "<absent>"))',
    'console.log("PATH=" + ((process.env.PATH?.length ?? 0) > 0 ? "<present>" : "<absent>"))',
    'console.log("HOME=" + (process.env.HOME ?? "<absent>"))',
    "process.exit(0)",
  ].join("\n")

  test("does NOT pass host process.env through to a spawned probe", async () => {
    process.env.LODESTAR_RUNNER_TEST_SECRET = "host-secret-must-not-leak"
    const dir = await makeFixturePack("fixture-env-deny", [["reporter.ts", REPORTER]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack)).outcomes[0]
      // The headline: the host secret is absent from the probe's environment.
      expect(out?.stdout).toContain("SECRET=<absent>")
      // PATH is still inherited so `bun` resolves; HOME is a fresh scoped dir.
      expect(out?.stdout).toContain("PATH=<present>")
      expect(out?.stdout).toContain("HOME=")
      expect(out?.stdout).not.toContain("host-secret-must-not-leak")
    } finally {
      await rm(dir, { recursive: true, force: true })
      unsetEnv("LODESTAR_RUNNER_TEST_SECRET")
    }
  })

  test("allowHostEnv forwards ONLY the named host var, not the rest", async () => {
    process.env.LODESTAR_RUNNER_TEST_SECRET = "host-secret-must-not-leak"
    process.env.LODESTAR_RUNNER_TEST_ALLOWED = "forwarded-yes"
    const dir = await makeFixturePack("fixture-env-allow", [["reporter.ts", REPORTER]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack, { allowHostEnv: ["LODESTAR_RUNNER_TEST_ALLOWED"] }))
        .outcomes[0]
      // Allowlisted var reaches the probe; the un-listed secret still does not.
      expect(out?.stdout).toContain("ALLOWED=forwarded-yes")
      expect(out?.stdout).toContain("SECRET=<absent>")
    } finally {
      await rm(dir, { recursive: true, force: true })
      unsetEnv("LODESTAR_RUNNER_TEST_SECRET", "LODESTAR_RUNNER_TEST_ALLOWED")
    }
  })

  test("a complete env override is used verbatim (host env never merged)", async () => {
    process.env.LODESTAR_RUNNER_TEST_SECRET = "host-secret-must-not-leak"
    const dir = await makeFixturePack("fixture-env-override", [["reporter.ts", REPORTER]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (
        await runPack(pack, {
          env: { PATH: process.env.PATH ?? "", LODESTAR_RUNNER_TEST_ALLOWED: "override-yes" },
        })
      ).outcomes[0]
      expect(out?.stdout).toContain("ALLOWED=override-yes")
      expect(out?.stdout).toContain("SECRET=<absent>")
    } finally {
      await rm(dir, { recursive: true, force: true })
      unsetEnv("LODESTAR_RUNNER_TEST_SECRET")
    }
  })

  test("a working-directory .env does NOT repopulate the probe env (--no-env-file)", async () => {
    // The secret lives ONLY in a .env in the probe's working directory — never in
    // the parent process.env. `bun run` auto-loads .env unless --no-env-file is
    // passed, which would smuggle it back in past the scoped env. The spawn passes
    // --no-env-file, so it must stay absent.
    const dir = await makeFixturePack("fixture-env-dotenv", [["reporter.ts", REPORTER]])
    await writeFile(join(dir, ".env"), "LODESTAR_RUNNER_TEST_SECRET=leaked-via-dotenv\n")
    const savedCwd = process.cwd()
    try {
      // The spawned probe inherits this cwd; bun would auto-load ./.env from it.
      process.chdir(dir)
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack)).outcomes[0]
      expect(out?.stdout).toContain("SECRET=<absent>")
      expect(out?.stdout).not.toContain("leaked-via-dotenv")
    } finally {
      process.chdir(savedCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("OS sandbox (#121, ADR-0023)", () => {
  test("`env` override and `sandbox` are mutually exclusive", async () => {
    const dir = await makeFixturePack("fixture-sbx-excl", [["ok.ts", "process.exit(0)\n"]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      await expect(
        runPack(pack, { env: { PATH: process.env.PATH ?? "" }, sandbox: {} }),
      ).rejects.toThrow(/mutually exclusive/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resolveBunPath honours the requested executable (absolute kept, else PATH)", () => {
    // The Codex fix: a sandboxed run must execute the SAME bun the unsandboxed
    // spawn would, not blindly process.execPath (which is `node` under Node, or
    // the wrong binary when the caller picks `bun-canary`).
    expect(resolveBunPath("/opt/custom/bun")).toBe("/opt/custom/bun")
    expect(isAbsolute(resolveBunPath("bun"))).toBe(true) // bare name → resolved on PATH
    // A relative path resolves against the cwd (like spawn), not PATH — never left relative.
    expect(isAbsolute(resolveBunPath("./bin/bun"))).toBe(true)
    // A bare name NOT on PATH is returned unresolved (so the spawn fails ENOENT
    // like unsandboxed) — never silently substituted with process.execPath.
    const missing = "lodestar-definitely-not-a-real-bun-xyz"
    expect(resolveBunPath(missing)).toBe(missing)
  })

  test("bwrap isolates the network unless a host is allow-listed (then shares it)", () => {
    // Arg construction only — does not run bwrap, so it is platform-agnostic.
    const policy = { readRoots: ["/tmp/pack"], writeRoot: "/tmp/scratch" }
    const isolated = buildBwrapSandbox({ ...policy, allowHosts: [] }).wrap("bun", ["run", "x.ts"])
    const shared = buildBwrapSandbox({ ...policy, allowHosts: ["example.com:443"] }).wrap("bun", [
      "run",
      "x.ts",
    ])
    expect(isolated.args).toContain("--unshare-net") // loopback-only isolation
    expect(shared.args).not.toContain("--unshare-net") // host net shared for the allow-host
    // Read confinement: bind specific runtime dirs, never the broad /usr or /opt
    // prefixes (which hold app checkouts / secrets on many hosts — Codex P1).
    expect(isolated.args).toContain("/usr/lib")
    expect(isolated.args).not.toContain("/usr")
    expect(isolated.args).not.toContain("/opt")
  })

  test("macosAllowHostError requires a port (SBPL scopes egress by port, not host)", () => {
    // The Codex P1 fix: a portless host can't be filtered, so it must be
    // reported (caller fails closed), never silently widened to all-egress.
    expect(macosAllowHostError(["10.0.0.5:5432", "192.168.1.9:443"])).toBeNull()
    expect(macosAllowHostError(["db.example:5432"])).toBeNull() // port-scoped to *:5432
    expect(macosAllowHostError(["10.0.0.5"])).toContain("--allow-host")
    expect(macosAllowHostError(["db.example.com"])).toContain("--allow-host")
  })

  const mechanism = detectSandboxMechanism()
  // The behavioural tests need a real mechanism (sandbox-exec on macOS,
  // bubblewrap on Linux CI); skip loudly elsewhere rather than fail.
  const sandboxTest = mechanism ? test : test.skip
  // The fail-closed test is the mirror: it runs ONLY where no mechanism exists.
  const noMechTest = mechanism ? test.skip : test

  noMechTest("fails closed when no sandbox mechanism is available", async () => {
    const dir = await makeFixturePack("fixture-sbx-failclosed", [["ok.ts", "process.exit(0)\n"]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      await expect(runPack(pack, { sandbox: {} })).rejects.toThrow(/no mechanism is available/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  sandboxTest("runs a probe under a confined env (HOME/TMPDIR in a scratch)", async () => {
    const report = [
      'console.log("HOME=" + process.env.HOME)',
      'console.log("TMPDIR=" + process.env.TMPDIR)',
      "process.exit(0)",
    ].join("\n")
    const dir = await makeFixturePack("fixture-sbx-env", [["home.ts", report]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack, { sandbox: {} })).outcomes[0]
      expect(out?.passed).toBe(true)
      // HOME + TMPDIR live in the per-run scratch, not the operator's real home.
      expect(out?.stdout).toContain("lodestar-probe-run-")
      expect(out?.stdout).not.toContain(`HOME=${homedir()}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // The Codex round-2 P1: `os.homedir()` follows `$HOME`, so denying only that
  // would leave the REAL home readable when the caller runs with a scoped/overridden
  // HOME. macOS denies `/Users` independently of `$HOME`; pin that here.
  const macosTest = mechanism === "sandbox-exec" ? test : test.skip
  macosTest("denies the REAL macOS home even when $HOME is overridden", async () => {
    const realHome = join("/Users", userInfo().username)
    const secretDir = await mkdtemp(join(realHome, ".lodestar-sbx-real-"))
    const secretFile = join(secretDir, "s.txt")
    await writeFile(secretFile, "must-not-be-readable")
    const probe = [
      'import { readFileSync } from "node:fs"',
      `try { readFileSync(${JSON.stringify(secretFile)}, "utf8"); console.log("READ=LEAKED") }`,
      'catch { console.log("READ=DENIED") }',
      "process.exit(0)",
    ].join("\n")
    const dir = await makeFixturePack("fixture-sbx-realhome", [["read.ts", probe]])
    const savedHome = process.env.HOME
    try {
      // Point HOME at a throwaway dir — the OLD deny-homedir() would target THIS,
      // leaving the real home open. The /Users deny must close it regardless.
      process.env.HOME = await mkdtemp(join(tmpdir(), "fake-home-"))
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack, { sandbox: {} })).outcomes[0]
      expect(out?.stdout).toContain("READ=DENIED")
      expect(out?.stdout).not.toContain("READ=LEAKED")
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome
      await rm(dir, { recursive: true, force: true })
      await rm(secretDir, { recursive: true, force: true })
    }
  })

  sandboxTest("denies reading a secret under the operator's home directory", async () => {
    const secretDir = await mkdtemp(join(homedir(), ".lodestar-sbx-test-"))
    const secretFile = join(secretDir, "secret.txt")
    await writeFile(secretFile, "must-not-be-readable-by-a-probe")
    const probe = [
      'import { readFileSync } from "node:fs"',
      `try { readFileSync(${JSON.stringify(secretFile)}, "utf8"); console.log("READ=LEAKED") }`,
      'catch (e) { console.log("READ=DENIED:" + (e instanceof Error ? (e as any).code : e)) }',
      "process.exit(0)",
    ].join("\n")
    const dir = await makeFixturePack("fixture-sbx-read", [["read.ts", probe]])
    try {
      const pack = await loadProbePack(dir, { allowUnsigned: true })
      const out = (await runPack(pack, { sandbox: {} })).outcomes[0]
      expect(out?.stdout).toContain("READ=DENIED")
      expect(out?.stdout).not.toContain("READ=LEAKED")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(secretDir, { recursive: true, force: true })
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
