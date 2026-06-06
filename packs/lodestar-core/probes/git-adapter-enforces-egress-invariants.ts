#!/usr/bin/env bun
/**
 * Probe: git_adapter_enforces_egress_invariants
 *
 * Locks the egress-governance invariants of the native git transport tools
 * (`@qmilab/lodestar-adapter-git`: `git.commit` / `git.push` / `git.clone`) by
 * driving the REAL adapter tools through the REAL Action Kernel
 * (propose → arbitrate → resolve → execute). `git.push` is the first native tool
 * that moves data *out*, so these are the things the egress story MUST hold,
 * exercised against a local bare repo standing in for the remote:
 *
 *   1. **L4 hold blocks the world.** A push proposed at L4 is parked at
 *      `pending_approval` by a gate that requires human approval — and the ref
 *      does NOT appear in the remote while it waits. Only after `resolve(granted)`
 *      + `execute` does it land. (Two-phase discipline on the egress action.)
 *   2. **Remote pinning beats a poisoned `.git/config`.** The workspace's own
 *      `origin` points at an unreachable decoy; the approved push still lands in
 *      the operator-PINNED remote (it succeeds entirely offline) — the agent
 *      cannot redirect a push by rewriting repo config.
 *   3. **Credentials never leak.** The configured token is absent from the
 *      recorded action inputs and the emitted observation (it flows via askpass
 *      env, never argv, and is redacted from captured output).
 *   3b. **No refspec injection.** A push branch like `main:refs/heads/evil` is
 *      rejected even once approved — it cannot touch/delete another ref on the
 *      pinned remote (the push builds a fixed `refs/heads/X:refs/heads/X`).
 *   3c. **Poisoned local config is rejected.** A workspace `.git/config` with
 *      `url.*.pushInsteadOf` (which would rewrite the pinned URL) makes the push
 *      end `failed` — local config can't redirect egress or run helpers/filters.
 *   3d. **Poisoned signing config cannot exec.** `commit.gpgsign` + a hostile
 *      `gpg.program` makes the commit end `failed` and never runs the "signer".
 *   4. **Clone source allowlist.** A clone of a non-allowlisted URL ends `failed`
 *      and writes nothing.
 *   5. **Clone destination confinement.** A clone whose destination escapes the
 *      pinned clone root — by string path OR through a planted symlink — ends
 *      `failed` and writes nothing outside it.
 *   6. **No host-env passthrough.** A host `GIT_AUTHOR_NAME` (which overrides
 *      `-c user.name` in git) does NOT reach the commit subprocess — the author
 *      stays the pinned identity.
 *
 * If any of these regress, a Lodestar-wrapped agent could push to an attacker
 * remote, exfiltrate a credential, clone outside its sandbox, or inherit host
 * secrets — so this probe is spec, not test scaffolding.
 */

import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { registerGitTransportTools } from "@qmilab/lodestar-adapter-git"
import type {
  Action,
  ActionContract,
  BlastRadius,
  Observation,
  Reversibility,
} from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

const CREDENTIAL_SENTINEL = "ghp_PROBE_TOKEN_must_never_surface_8f1c"

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "user.name=Probe",
        "-c",
        "user.email=probe@test.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    )
    return { ok: true, out }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

// process.env requires `delete`: assigning `undefined` coerces to the literal
// string "undefined" (which git would then read as a real value).
function unsetEnv(key: string): void {
  delete process.env[key]
}

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-git" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()

  const workRepo = mkdtempSync(join(tmpdir(), "lodestar-probe-git-work-"))
  const bareRemote = mkdtempSync(join(tmpdir(), "lodestar-probe-git-remote-"))
  const cloneRoot = mkdtempSync(join(tmpdir(), "lodestar-probe-git-cloneroot-"))

  const observations: Observation[] = []
  const observationSink = async (obs: Observation) => {
    observations.push(obs)
  }
  // Three-valued gate: anything at L4+ is held for human approval; below auto-approves.
  const policyGate: PolicyGate = async (action) => {
    if (action.contract.required_level >= 4) {
      return {
        approved: false,
        requires_human_approval: true,
        reason: "L4 egress requires human approval",
        approver_id: "probe.policy",
      }
    }
    return { approved: true, reason: "below L4 auto-approved", approver_id: "probe.policy" }
  }
  const preconditionChecker: PreconditionChecker = async () => ({ holds: true, observed: null })

  try {
    // Fixture: a work repo on `main` with one commit; an empty bare "remote".
    git(bareRemote, ["init", "--bare", "-q"])
    // Pin the bare remote's default branch to `main` so the positive clone control
    // checks it out regardless of the host git's init.defaultBranch (CI: `master`).
    git(bareRemote, ["symbolic-ref", "HEAD", "refs/heads/main"])
    git(workRepo, ["init", "-q"])
    writeFileSync(join(workRepo, "README.md"), "# probe fixture\n")
    git(workRepo, ["add", "-A"])
    git(workRepo, ["commit", "-q", "-m", "initial"])
    git(workRepo, ["branch", "-M", "main"])
    // Poison the workspace's own remote config to an unreachable decoy.
    git(workRepo, ["remote", "add", "origin", "https://decoy.invalid/should-never-be-used.git"])

    registerGitTransportTools({
      workspaceRoot: workRepo,
      commit: true,
      push: {
        remotes: { origin: bareRemote },
        credential: { kind: "https-token", token: CREDENTIAL_SENTINEL },
      },
      clone: { cloneRoot, allowSource: (url) => url === bareRemote },
    })

    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      useStubsForTests: true,
    })

    const propose = (tool: string, inputs: unknown, contract: ActionContract) =>
      kernel.propose({ intent: `probe ${tool}`, tool, inputs, contract, proposed_by: "probe.git" })

    // ---- 6. No host-env passthrough (commit) ------------------------------
    process.env.GIT_AUTHOR_NAME = "HOST_LEAK"
    process.env.GIT_COMMITTER_NAME = "HOST_LEAK"
    let commitAuthor = ""
    try {
      writeFileSync(join(workRepo, "feature.ts"), "export const x = 1\n")
      const commitArb = await kernel.arbitrate(
        propose("git.commit", { message: "add feature" }, contractFor(3, "project", "compensable")),
      )
      if (commitArb.phase !== "approved") {
        return {
          passed: false,
          details: `commit was not approved at L3 (phase=${commitArb.phase})`,
        }
      }
      const commitDone = await kernel.execute(commitArb)
      if (commitDone.phase !== "completed") {
        return { passed: false, details: `git.commit did not complete (phase=${commitDone.phase})` }
      }
      commitAuthor = git(workRepo, ["log", "-1", "--format=%an"]).out.trim()
    } finally {
      unsetEnv("GIT_AUTHOR_NAME")
      unsetEnv("GIT_COMMITTER_NAME")
    }
    if (commitAuthor !== "Lodestar Agent") {
      return {
        passed: false,
        details: `host-env passthrough FAILED: commit author is '${commitAuthor}', expected the pinned 'Lodestar Agent'. A host GIT_AUTHOR_NAME leaked into the scoped subprocess env.`,
      }
    }

    // ---- 1. L4 hold blocks the world --------------------------------------
    const pushHeld = await kernel.arbitrate(
      propose("git.push", {}, contractFor(4, "external", "irreversible")),
    )
    if (pushHeld.phase !== "pending_approval") {
      return {
        passed: false,
        details: `L4 hold FAILED: a push proposed at L4 did not park at pending_approval (phase=${pushHeld.phase}).`,
      }
    }
    // While held, the ref must NOT exist in the remote. `for-each-ref` exits
    // cleanly with empty output when nothing matches (no scary `fatal` noise).
    if (
      git(bareRemote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).out.includes(
        "refs/heads/main",
      )
    ) {
      return {
        passed: false,
        details:
          "L4 hold FAILED: refs/heads/main reached the remote while the push was only at pending_approval — a held egress action touched the world.",
      }
    }

    // ---- 1b + 2 + 3. Approve → lands in the PINNED remote; no decoy; no leak -
    const pushApproved = kernel.resolve(pushHeld, {
      kind: "granted",
      action_id: pushHeld.id,
      request_id: "probe-req-push",
      approver_id: "probe.human",
    })
    const pushDone = await kernel.execute(pushApproved)
    if (pushDone.phase !== "completed") {
      return {
        passed: false,
        details: `approved push did not complete (phase=${pushDone.phase}); audit: ${JSON.stringify(pushDone.audit.at(-1))}`,
      }
    }
    const remoteRef = git(bareRemote, ["rev-parse", "refs/heads/main"])
    const localHead = git(workRepo, ["rev-parse", "HEAD"])
    if (!remoteRef.ok || remoteRef.out.trim() !== localHead.out.trim()) {
      return {
        passed: false,
        details: `remote pinning FAILED: the approved push did not land HEAD in the pinned remote (remote=${remoteRef.out.trim()}, local=${localHead.out.trim()}).`,
      }
    }
    // Credential must not appear in the recorded inputs or the observation.
    const pushObs = observations.find((o) => o.source.invocation_id === pushDone.id)
    if (!pushObs) {
      return {
        passed: false,
        details: "credential check: no observation was recorded for the push.",
      }
    }
    if (JSON.stringify(pushObs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details: "credential leak FAILED: the configured token surfaced in the push observation.",
      }
    }
    if (JSON.stringify(pushDone.inputs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details:
          "credential leak FAILED: the configured token surfaced in the recorded action inputs.",
      }
    }

    // ---- 3b. Push branch refspec injection is rejected --------------------
    // A caller-supplied branch like "main:refs/heads/evil" must NOT become a
    // refspec that touches another ref on the pinned remote — even once approved.
    const pushInject = await kernel.arbitrate(
      propose(
        "git.push",
        { branch: "main:refs/heads/evil" },
        contractFor(4, "external", "irreversible"),
      ),
    )
    const pushInjectDone = await kernel.execute(
      kernel.resolve(pushInject, {
        kind: "granted",
        action_id: pushInject.id,
        request_id: "probe-req-inject",
        approver_id: "probe.human",
      }),
    )
    if (pushInjectDone.phase !== "failed") {
      return {
        passed: false,
        details: `branch validation FAILED: an approved push with a refspec-injection branch did not end 'failed' (phase=${pushInjectDone.phase}).`,
      }
    }
    if (
      git(bareRemote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).out.includes(
        "refs/heads/evil",
      )
    ) {
      return {
        passed: false,
        details:
          "branch validation FAILED: a refspec-injection branch created/touched refs/heads/evil on the pinned remote.",
      }
    }

    // ---- 3c. Poisoned local .git/config is rejected -----------------------
    // A local `url.*.pushInsteadOf` rewrites the operator-pinned URL → it would
    // redirect the push to an attacker remote. The transport must refuse to run.
    git(workRepo, ["config", "--local", "url.https://evil.invalid/.pushInsteadOf", bareRemote])
    const pushPoisoned = await kernel.arbitrate(
      propose("git.push", {}, contractFor(4, "external", "irreversible")),
    )
    const pushPoisonedDone = await kernel.execute(
      kernel.resolve(pushPoisoned, {
        kind: "granted",
        action_id: pushPoisoned.id,
        request_id: "probe-req-poison",
        approver_id: "probe.human",
      }),
    )
    if (pushPoisonedDone.phase !== "failed") {
      return {
        passed: false,
        details: `local-config hardening FAILED: an approved push with a poisoned url.*.pushInsteadOf did not end 'failed' (phase=${pushPoisonedDone.phase}) — the pinned URL could be rewritten.`,
      }
    }
    // Restore the workspace config so later sections are unaffected.
    git(workRepo, ["config", "--local", "--unset", "url.https://evil.invalid/.pushInsteadOf"])

    // ---- 3d. Poisoned signing config cannot exec a "signer" ---------------
    // commit.gpgsign=true + gpg.program=<script> would spawn the script on commit.
    // The hostile-config guard must reject it before git runs — no marker appears.
    const gpgMarker = join(cloneRoot, "SIGNER_RAN") // a path outside the work repo
    const signer = join(workRepo, "fake-signer.sh")
    writeFileSync(signer, `#!/bin/sh\ntouch "${gpgMarker}"\nexit 1\n`, { mode: 0o755 })
    chmodSync(signer, 0o755)
    git(workRepo, ["config", "--local", "commit.gpgsign", "true"])
    git(workRepo, ["config", "--local", "gpg.program", signer])
    writeFileSync(join(workRepo, "more.ts"), "export const m = 1\n")
    const commitSign = await kernel.arbitrate(
      propose("git.commit", { message: "signed?" }, contractFor(3, "project", "compensable")),
    )
    const commitSignDone = await kernel.execute(commitSign)
    if (commitSignDone.phase !== "failed") {
      return {
        passed: false,
        details: `signing-config hardening FAILED: a commit with commit.gpgsign + a hostile gpg.program did not end 'failed' (phase=${commitSignDone.phase}).`,
      }
    }
    if (existsSync(gpgMarker)) {
      return {
        passed: false,
        details:
          "signing-config hardening FAILED: the configured gpg.program 'signer' executed (SIGNER_RAN appeared) — a poisoned signing config reached arbitrary code execution.",
      }
    }
    git(workRepo, ["config", "--local", "--unset", "commit.gpgsign"])
    git(workRepo, ["config", "--local", "--unset", "gpg.program"])

    // ---- 4. Clone source allowlist ----------------------------------------
    const cloneBlocked = await kernel.arbitrate(
      propose(
        "git.clone",
        { url: "https://evil.invalid/x.git", destination: "evil" },
        contractFor(3, "project", "reversible"),
      ),
    )
    const cloneBlockedDone = await kernel.execute(cloneBlocked)
    if (cloneBlockedDone.phase !== "failed") {
      return {
        passed: false,
        details: `clone allowlist FAILED: a non-allowlisted source did not end 'failed' (phase=${cloneBlockedDone.phase}).`,
      }
    }

    // ---- 5. Clone destination confinement ---------------------------------
    const cloneEscape = await kernel.arbitrate(
      propose(
        "git.clone",
        { url: bareRemote, destination: "../escape" },
        contractFor(3, "project", "reversible"),
      ),
    )
    const cloneEscapeDone = await kernel.execute(cloneEscape)
    if (cloneEscapeDone.phase !== "failed") {
      return {
        passed: false,
        details: `clone confinement FAILED: a destination escaping the clone root did not end 'failed' (phase=${cloneEscapeDone.phase}).`,
      }
    }
    // Nothing should have been written into (or beside) the clone root by the
    // two rejected clones.
    if (readdirSync(cloneRoot).length !== 0) {
      return {
        passed: false,
        details: `clone confinement FAILED: rejected clones wrote into the clone root (${readdirSync(cloneRoot).join(", ")}).`,
      }
    }

    // ---- 5b. Clone through a symlink cannot escape the clone root ----------
    // A symlink under the root (planted by an untrusted prior setup) must not
    // redirect the clone outside it — the string-path check alone would miss this.
    const outsideDir = mkdtempSync(join(tmpdir(), "lodestar-probe-git-outside-"))
    try {
      symlinkSync(outsideDir, join(cloneRoot, "link"))
      const cloneSymlinkDone = await kernel.execute(
        await kernel.arbitrate(
          propose(
            "git.clone",
            { url: bareRemote, destination: "link" },
            contractFor(3, "project", "reversible"),
          ),
        ),
      )
      if (cloneSymlinkDone.phase !== "failed") {
        return {
          passed: false,
          details: `clone symlink confinement FAILED: a symlinked destination escaping the root did not end 'failed' (phase=${cloneSymlinkDone.phase}).`,
        }
      }
      if (readdirSync(outsideDir).length !== 0) {
        return {
          passed: false,
          details:
            "clone symlink confinement FAILED: the clone wrote through a symlink into a directory outside the clone root.",
        }
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }

    // ---- positive control: an allowlisted, confined clone DOES work --------
    const cloneOk = await kernel.arbitrate(
      propose(
        "git.clone",
        { url: bareRemote, destination: "copy" },
        contractFor(3, "project", "reversible"),
      ),
    )
    const cloneOkDone = await kernel.execute(cloneOk)
    if (cloneOkDone.phase !== "completed") {
      return {
        passed: false,
        details: `positive clone control FAILED: an allowlisted, confined clone did not complete (phase=${cloneOkDone.phase}). The negative results above are only meaningful if a valid clone succeeds.`,
      }
    }
    if (!existsSync(join(cloneRoot, "copy", "README.md"))) {
      return {
        passed: false,
        details:
          "positive clone control FAILED: the cloned working tree is missing its expected content.",
      }
    }

    return {
      passed: true,
      details:
        "Native git transport held every egress invariant through the Action Kernel: a host GIT_AUTHOR_NAME did not leak into the commit (author stayed the pinned identity); a push proposed at L4 parked at pending_approval and the ref stayed out of the remote until approval; the approved push landed HEAD in the operator-pinned remote despite a poisoned decoy origin (offline); the configured token never surfaced in inputs or the observation; an approved push with a refspec-injection branch ('main:refs/heads/evil') ended 'failed' and created no stray ref; a poisoned workspace .git/config (url.*.pushInsteadOf) made an approved push end 'failed' rather than redirect the pinned URL; a commit with commit.gpgsign + a hostile gpg.program ended 'failed' and never ran the signer; a non-allowlisted clone source, a path-escaping destination, and a symlink-escaping destination all ended 'failed' writing nothing outside the clone root; and a valid, confined clone completed.",
    }
  } finally {
    for (const dir of [workRepo, bareRemote, cloneRoot]) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: git_adapter_enforces_egress_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
