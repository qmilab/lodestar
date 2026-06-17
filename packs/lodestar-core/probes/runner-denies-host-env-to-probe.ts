#!/usr/bin/env bun
/**
 * Probe: runner_denies_host_env_to_probe
 *
 * Locks the runner-side execution boundary the registry epic surfaced but did
 * not itself close (#114, ADR-0022). The signing/verification chain
 * (#88 → #86 → #90 → #89 → #87) only guarantees that *authentic, content-bound
 * bytes* reach the harness runner; it says nothing about what those bytes do
 * when run. A pack's probes are executable code, and the runner used to spawn
 * `bun run <probe>` inheriting the **full host environment** — so a probe from
 * a pack you verified but did not author could read host `process.env` secrets.
 *
 * This drives the REAL `runPack` over a throwaway local fixture pack whose probe
 * is a "leak detector" that prints what it can see in its own environment, and
 * pins four things:
 *
 *   1. No host-env passthrough (the headline). A secret placed in the parent's
 *      `process.env` is ABSENT in the spawned probe's environment — the runner
 *      hands each probe an explicit scoped env, never the host's.
 *   2. PATH is present. The default scoped env still inherits PATH so `bun` (and
 *      anything a probe shells to) resolves — the positive control that the
 *      runner is genuinely scoping, not just running broken probes.
 *   3. The operator allowlist is honoured, and ONLY the operator's. A var named
 *      via `allowHostEnv` IS forwarded (so `--allow-env LODESTAR_TEST_DATABASE_URL`
 *      reaches the DB-gated probes), while a host secret NOT on the allowlist
 *      stays absent even on that same run. The manifest cannot widen the env —
 *      the allowlist is the operator's, passed to `runPack`, not the (untrusted)
 *      pack's to declare.
 *   4. No `.env` back-door. A secret living ONLY in a `.env` in the probe's
 *      working directory does NOT reach it — `bun run` auto-loads `.env` unless
 *      `--no-env-file` is passed, which would otherwise repopulate `process.env`
 *      with host secrets past the scoped env. The runner passes `--no-env-file`,
 *      so the scoped env stays authoritative.
 *
 * This is a TS/process-level governance boundary, not an OS sandbox: it denies
 * host-environment secrets, not filesystem or network reach. Real OS-level
 * containment is the separate longer-term step (ADR-0022 step 2). If this
 * invariant regresses, a verified-but-untrusted pack's probe could exfiltrate
 * host secrets the moment it runs — so this probe is spec, not test scaffolding.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type ProbeRunOutcome, loadProbePack, runPack } from "@qmilab/lodestar-harness"

interface ProbeResult {
  passed: boolean
  details: string
}

// A secret only ever placed in the PARENT process's env. It must never reach a
// spawned probe's environment. The marker is recognisable so a leak is obvious
// in the captured stdout.
const HOST_SECRET_VAR = "LODESTAR_RUNNER_PROBE_SECRET"
const HOST_SECRET_VALUE = "host-secret-must-not-leak-7f3a"

// A var the operator explicitly allowlists for a run (the positive control for
// the forwarding mechanism the CLI's `--allow-env` uses).
const ALLOWED_VAR = "LODESTAR_RUNNER_PROBE_ALLOWED"
const ALLOWED_VALUE = "operator-allowlisted-yes"

// A secret placed ONLY in a `.env` in the probe's working directory — never in
// process.env. If it reaches the probe it could only have come from `bun run`
// auto-loading `.env`, which the runner suppresses with `--no-env-file`.
const DOTENV_VAR = "LODESTAR_RUNNER_PROBE_DOTENV"
const DOTENV_VALUE = "secret-only-in-dotenv-must-not-load"

// The fixture probe: a standalone bun script that reports what it can see in its
// OWN environment, then always exits 0. The runner verdict here is irrelevant —
// the outer probe reads the captured stdout to decide pass/fail.
const LEAK_DETECTOR = `
const secret = process.env.${HOST_SECRET_VAR}
const allowed = process.env.${ALLOWED_VAR}
const dotenv = process.env.${DOTENV_VAR}
const path = process.env.PATH
console.log("SECRET=" + (secret === undefined ? "<absent>" : "LEAKED:" + secret))
console.log("ALLOWED=" + (allowed === undefined ? "<absent>" : allowed))
console.log("DOTENV=" + (dotenv === undefined ? "<absent>" : "LEAKED:" + dotenv))
console.log("PATH=" + (path && path.length > 0 ? "<present>" : "<absent>"))
process.exit(0)
`

/** Build a throwaway local pack on disk with a single leak-detector probe. */
async function makeFixturePack(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lodestar-runner-env-probe-"))
  const manifest = {
    name: "fixture-runner-env",
    version: "0.0.0",
    spec_version: "1",
    source_type: "local",
    coverage_areas: ["test"],
    invariants: ["test"],
    probes: [{ name: "leak-detector", file: "leak-detector.ts" }],
  }
  await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
  await writeFile(join(dir, "leak-detector.ts"), LEAK_DETECTOR)
  return dir
}

function outcomeOf(outcomes: ProbeRunOutcome[]): ProbeRunOutcome {
  const o = outcomes[0]
  if (!o) throw new Error("fixture pack produced no probe outcome")
  return o
}

async function run(): Promise<ProbeResult> {
  // Plant the secret in the PARENT env. It is present here for the whole run; a
  // correct runner still keeps it out of every spawned probe.
  process.env[HOST_SECRET_VAR] = HOST_SECRET_VALUE
  process.env[ALLOWED_VAR] = ALLOWED_VALUE

  const dir = await makeFixturePack()
  try {
    const pack = await loadProbePack(dir, { allowUnsigned: true })

    // --- Case 1: default scoped env (no allowlist). ---------------------------
    // Host secret must be absent; PATH must be present; the not-yet-allowlisted
    // var must also be absent.
    const def = outcomeOf((await runPack(pack)).outcomes)
    if (def.stdout.includes("SECRET=LEAKED:")) {
      return {
        passed: false,
        details:
          `host-env LEAK: ${HOST_SECRET_VAR} reached the spawned probe under the default ` +
          `scoped env. Runner must not pass host process.env to probes.\n${def.stdout}`,
      }
    }
    if (!def.stdout.includes("SECRET=<absent>")) {
      return {
        passed: false,
        details: `expected SECRET=<absent> under the default env; got:\n${def.stdout}`,
      }
    }
    if (!def.stdout.includes("PATH=<present>")) {
      return {
        passed: false,
        details: `PATH not inherited: 'bun' (and tools a probe shells to) would not resolve.\n${def.stdout}`,
      }
    }
    if (!def.stdout.includes("ALLOWED=<absent>")) {
      return {
        passed: false,
        details: `a var NOT on the allowlist leaked under the default env:\n${def.stdout}`,
      }
    }

    // --- Case 2: operator allowlist forwards ONLY the named var. --------------
    // The allowlisted var IS delivered; the host secret (not allowlisted) stays
    // absent on the SAME run — proving the allowlist is scoped, not "host env on".
    const allow = outcomeOf((await runPack(pack, { allowHostEnv: [ALLOWED_VAR] })).outcomes)
    if (!allow.stdout.includes(`ALLOWED=${ALLOWED_VALUE}`)) {
      return {
        passed: false,
        details: `allowlist FAILED: an explicitly allowlisted var did not reach the probe — --allow-env would not forward e.g. a test DB URL.\n${allow.stdout}`,
      }
    }
    if (!allow.stdout.includes("SECRET=<absent>")) {
      return {
        passed: false,
        details: `host-env LEAK: a non-allowlisted host secret reached the probe even when an allowlist was supplied. The allowlist must be additive, not host-env-on.\n${allow.stdout}`,
      }
    }

    // --- Case 3: a working-directory `.env` does not leak (--no-env-file). -----
    // Plant a secret ONLY in a `.env` in the probe's cwd. `bun run` auto-loads
    // `.env`; the runner passes `--no-env-file`, so it must not reach the probe.
    await writeFile(join(dir, ".env"), `${DOTENV_VAR}=${DOTENV_VALUE}\n`)
    const savedCwd = process.cwd()
    let dotenv: ProbeRunOutcome
    try {
      // The spawned probe inherits this cwd → bun would auto-load ./.env from it.
      process.chdir(dir)
      dotenv = outcomeOf((await runPack(pack)).outcomes)
    } finally {
      // Restore cwd before the outer finally removes `dir` (can't sit in a deleted cwd).
      process.chdir(savedCwd)
    }
    if (dotenv.stdout.includes("DOTENV=LEAKED:")) {
      return {
        passed: false,
        details: `dotenv LEAK: a secret from a working-directory .env reached the probe. The runner must spawn 'bun run --no-env-file' so .env cannot repopulate process.env.\n${dotenv.stdout}`,
      }
    }
    if (!dotenv.stdout.includes("DOTENV=<absent>")) {
      return {
        passed: false,
        details: `expected DOTENV=<absent> with --no-env-file; got:\n${dotenv.stdout}`,
      }
    }

    return {
      passed: true,
      details:
        "Runner held the execution boundary: a host process.env secret was absent from the " +
        "spawned probe under the default scoped env (PATH still inherited so bun resolves), " +
        "an operator-allowlisted var was forwarded while a non-allowlisted host secret stayed " +
        "absent on the same run (the allowlist is the operator's, additive and scoped, never " +
        "the untrusted manifest's to widen), and a secret living only in a working-directory " +
        ".env did not reach the probe (--no-env-file keeps the scoped env authoritative).",
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env[HOST_SECRET_VAR]
    delete process.env[ALLOWED_VAR]
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: runner_denies_host_env_to_probe")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
