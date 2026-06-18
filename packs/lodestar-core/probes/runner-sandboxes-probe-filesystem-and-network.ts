#!/usr/bin/env bun
/**
 * Probe: runner_sandboxes_probe_filesystem_and_network
 *
 * Locks the step-2 execution boundary (#121, ADR-0023). Step 1 (ADR-0022,
 * `runner-denies-host-env-to-probe`) denied a probe the host `process.env`; it
 * did NOT contain a probe's filesystem or network reach — a probe was still a
 * subprocess that could read any file the runner's uid can read (`~/.ssh`,
 * `~/.aws`, …) and open arbitrary outbound sockets to exfiltrate it. This probe
 * pins the OS sandbox that closes that: the runner spawns each probe inside
 * `sandbox-exec` (macOS) / `bubblewrap` (Linux) confining its filesystem reads,
 * its writes, and its outbound network.
 *
 * It drives the REAL `runPack` with a sandbox policy over a throwaway fixture
 * pack whose probe is an "escape attempt", and pins, with positive controls:
 *
 *   1. Filesystem read DENIED. A "host secret" planted UNDER the operator's real
 *      home directory (where credential stores live) is unreadable from the
 *      sandboxed probe. The headline: the consumer's files are not the probe's.
 *   2. Filesystem write DENIED. A write OUTSIDE the per-run scratch (into the
 *      read-only pack dir) fails — a probe cannot tamper with the host fs.
 *   3. Network egress DENIED. An outbound connection to a genuine REMOTE host
 *      fails — a probe cannot reach the network to exfiltrate or pull a payload.
 *      This is asserted only when an unsandboxed baseline first proves the host
 *      itself can reach that remote (so it is never a false pass when the run
 *      simply has no internet).
 *   4. Positive controls. The probe CAN read its own pack directory and CAN
 *      write its per-run scratch — proving the sandbox is scoping execution, not
 *      merely breaking it.
 *
 * This is an OS-primitive governance boundary, not kernel-grade containment
 * (sandbox-exec is Apple-deprecated; bwrap relies on unprivileged user
 * namespaces). It is gated like the Postgres-backed probes: when no sandbox
 * mechanism is available on this host it SKIPS LOUDLY (exit 0 + banner) rather
 * than failing, so CI on Linux (with bubblewrap) exercises it for real while a
 * mechanism-less box does not spuriously fail. Probes are spec, not scaffolding:
 * if this regresses, a verified-but-untrusted pack's probe could read the
 * consumer's filesystem or beacon out the moment it runs.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { homedir, tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import {
  type ProbeRunOutcome,
  detectSandboxMechanism,
  loadProbePack,
  runPack,
} from "@qmilab/lodestar-harness"

interface ProbeResult {
  passed: boolean
  details: string
  /** True when the probe could not run here and skipped loudly (exit 0). */
  skipped?: boolean
}

/** Print the SKIP banner and return a passing-but-skipped result. */
function skip(reason: string): ProbeResult {
  console.log("─".repeat(72))
  console.log("probe: runner_sandboxes_probe_filesystem_and_network")
  console.log("─".repeat(72))
  console.log(`status: SKIP (${reason})`)
  console.log(
    "The OS-sandbox boundary cannot be exercised here. CI runs this for real on\n" +
      "Linux with bubblewrap installed (and unprivileged user namespaces enabled).",
  )
  console.log("─".repeat(72))
  return { passed: true, details: `skipped: ${reason}`, skipped: true }
}

// A genuine REMOTE the egress test targets. Connecting here is blocked by the
// sandbox; the unsandboxed baseline below proves it would otherwise succeed.
const REMOTE_HOST = "8.8.8.8"
const REMOTE_PORT = 53

/** Attempt a TCP connect; resolve to a short status string, never throwing. */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((res) => {
    const s = net.connect({ host, port, timeout: 2500 })
    s.on("connect", () => {
      s.destroy()
      res("CONNECTED")
    })
    s.on("timeout", () => {
      s.destroy()
      res("TIMEOUT")
    })
    s.on("error", (e: NodeJS.ErrnoException) => res(`ERR:${e.code}`))
  })
}

// The fixture probe: a standalone bun script using only node builtins (so it
// needs nothing under the repo node_modules — the pack dir is read-root enough).
// It reports what it can see/do, then always exits 0; the outer probe reads the
// captured stdout to decide pass/fail. `__SECRET__` is substituted at build time.
function leakDetectorSource(secretPath: string): string {
  return `
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import net from "node:net"
function tryRead(p){try{readFileSync(p,"utf8");return "READ_OK"}catch(e){return "DENIED:"+e.code}}
function tryWrite(p){try{writeFileSync(p,"x");return "WROTE"}catch(e){return "DENIED:"+e.code}}
function connect(host,port){return new Promise((res)=>{const s=net.connect({host,port,timeout:2500});s.on("connect",()=>{s.destroy();res("CONNECTED")});s.on("timeout",()=>{s.destroy();res("TIMEOUT")});s.on("error",(e)=>res("ERR:"+e.code))})}
console.log("READ_HOME_SECRET=" + tryRead(${JSON.stringify(secretPath)}))
console.log("READ_OWN_PACKFILE=" + tryRead(import.meta.path))
console.log("WRITE_SCRATCH=" + tryWrite(join(tmpdir(), "scratch-ok.txt")))
console.log("WRITE_PACKDIR=" + tryWrite(join(dirname(import.meta.path), "evil.txt")))
console.log("CONNECT_REMOTE=" + await connect(${JSON.stringify(REMOTE_HOST)}, ${REMOTE_PORT}))
process.exit(0)
`
}

/** Build a throwaway local pack on disk with a single escape-attempt probe. */
async function makeFixturePack(secretPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-runner-sbx-probe-"))
  const manifest = {
    name: "fixture-runner-sandbox",
    version: "0.0.0",
    spec_version: "1",
    source_type: "local",
    coverage_areas: ["test"],
    invariants: ["test"],
    probes: [{ name: "escape", file: "escape.ts" }],
  }
  await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
  await writeFile(join(dir, "escape.ts"), leakDetectorSource(secretPath))
  return dir
}

function outcomeOf(outcomes: ProbeRunOutcome[]): ProbeRunOutcome {
  const o = outcomes[0]
  if (!o) throw new Error("fixture pack produced no probe outcome")
  return o
}

/**
 * Run a trivial probe under the sandbox to confirm the mechanism actually works
 * here (bwrap can be installed but non-functional when unprivileged user
 * namespaces are disabled). Returns the outcome so the caller can SKIP rather
 * than FAIL when the sandbox cannot even launch a trivial probe.
 */
async function preflightSandbox(): Promise<ProbeRunOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-runner-sbx-preflight-"))
  await writeFile(
    join(dir, "lodestar.probe-pack.json"),
    JSON.stringify({
      name: "fixture-runner-sandbox-preflight",
      version: "0.0.0",
      spec_version: "1",
      source_type: "local",
      coverage_areas: ["test"],
      invariants: ["test"],
      probes: [{ name: "trivial", file: "trivial.ts" }],
    }),
  )
  await writeFile(join(dir, "trivial.ts"), 'console.log("ok"); process.exit(0)\n')
  try {
    const pack = await loadProbePack(dir, { allowUnsigned: true })
    return outcomeOf((await runPack(pack, { sandbox: {} })).outcomes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run(): Promise<ProbeResult> {
  const mechanism = detectSandboxMechanism()
  if (mechanism === null) {
    // Gated, like the Postgres-backed probes: skip loudly rather than fail when
    // the host has no sandbox mechanism (sandbox-exec on macOS / bwrap on Linux).
    return skip("no OS sandbox mechanism on this host")
  }

  // The mechanism may be present but non-functional (e.g. bwrap installed while
  // unprivileged user namespaces are disabled). Confirm a trivial probe runs
  // under it before asserting containment — skip rather than fail otherwise.
  const preflight = await preflightSandbox()
  if (!preflight.passed) {
    return skip(
      `sandbox mechanism '${mechanism}' present but non-functional: ${(
        preflight.stderr || preflight.stdout
      )
        .trim()
        .split("\n")
        .slice(0, 2)
        .join(" / ")}`,
    )
  }

  // Establish whether the host itself can reach the remote, so the egress-deny
  // assertion is meaningful and never a false pass on a network-less run.
  const baseline = await tryConnect(REMOTE_HOST, REMOTE_PORT)
  const remoteReachable = baseline === "CONNECTED"

  // Plant a "host secret" UNDER the REAL home directory — where ssh/aws/gcloud
  // credential stores live, and exactly what the sandbox must keep out of reach.
  // Derive it independently of `$HOME` (this probe runs under a scoped HOME when
  // driven by the harness, so `homedir()` is a temp dir, not the real home): on
  // macOS use the account's `/Users/<username>` (what the sandbox denies via the
  // `/Users` rule); on Linux any home path is unbound by bwrap, so `homedir()`
  // suffices. This is what would catch a regression of the $HOME-independent deny.
  const macHome = join("/Users", userInfo().username)
  const realHome = process.platform === "darwin" && existsSync(macHome) ? macHome : homedir()
  const secretDir = await mkdtemp(join(realHome, ".lodestar-sbx-secret-"))
  const secretFile = join(secretDir, "secret.txt")
  await writeFile(secretFile, "host-secret-must-not-be-readable-by-a-probe")

  const dir = await makeFixturePack(secretFile)
  try {
    const pack = await loadProbePack(dir, { allowUnsigned: true })
    const out = outcomeOf((await runPack(pack, { sandbox: {} })).outcomes)
    const o = out.stdout

    if (out.exit_code !== 0) {
      return {
        passed: false,
        details:
          `the sandboxed fixture probe did not exit cleanly (exit ${out.exit_code}, ` +
          `signal ${out.signal}) — the sandbox is breaking execution, not scoping it.\n${o}\n${out.stderr}`,
      }
    }

    // 1. Filesystem read of a host-home secret must be DENIED.
    if (!o.includes("READ_HOME_SECRET=DENIED")) {
      return {
        passed: false,
        details: `filesystem LEAK: the sandboxed probe READ a secret under the operator's home directory. The OS sandbox must confine reads away from the host's home.\n${o}`,
      }
    }
    // 4a. Positive control: the probe CAN read its own pack directory.
    if (!o.includes("READ_OWN_PACKFILE=READ_OK")) {
      return {
        passed: false,
        details: `the probe could not read its own pack file — the sandbox is over-restricting reads.\n${o}`,
      }
    }
    // 4b. Positive control: the probe CAN write its per-run scratch.
    if (!o.includes("WRITE_SCRATCH=WROTE")) {
      return {
        passed: false,
        details: `the probe could not write its scratch (TMPDIR) — the sandbox is over-restricting writes.\n${o}`,
      }
    }
    // 2. Filesystem write OUTSIDE the scratch (into the pack dir) must be DENIED.
    if (!o.includes("WRITE_PACKDIR=DENIED")) {
      return {
        passed: false,
        details: `filesystem WRITE escape: the sandboxed probe WROTE outside its scratch (into the read-only pack dir). The OS sandbox must confine writes to the per-run scratch.\n${o}`,
      }
    }
    // 3. Network egress to a genuine remote must be DENIED — when reachable at all.
    // (Anything other than CONNECTED — ERR:* / TIMEOUT — is the sandbox blocking it.)
    if (remoteReachable && o.includes("CONNECT_REMOTE=CONNECTED")) {
      return {
        passed: false,
        details: `network EGRESS escape: the sandboxed probe CONNECTED to ${REMOTE_HOST}:${REMOTE_PORT} (reachable unsandboxed). The OS sandbox must deny non-loopback outbound.\n${o}`,
      }
    }

    const netNote = remoteReachable
      ? `denied outbound to a reachable remote (${REMOTE_HOST}:${REMOTE_PORT})`
      : `network-egress assertion SKIPPED (host could not reach ${REMOTE_HOST}:${REMOTE_PORT} unsandboxed: ${baseline})`
    return {
      passed: true,
      details: `OS sandbox (${mechanism}) held the execution boundary: the sandboxed probe could not read a secret under the operator's home, could not write outside its per-run scratch, and ${netNote} — while still able to read its own pack dir and write its scratch (the positive controls). Filesystem + network reach are contained, not just host env.`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(secretDir, { recursive: true, force: true })
  }
}

const result = await run()
if (!result.skipped) {
  console.log("─".repeat(72))
  console.log("probe: runner_sandboxes_probe_filesystem_and_network")
  console.log("─".repeat(72))
  console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
  console.log(result.details)
  console.log("─".repeat(72))
}

if (!result.passed) process.exit(1)
