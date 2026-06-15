#!/usr/bin/env bun
/**
 * Probe: mutable_git_ref_rejected
 *
 * A git pack source must pin an IMMUTABLE artifact (#86, ADR-0018, ADR-0016 §1):
 * a full 40-hex commit SHA. A branch, tag, or short SHA can be force-moved, so a
 * still-valid manifest signature could later cover different bytes — the exact
 * laundering hole the content binding exists to close. The pin is rejected unless
 * it is a full commit SHA.
 *
 *   CONTROL — the repository's real full commit SHA resolves.
 *   1. BRANCH  — a branch name ('main') is rejected.
 *   2. TAG     — a tag name ('v1.0.0') is rejected.
 *   3. SHORT   — a 12-char abbreviated SHA is rejected.
 *   4. ABSENT  — a well-formed 40-hex SHA that is not in the repository is
 *      rejected at resolution (a valid shape is necessary but not sufficient).
 *
 * Cases 1–3 are refused by the source-descriptor schema before any git runs; case
 * 4 by the resolver after the clone. Together: only a full SHA that actually
 * resolves is accepted.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_SPEC_VERSION,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { ProbePackError, loadProbePackFromSource } from "@qmilab/lodestar-harness"

const AUTHOR_ID = "trusted-pack-author"
const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\n"

function signedGitManifest(privateKeyPem: string): ProbePackManifest {
  const unsigned: ProbePackManifest = {
    name: "example-probe-pack",
    version: "1.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "git",
    coverage_areas: ["pack_registry"],
    invariants: ["pack_source_resolution"],
    probes: [{ name: "sample", file: PROBE_FILE }],
    author_id: AUTHOR_ID,
    content_digest: {
      algorithm: "sha256",
      files: [{ path: PROBE_FILE, sha256: createHash("sha256").update(PROBE_BODY).digest("hex") }],
    },
  }
  const signature = signProbePackManifest(unsigned, {
    authorId: AUTHOR_ID,
    privateKeyPem,
    at: "2026-01-01T00:00:00.000Z",
  })
  return { ...unsigned, signature }
}

function git(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => {
      stdout += d
    })
    child.stderr?.on("data", (d) => {
      stderr += d
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

async function assertRejects(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ProbePackError && err.message.includes(needle)) return
    throw new Error(`expected a ProbePackError containing "${needle}", got: ${String(err)}`)
  }
  throw new Error(`expected rejection containing "${needle}" but the load succeeded`)
}

async function run(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  try {
    const operator = generateEd25519KeyPair()
    const pinned = [{ actor_id: AUTHOR_ID, public_key: operator.publicKeyPem }]
    const manifest = signedGitManifest(operator.privateKeyPem)

    const repo = await mkdtemp(join(tmpdir(), "lodestar-probe-mutable-git-"))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Probe",
      GIT_AUTHOR_EMAIL: "probe@example.com",
      GIT_COMMITTER_NAME: "Probe",
      GIT_COMMITTER_EMAIL: "probe@example.com",
    }
    await mkdir(join(repo, "probes"), { recursive: true })
    await writeFile(join(repo, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
    await writeFile(join(repo, PROBE_FILE), PROBE_BODY)
    if ((await git(["init", "-q", repo], env)).code !== 0) throw new Error("git init failed")
    await git(["-C", repo, "add", "-A"], env)
    if ((await git(["-C", repo, "commit", "-q", "-m", "pack"], env)).code !== 0) {
      throw new Error("git commit failed")
    }
    await git(["-C", repo, "tag", "v1.0.0"], env)
    // Whatever the default branch is, expose it as 'main' so the branch case names a real ref.
    await git(["-C", repo, "branch", "-f", "main", "HEAD"], env)
    const sha = (await git(["-C", repo, "rev-parse", "HEAD"], env)).stdout.trim()

    // CONTROL — the real full SHA resolves.
    const ok = await loadProbePackFromSource(
      { type: "git", url: repo, commit: sha },
      { authorizedAuthorKeys: pinned },
    )
    if (ok.probes.length !== 1) throw new Error("CONTROL: full-SHA resolution failed")
    details.push("CONTROL: the repository's real full commit SHA resolves ✓")

    // 1–3 — mutable refs are refused by the descriptor schema (before any git).
    for (const [label, ref] of [
      ["1: branch name 'main'", "main"],
      ["2: tag name 'v1.0.0'", "v1.0.0"],
      ["3: 12-char short SHA", sha.slice(0, 12)],
    ] as const) {
      // `commit` is typed `string` — the full-SHA requirement is a runtime
      // refinement the descriptor schema enforces, so these mutable refs are
      // type-valid inputs that resolution must reject.
      await assertRejects(
        () =>
          loadProbePackFromSource(
            { type: "git", url: repo, commit: ref },
            { authorizedAuthorKeys: pinned },
          ),
        "40-hex commit SHA",
      )
      details.push(`${label} → rejected as not an immutable full SHA ✓`)
    }

    // 4 — a well-formed but absent 40-hex SHA is rejected at resolution.
    const absent = "0".repeat(40)
    await assertRejects(
      () =>
        loadProbePackFromSource(
          { type: "git", url: repo, commit: absent },
          { authorizedAuthorKeys: pinned },
        ),
      "present in the repository",
    )
    details.push("4: a well-formed 40-hex SHA not in the repository → rejected at resolution ✓")

    await rm(repo, { recursive: true, force: true })
  } catch (err) {
    return {
      passed: false,
      details: [...details, `FAIL: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: mutable_git_ref_rejected")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
