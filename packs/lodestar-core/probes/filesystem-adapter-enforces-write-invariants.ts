#!/usr/bin/env bun
/**
 * Probe: filesystem_adapter_enforces_write_invariants
 *
 * Locks the TS-level safety invariants of the native fs.write tool
 * (`@qmilab/lodestar-adapter-filesystem`, ADR-0012 — the graduated
 * documentation-agent `doc.write`) by driving the REAL adapter through the
 * REAL Action Kernel (propose → arbitrate → execute). Exercised adversarially:
 *
 *   1. Two-phase execution. An fs.write held by the gate parks at
 *      `pending_approval` and NOTHING touches disk while it waits; `execute()`
 *      on the held action throws; only `resolve(granted)` + `execute` lands the
 *      file. A denied write ends `rejected` with the disk untouched.
 *   2. Precondition revalidation (TOCTOU). A `must_revalidate_at_execution`
 *      precondition that stops holding between approval and execution rejects
 *      the action — approved intent does not authorise a stale world — and the
 *      file is never written.
 *   3. Trust floor. A contract below the tool's L3 floor is refused at
 *      propose time (writes are L3: local reversible, per the trust ladder).
 *   4. Path confinement under the scoped root. `..` traversal, an absolute
 *      path outside the root, a symlinked directory inside the root pointing
 *      out, a destination that is itself a symlink to an outside file, and a
 *      symlinked ancestor under `createDirs` ALL end `failed` with nothing
 *      written outside the root (and the symlink's outside target unchanged).
 *   5. No host-environment passthrough. There is no subprocess and no shell:
 *      `~` / `$VAR` in paths are literal characters (the write lands under a
 *      directory literally named `$HOME` inside the root — proving no
 *      expansion consulted the host env), and a secret planted in
 *      `process.env` never surfaces in the observation.
 *   6. Bounded write. Contents over the byte cap are REJECTED (the action ends
 *      `failed`, no partial file) — never silently truncated. A missing parent
 *      directory fails rather than silently growing the tree when `createDirs`
 *      is off.
 *
 * If any invariant regresses, an agent wrapped by Lodestar could write outside
 * its scoped root via a crafted path or symlink, mutate the project before
 * approval, or smuggle host-env-derived destinations — so this probe is spec,
 * not test scaffolding.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ActionKernel,
  type ApprovalOutcome,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { type FsWriteOutput, registerFsWriteTool } from "@qmilab/lodestar-adapter-filesystem"
import type { Action, ActionContract, ActionPrecondition, Observation } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

const HOST_SECRET = "host-secret-must-not-surface-fswrite-7b1d"

function contractFor(level: number, preconditions: ActionPrecondition[] = []): ActionContract {
  return {
    required_level: level,
    blast_radius: "project",
    reversibility: "compensable",
    scope: { level: "project", identifier: "probe-fswrite" },
    // Action-level sensitivity is public | private | secret; the kernel maps
    // private -> observation sensitivity 'internal'.
    data_sensitivity: "private",
    preconditions,
  }
}

function grant(action: Action, requestId: string): ApprovalOutcome {
  return {
    kind: "granted",
    action_id: action.id,
    request_id: requestId,
    approver_id: "probe.human-approver",
    reason: "probe grants the held write",
  }
}

async function run(): Promise<ProbeResult> {
  process.env.LODESTAR_FSWRITE_PROBE_SECRET = HOST_SECRET

  const root = await mkdtemp(join(tmpdir(), "lodestar-probe-fswrite-root-"))
  const outside = await mkdtemp(join(tmpdir(), "lodestar-probe-fswrite-outside-"))

  const observations: Observation[] = []
  const observationSink = async (obs: Observation) => {
    observations.push(obs)
  }

  // The gate and the precondition checker read mutable state via object
  // properties (not closure-mutated `let` — strict tsc literal-narrows those).
  const gate = { mode: "approve" as "approve" | "hold" | "deny" }
  const world = { preconditionHolds: true }

  const policyGate: PolicyGate = async () => {
    if (gate.mode === "hold") {
      return {
        approved: false,
        reason: "L3 write held for human approval",
        approver_id: "probe.policy",
        requires_human_approval: true,
      }
    }
    if (gate.mode === "deny") {
      return { approved: false, reason: "probe denies", approver_id: "probe.policy" }
    }
    return { approved: true, reason: "probe approves", approver_id: "probe.policy" }
  }
  const preconditionChecker: PreconditionChecker = async () => ({
    holds: world.preconditionHolds,
    observed: world.preconditionHolds ? "intact" : "changed",
  })

  try {
    _resetToolsForTests()
    registerFsWriteTool({ writableRoot: root })

    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      useStubsForTests: true,
    })

    // Drive one action end to end under the current gate mode. Returns the
    // terminal Action and (if completed) the validated fs.write output.
    async function act(
      inputs: { path: string; contents: string },
      level: number,
      preconditions: ActionPrecondition[] = [],
    ): Promise<{
      action: Action
      output: FsWriteOutput | undefined
      observation: Observation | undefined
    }> {
      const proposed = kernel.propose({
        intent: `probe fs.write ${inputs.path}`,
        tool: "fs.write",
        inputs,
        contract: contractFor(level, preconditions),
        proposed_by: "probe.fswrite-adapter",
      })
      const arbitrated = await kernel.arbitrate(proposed)
      if (arbitrated.phase !== "approved") {
        return { action: arbitrated, output: undefined, observation: undefined }
      }
      const executed = await kernel.execute(arbitrated)
      const obs = observations.find((o) => o.source.invocation_id === executed.id)
      return {
        action: executed,
        output: obs?.payload as FsWriteOutput | undefined,
        observation: obs,
      }
    }

    // ---- 1. Two-phase: a held write touches nothing until resolved ---------
    gate.mode = "hold"
    const heldPath = join(root, "held.md")
    const heldProposed = kernel.propose({
      intent: "probe held fs.write",
      tool: "fs.write",
      inputs: { path: "held.md", contents: "governed contents" },
      contract: contractFor(3),
      proposed_by: "probe.fswrite-adapter",
    })
    const held = await kernel.arbitrate(heldProposed)
    if (held.phase !== "pending_approval") {
      return {
        passed: false,
        details: `two-phase FAILED: a held fs.write did not park at pending_approval (phase=${held.phase}).`,
      }
    }
    if (existsSync(heldPath)) {
      return {
        passed: false,
        details:
          "two-phase FAILED: the file appeared on disk while the action was only at pending_approval — a held write touched the world.",
      }
    }
    let executeFromHeldThrew = false
    try {
      await kernel.execute(held)
    } catch {
      executeFromHeldThrew = true
    }
    if (executeFromHeldThrew === false) {
      return {
        passed: false,
        details:
          "two-phase FAILED: execute() accepted an action at pending_approval instead of refusing it.",
      }
    }
    const granted = kernel.resolve(held, grant(held, "req-fswrite-held"))
    const heldDone = await kernel.execute(granted)
    if (heldDone.phase !== "completed" || readFileSync(heldPath, "utf8") !== "governed contents") {
      return {
        passed: false,
        details: `two-phase FAILED: the granted write did not land (phase=${heldDone.phase}).`,
      }
    }
    const heldObs = observations.find((o) => o.source.invocation_id === heldDone.id)
    if (heldObs?.sensitivity !== "internal") {
      return {
        passed: false,
        details: `observation FAILED: expected contract data_sensitivity 'private' to map to observation sensitivity 'internal', got '${heldObs?.sensitivity}'.`,
      }
    }
    if (JSON.stringify(heldObs.payload).includes(HOST_SECRET)) {
      return {
        passed: false,
        details: "env FAILED: a host process.env secret surfaced in the fs.write observation.",
      }
    }

    // ---- 1b. A denied write touches nothing ---------------------------------
    gate.mode = "deny"
    const denied = await act({ path: "denied.md", contents: "x" }, 3)
    if (denied.action.phase !== "rejected" || existsSync(join(root, "denied.md"))) {
      return {
        passed: false,
        details: `deny FAILED: phase=${denied.action.phase}, file-exists=${existsSync(join(root, "denied.md"))} — a rejected write must leave the disk untouched.`,
      }
    }
    gate.mode = "approve"

    // ---- 2. TOCTOU: revalidated precondition stops a stale-world write ------
    world.preconditionHolds = false
    const stale = await act({ path: "stale.md", contents: "x" }, 3, [
      {
        check_id: "fs.parent_snapshot_unchanged",
        parameters: { path: "stale.md" },
        expected_at_approval: "intact",
        must_revalidate_at_execution: true,
      },
    ])
    world.preconditionHolds = true
    if (stale.action.phase !== "rejected" || existsSync(join(root, "stale.md"))) {
      return {
        passed: false,
        details: `TOCTOU FAILED: phase=${stale.action.phase}, file-exists=${existsSync(join(root, "stale.md"))} — a precondition that no longer holds at execution must reject the approved write before it touches disk.`,
      }
    }

    // ---- 3. Trust floor: a contract below L3 is refused at propose ----------
    let floorThrew = false
    try {
      kernel.propose({
        intent: "probe under-floor fs.write",
        tool: "fs.write",
        inputs: { path: "underfloor.md", contents: "x" },
        contract: contractFor(2),
        proposed_by: "probe.fswrite-adapter",
      })
    } catch (err) {
      floorThrew = /below tool 'fs\.write' minimum 3/.test(String(err))
    }
    if (floorThrew === false) {
      return {
        passed: false,
        details:
          "trust-floor FAILED: a contract at L2 was not refused at propose time — fs.write must enforce its L3 floor.",
      }
    }

    // ---- 4. Path confinement -------------------------------------------------
    const dotdot = await act({ path: "../dotdot-escape.md", contents: "x" }, 3)
    if (dotdot.action.phase !== "failed" || existsSync(join(root, "..", "dotdot-escape.md"))) {
      return {
        passed: false,
        details: `confinement FAILED ('..'): phase=${dotdot.action.phase} — a dot-dot path must fail and write nothing.`,
      }
    }
    const absTarget = join(outside, "abs-escape.md")
    const abs = await act({ path: absTarget, contents: "x" }, 3)
    if (abs.action.phase !== "failed" || existsSync(absTarget)) {
      return {
        passed: false,
        details: `confinement FAILED (absolute): phase=${abs.action.phase}, file-exists=${existsSync(absTarget)} — an absolute path outside the root must fail and write nothing.`,
      }
    }
    // A symlinked directory inside the root pointing outside it.
    symlinkSync(outside, join(root, "sneaky-dir"))
    const viaDir = await act({ path: "sneaky-dir/inner.md", contents: "x" }, 3)
    if (viaDir.action.phase !== "failed" || existsSync(join(outside, "inner.md"))) {
      return {
        passed: false,
        details: `confinement FAILED (symlinked dir): phase=${viaDir.action.phase}, escaped=${existsSync(join(outside, "inner.md"))} — the lexical check cannot see through symlinks; the realpath check must.`,
      }
    }
    // A destination that is itself a symlink to an outside file.
    const outsideFile = join(outside, "victim.md")
    writeFileSync(outsideFile, "untouched")
    symlinkSync(outsideFile, join(root, "alias.md"))
    const viaLink = await act({ path: "alias.md", contents: "PWNED" }, 3)
    if (viaLink.action.phase !== "failed" || readFileSync(outsideFile, "utf8") !== "untouched") {
      return {
        passed: false,
        details: `confinement FAILED (symlink destination): phase=${viaLink.action.phase}, outside contents=${JSON.stringify(readFileSync(outsideFile, "utf8"))} — writing through a symlink destination must be refused, not followed.`,
      }
    }
    // A missing parent fails rather than silently growing the tree.
    const noParent = await act({ path: "no/such/dir/file.md", contents: "x" }, 3)
    if (noParent.action.phase !== "failed" || existsSync(join(root, "no"))) {
      return {
        passed: false,
        details: `createDirs-off FAILED: phase=${noParent.action.phase} — a missing parent must fail the write when createDirs is off.`,
      }
    }
    // Overwrite is reported honestly (compensable: the audit sees what was replaced).
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, "docs", "page.md"), "0123456789")
    const overwrite = await act({ path: "docs/page.md", contents: "new" }, 3)
    if (
      overwrite.action.phase !== "completed" ||
      overwrite.output?.created !== false ||
      overwrite.output?.previous_bytes !== 10
    ) {
      return {
        passed: false,
        details: `overwrite FAILED: phase=${overwrite.action.phase}, created=${overwrite.output?.created}, previous_bytes=${overwrite.output?.previous_bytes} — an overwrite must report created=false and the replaced size.`,
      }
    }

    // ---- 5 & 6. createDirs confinement, literal paths, bounded write --------
    _resetToolsForTests()
    registerFsWriteTool({ writableRoot: root, createDirs: true, maxBytes: 64 })

    // createDirs cannot escape through a symlinked ancestor.
    const viaDeep = await act({ path: "sneaky-dir/deep/inner.md", contents: "x" }, 3)
    if (viaDeep.action.phase !== "failed" || existsSync(join(outside, "deep"))) {
      return {
        passed: false,
        details: `createDirs confinement FAILED: phase=${viaDeep.action.phase}, escaped=${existsSync(join(outside, "deep"))} — directory creation must be confined exactly like the file itself.`,
      }
    }
    // `$HOME` and `~` are literal path characters — no host-env expansion.
    const literal = await act({ path: "$HOME/literal.md", contents: "x" }, 3)
    if (literal.action.phase !== "completed" || !existsSync(join(root, "$HOME", "literal.md"))) {
      return {
        passed: false,
        details: `literal-path FAILED: phase=${literal.action.phase} — '$HOME/literal.md' must land under a directory literally named '$HOME' inside the root, proving the adapter never consulted the host environment to expand it.`,
      }
    }
    const tilde = await act({ path: "~/tilde.md", contents: "x" }, 3)
    if (tilde.action.phase !== "completed" || !existsSync(join(root, "~", "tilde.md"))) {
      return {
        passed: false,
        details: `literal-path FAILED: phase=${tilde.action.phase} — '~/tilde.md' must land under a directory literally named '~' inside the root, not the host home directory.`,
      }
    }
    // Oversized contents are rejected, never truncated.
    const big = await act({ path: "big.md", contents: "x".repeat(65) }, 3)
    if (big.action.phase !== "failed" || existsSync(join(root, "big.md"))) {
      return {
        passed: false,
        details: `bounded-write FAILED: phase=${big.action.phase}, file-exists=${existsSync(join(root, "big.md"))} — 65 bytes under a 64-byte cap must fail with no partial file (rejected, not truncated).`,
      }
    }

    return {
      passed: true,
      details:
        "Native fs.write held every TS-level invariant through the Action Kernel: a held L3 write parked at pending_approval and touched no disk until resolve(granted)+execute landed it (execute() refused the parked action); a denied write left the disk untouched; a must_revalidate_at_execution precondition that stopped holding rejected the approved write (TOCTOU); a contract below the L3 floor was refused at propose; '..' traversal, an absolute outside path, a symlinked directory, a symlink destination (outside target unchanged), and a createDirs symlinked ancestor all failed with nothing written outside the root; a missing parent failed with createDirs off; an overwrite honestly reported created=false/previous_bytes; '$HOME' and '~' stayed literal (no host-env expansion) and the planted host secret never surfaced in the observation; and 65 bytes under a 64-byte cap were rejected with no partial file.",
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: filesystem_adapter_enforces_write_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
