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
 *   4. Wall-clock timeout + descendant reaping. A long command is killed at the
 *      deadline (`timed_out: true`) — including a descendant that inherited the pipes
 *      (the whole process group is killed, not just the immediate child). And on
 *      NORMAL completion the group is reaped too, so a command that backgrounds a
 *      stdio-redirected descendant cannot leave it running past the action.
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
    // Action-level sensitivity is public | private | secret (NOT the 4-value
    // observation sensitivity); `sensitivityForContract` maps private -> internal.
    // Using "internal" here would fall through to an undefined observation sensitivity.
    data_sensitivity: "private",
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
        {
          // Spawns a descendant that inherits the stdout/stderr pipes, then the
          // shell exits — the classic case where killing only the immediate child
          // leaves the descendant holding the pipes and the read hanging.
          name: "shell.spawner",
          bin: "sh",
          argsMatcher: (a) => a,
          trust: 0,
          reversibility: "reversible",
          timeoutMs: 400,
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
    ): Promise<{
      action: Action
      output: ShellRunOutput | undefined
      observation: Observation | undefined
    }> {
      const proposed = kernel.propose({
        intent: `probe ${tool}`,
        tool,
        inputs: { args },
        contract: contractFor(level),
        proposed_by: "probe.shell-adapter",
      })
      const arbitrated = await kernel.arbitrate(proposed)
      if (arbitrated.phase !== "approved") {
        return { action: arbitrated, output: undefined, observation: undefined }
      }
      const executed = await kernel.execute(arbitrated)
      const obs = observations.find((o) => o.source.invocation_id === executed.id)
      return {
        action: executed,
        output: obs?.payload as ShellRunOutput | undefined,
        observation: obs,
      }
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
    // The kernel must emit a VALID observation: the contract's `private`
    // data_sensitivity maps to observation sensitivity `internal`. A bad action
    // sensitivity would fall through to `undefined` here — so assert it explicitly.
    if (leak.observation?.sensitivity !== "internal") {
      return {
        passed: false,
        details: `observation FAILED: expected the kernel to map contract data_sensitivity 'private' to observation sensitivity 'internal', got '${leak.observation?.sensitivity}'.`,
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

    // ---- 4b. Timeout kills DESCENDANTS, not just the immediate child -------
    // `sh -c 'sleep 10 &'` backgrounds a sleep that inherits the stdout/stderr
    // pipes, then sh exits. If the deadline killed only the immediate process, the
    // descendant would hold the pipes open and the read would hang ~10s past the
    // deadline (and orphan the sleep). The process-group kill must reclaim it.
    const orphan = await act("shell.spawner", ["-c", "sleep 10 &"], 0)
    if (orphan.action.phase !== "completed" || !orphan.output) {
      return {
        passed: false,
        details: `descendant-timeout: shell.spawner did not complete (phase=${orphan.action.phase})`,
      }
    }
    if (!orphan.output.timed_out) {
      return {
        passed: false,
        details:
          "descendant-timeout FAILED: a pipe-holding descendant under a 400ms deadline did not report timed_out.",
      }
    }
    if (orphan.output.duration_ms >= 5000) {
      return {
        passed: false,
        details: `descendant-timeout FAILED: the call ran ${orphan.output.duration_ms}ms — a descendant kept the pipes open past the deadline. The timeout must kill the whole process group, not just the immediate child.`,
      }
    }

    // ---- 4c. NORMAL completion also reaps backgrounded descendants ---------
    // The complement of 4b: `sh -c '(sleep 1; touch MARKER) >/dev/null 2>&1 &'`
    // backgrounds a descendant that REDIRECTS its stdio, so the pipes close and sh
    // exits immediately — `close` fires before any deadline and the timer is cleared.
    // Without reaping the group on normal completion, that descendant survives the
    // governed action and touches MARKER ~1s later. The reap must prevent it.
    const marker = join(workspace, "ORPHAN_MARKER")
    const bg = await act(
      "shell.spawner",
      ["-c", "(sleep 1; touch ORPHAN_MARKER) >/dev/null 2>&1 &"],
      0,
    )
    if (bg.action.phase !== "completed") {
      return {
        passed: false,
        details: `reap-on-completion: shell.spawner did not complete (phase=${bg.action.phase})`,
      }
    }
    if (bg.output?.timed_out) {
      return {
        passed: false,
        details:
          "reap-on-completion: the backgrounding command unexpectedly timed out instead of completing normally — the test no longer exercises the normal-completion path.",
      }
    }
    // Wait past the descendant's 1s delay: if it survived the action it would have
    // created the marker by now.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
    if (existsSync(marker)) {
      return {
        passed: false,
        details:
          "reap-on-completion FAILED: a backgrounded, stdio-redirected descendant outlived the completed action and created ORPHAN_MARKER. The process group must be reaped on normal completion, not just at the deadline.",
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
        "Native shell adapter held every TS-level invariant through the Action Kernel: host secret stayed out of the subprocess env (scoped var present, observation sensitivity = internal), the allowlist rejected a forbidden request, argv-array exec blocked '&& touch PWNED' (no PWNED file), the 5s sleep was killed at the 200ms deadline (timed_out), a pipe-holding descendant was reclaimed by the process-group kill (not left to run 10s past the deadline), a backgrounded stdio-redirected descendant was reaped on normal completion (no ORPHAN_MARKER), and 9000 bytes were truncated to the 2000-byte cap.",
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
