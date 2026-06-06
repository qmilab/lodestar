#!/usr/bin/env bun
/**
 * Probe: shell_adapter_enforces_sandbox_invariants
 *
 * Locks the TS-level safety invariants of the native shell adapter
 * (`@qmilab/lodestar-adapter-shell`) by driving the REAL adapter tools through
 * the REAL Action Kernel (propose → arbitrate → execute). The adapter is a
 * governance boundary, not an OS sandbox — these are the things it DOES claim,
 * exercised adversarially:
 *
 *   1. No host-env passthrough. A secret placed in `process.env` is absent from a
 *      command's environment (negative), while a var declared in the scoped `env`
 *      IS present (positive control). This is the "no host env to sandboxes" rule.
 *   2. Allowlist denial. A request outside a command's `argsMatcher` is rejected
 *      before anything is spawned → the action ends `failed`.
 *   3. No shell injection. Even a passthrough matcher cannot inject a second
 *      command: argv is an array, never a shell string, so `&& touch PWNED` is a
 *      literal argument and no `PWNED` file appears.
 *   4. Wall-clock timeout. A long command is killed at the deadline and the
 *      observation carries `timed_out: true`.
 *   5. Bounded output capture. Output beyond the byte cap is truncated and flagged.
 *
 * If any invariant regresses, an agent wrapped by Lodestar could leak host
 * secrets to a subprocess, smuggle an extra command past the allowlist, or run
 * unbounded — so this probe is spec, not test scaffolding.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { type ShellRunOutput, bunTest, registerShellTools } from "@qmilab/lodestar-adapter-shell"
import type { Action, ActionContract, Observation } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

const HOST_SECRET = "host-secret-must-not-leak-9c2e"

function contractFor(level: number): ActionContract {
  return {
    required_level: level,
    blast_radius: "self",
    reversibility: "reversible",
    scope: { level: "project", identifier: "probe-shell" },
    data_sensitivity: "internal",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()
  process.env.LODESTAR_SHELL_PROBE_SECRET = HOST_SECRET

  const workspace = await mkdtemp(join(tmpdir(), "lodestar-probe-shell-"))
  const observations: Observation[] = []
  const observationSink = async (obs: Observation) => {
    observations.push(obs)
  }
  const policyGate: PolicyGate = async () => ({
    approved: true,
    reason: "probe always approves",
    approver_id: "probe.shell-adapter",
  })
  const preconditionChecker: PreconditionChecker = async () => ({ holds: true, observed: null })

  try {
    const PATH = process.env.PATH ?? ""

    // Register the adapter's REAL tools across a few configs so each case gets the
    // env / cap it needs. Distinct tool names; the shared shell.run@1 output schema
    // registers once (idempotent).
    registerShellTools({
      workspaceRoot: workspace,
      env: { PATH, LODESTAR_SCOPED_OK: "scoped-yes" },
      commands: [
        {
          name: "shell.envcheck",
          bin: "printenv",
          argsMatcher: (a) => a,
          trust: 0,
          reversibility: "reversible",
        },
        {
          name: "shell.echo",
          bin: "echo",
          argsMatcher: (a) => a,
          trust: 0,
          reversibility: "reversible",
        },
      ],
    })
    registerShellTools({
      workspaceRoot: workspace,
      env: { PATH },
      commands: [bunTest({ trust: 3 })], // shell.test — allowlist is `bun test [-t <pattern>]`
    })
    registerShellTools({
      workspaceRoot: workspace,
      env: { PATH },
      commands: [
        {
          name: "shell.sleeper",
          bin: "sleep",
          argsMatcher: (a) => a,
          trust: 0,
          reversibility: "reversible",
          timeoutMs: 200,
        },
      ],
    })
    registerShellTools({
      workspaceRoot: workspace,
      env: { PATH },
      maxOutputBytes: 2000,
      commands: [
        {
          name: "shell.flood",
          bin: "bun",
          argsMatcher: (a) => a,
          trust: 0,
          reversibility: "reversible",
        },
      ],
    })

    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      useStubsForTests: true,
    })

    // Drive one action end to end. Returns the terminal Action and (if completed)
    // the validated shell.run output from its observation.
    async function act(
      tool: string,
      args: string[],
      level: number,
    ): Promise<{ action: Action; output: ShellRunOutput | undefined }> {
      const proposed = kernel.propose({
        intent: `probe ${tool}`,
        tool,
        inputs: { args },
        contract: contractFor(level),
        proposed_by: "probe.shell-adapter",
      })
      const arbitrated = await kernel.arbitrate(proposed)
      if (arbitrated.phase !== "approved") return { action: arbitrated, output: undefined }
      const executed = await kernel.execute(arbitrated)
      const obs = observations.find((o) => o.source.invocation_id === executed.id)
      return { action: executed, output: obs?.payload as ShellRunOutput | undefined }
    }

    // ---- 1. No host-env passthrough ---------------------------------------
    const leak = await act("shell.envcheck", ["LODESTAR_SHELL_PROBE_SECRET"], 0)
    if (leak.action.phase !== "completed" || !leak.output) {
      return {
        passed: false,
        details: `env-isolation: shell.envcheck did not complete (phase=${leak.action.phase})`,
      }
    }
    if (leak.output.stdout.includes(HOST_SECRET)) {
      return {
        passed: false,
        details: `env-isolation FAILED: the host secret leaked into the subprocess env. stdout=${JSON.stringify(leak.output.stdout)}`,
      }
    }
    const positive = await act("shell.envcheck", ["LODESTAR_SCOPED_OK"], 0)
    if (positive.output?.stdout.trim() !== "scoped-yes") {
      return {
        passed: false,
        details: `env positive-control FAILED: a var declared in the scoped env was not visible (stdout=${JSON.stringify(positive.output?.stdout)}). The negative result above is only meaningful if the env channel works.`,
      }
    }

    // ---- 2. Allowlist denial ----------------------------------------------
    const denied = await act("shell.test", ["definitely", "not", "allowed"], 3)
    if (denied.action.phase !== "failed") {
      return {
        passed: false,
        details: `allowlist FAILED: a forbidden args request was not rejected (phase=${denied.action.phase}, expected 'failed').`,
      }
    }

    // ---- 3. No shell injection (argv array, never a shell string) ----------
    const inject = await act("shell.echo", ["hi", "&&", "touch", "PWNED"], 0)
    if (inject.action.phase !== "completed") {
      return {
        passed: false,
        details: `injection: shell.echo did not complete (phase=${inject.action.phase})`,
      }
    }
    if (existsSync(join(workspace, "PWNED"))) {
      return {
        passed: false,
        details:
          "injection FAILED: '&& touch PWNED' executed as a second command — a PWNED file was created. argv-array exec must treat it as a literal argument.",
      }
    }

    // ---- 4. Wall-clock timeout --------------------------------------------
    const slept = await act("shell.sleeper", ["5"], 0)
    if (slept.action.phase !== "completed" || !slept.output) {
      return {
        passed: false,
        details: `timeout: shell.sleeper did not complete (phase=${slept.action.phase})`,
      }
    }
    if (!slept.output.timed_out) {
      return {
        passed: false,
        details: "timeout FAILED: a 5s sleep under a 200ms deadline did not report timed_out.",
      }
    }
    if (slept.output.duration_ms >= 4000) {
      return {
        passed: false,
        details: `timeout FAILED: the process was not killed promptly (duration_ms=${slept.output.duration_ms}).`,
      }
    }

    // ---- 5. Bounded output capture ----------------------------------------
    const flood = await act("shell.flood", ["-e", "process.stdout.write('x'.repeat(9000))"], 0)
    if (flood.action.phase !== "completed" || !flood.output) {
      return {
        passed: false,
        details: `truncation: shell.flood did not complete (phase=${flood.action.phase})`,
      }
    }
    if (!flood.output.stdout_truncated) {
      return {
        passed: false,
        details:
          "truncation FAILED: 9000 bytes under a 2000-byte cap did not set stdout_truncated.",
      }
    }
    if (flood.output.stdout.length > 2000) {
      return {
        passed: false,
        details: `truncation FAILED: captured stdout (${flood.output.stdout.length} bytes) exceeds the 2000-byte cap.`,
      }
    }

    return {
      passed: true,
      details:
        "Native shell adapter held every TS-level invariant through the Action Kernel: host secret stayed out of the subprocess env (scoped var present), the allowlist rejected a forbidden request, argv-array exec blocked '&& touch PWNED' (no PWNED file), the 5s sleep was killed at the 200ms deadline (timed_out), and 9000 bytes were truncated to the 2000-byte cap.",
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: shell_adapter_enforces_sandbox_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
