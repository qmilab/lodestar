#!/usr/bin/env bun
/**
 * Probe: resolution_runs_no_pack_code
 *
 * Source resolution is a NON-EXECUTING fetch (#86, ADR-0018, ADR-0016 §1): a pack
 * is a trust artifact, not capability. `pack add` must never run an npm lifecycle
 * script (`preinstall`/`postinstall`) or a git hook — no pack-authored code runs
 * until *after* the signature and content digest verify. If resolution executed
 * pack code, the verification gate would already have been bypassed.
 *
 *   NPM — a tarball whose `package.json` declares a `postinstall` that would write
 *     a marker file is fetched + extracted; the marker never appears (no
 *     `npm install` is run), and the pack files are present.
 *   GIT — a repository carrying both a malicious `postinstall` AND an executable
 *     `post-checkout` hook is cloned + checked out at a pinned SHA; the marker
 *     never appears (hooks are disabled, no install runs), `.git` is removed, and
 *     the pack files are present.
 *
 * The marker file is the canary: its absence after resolution is the proof that
 * no pack-authored code executed.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveGitSource, resolveNpmSource } from "@qmilab/lodestar-harness"

const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\n"

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
    })
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

/** A package.json whose postinstall would touch `markerPath` if anything ran it. */
function maliciousPackageJson(markerPath: string): string {
  return JSON.stringify(
    {
      name: "example-probe-pack",
      version: "1.0.0",
      scripts: {
        preinstall: `node -e "require('fs').writeFileSync('${markerPath}','preinstall')"`,
        postinstall: `node -e "require('fs').writeFileSync('${markerPath}','postinstall')"`,
      },
    },
    null,
    2,
  )
}

async function run_(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  try {
    const markerDir = await mkdtemp(join(tmpdir(), "lodestar-probe-marker-"))

    // ── NPM ────────────────────────────────────────────────────────────────────
    const npmMarker = join(markerDir, "npm-pwned")
    const staging = await mkdtemp(join(tmpdir(), "lodestar-probe-nocode-npm-"))
    const pkgDir = join(staging, "package")
    await mkdir(join(pkgDir, "probes"), { recursive: true })
    await writeFile(join(pkgDir, "package.json"), maliciousPackageJson(npmMarker))
    await writeFile(join(pkgDir, PROBE_FILE), PROBE_BODY)
    const tgz = join(staging, "pack.tgz")
    if ((await run("tar", ["-czf", tgz, "-C", staging, "package"])).code !== 0) {
      throw new Error("NPM: tar pack failed")
    }
    const bytes = Buffer.from(await Bun.file(tgz).arrayBuffer())

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (decodeURIComponent(url.pathname) === "/example-probe-pack/1.0.0") {
          return Response.json({ dist: { tarball: `${url.origin}/-/pack.tgz` } })
        }
        if (url.pathname === "/-/pack.tgz") return new Response(bytes)
        return new Response("not found", { status: 404 })
      },
    })
    let npmRoot: string
    try {
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
      npmRoot = await resolveNpmSource({
        type: "npm",
        package: "example-probe-pack",
        version: "1.0.0",
        integrity,
        registry: server.url.origin,
      })
    } finally {
      server.stop(true)
    }
    if (existsSync(npmMarker))
      throw new Error("NPM: postinstall marker was written — resolution executed pack code!")
    if (!existsSync(join(npmRoot, "package.json")) || !existsSync(join(npmRoot, PROBE_FILE))) {
      throw new Error("NPM: pack files missing after extraction")
    }
    details.push(
      "NPM: a tarball with a malicious postinstall extracts, marker never written, files present ✓",
    )

    // ── GIT ──────────────────────────────────────────────────────────────────────
    const gitMarker = join(markerDir, "git-pwned")
    const repo = await mkdtemp(join(tmpdir(), "lodestar-probe-nocode-git-"))
    const gitEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Probe",
      GIT_AUTHOR_EMAIL: "probe@example.com",
      GIT_COMMITTER_NAME: "Probe",
      GIT_COMMITTER_EMAIL: "probe@example.com",
    }
    await mkdir(join(repo, "probes"), { recursive: true })
    await writeFile(join(repo, "package.json"), maliciousPackageJson(gitMarker))
    await writeFile(join(repo, PROBE_FILE), PROBE_BODY)
    if ((await run("git", ["init", "-q", repo], { env: gitEnv })).code !== 0) {
      throw new Error("GIT: git init failed")
    }
    await run("git", ["-C", repo, "add", "-A"], { env: gitEnv })
    if (
      (await run("git", ["-C", repo, "commit", "-q", "-m", "pack"], { env: gitEnv })).code !== 0
    ) {
      throw new Error("GIT: git commit failed")
    }
    const sha = (await run("git", ["-C", repo, "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim()
    // A hostile post-checkout hook in the source repo: clone does not copy it, and
    // our resolver checks out with hooks disabled — so it must not fire either way.
    const hook = join(repo, ".git", "hooks", "post-checkout")
    await writeFile(hook, `#!/bin/sh\necho pwned > "${gitMarker}"\n`)
    await chmod(hook, 0o755)

    const gitRoot = await resolveGitSource({ type: "git", url: repo, commit: sha })
    if (existsSync(gitMarker)) {
      throw new Error("GIT: post-checkout hook / install ran — resolution executed pack code!")
    }
    if (existsSync(join(gitRoot, ".git")))
      throw new Error("GIT: .git was not removed from the resolved root")
    if (!existsSync(join(gitRoot, "package.json")) || !existsSync(join(gitRoot, PROBE_FILE))) {
      throw new Error("GIT: pack files missing after checkout")
    }
    details.push(
      "GIT: a repo with a postinstall + post-checkout hook checks out, marker never written, .git removed ✓",
    )

    await rm(markerDir, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  } catch (err) {
    return {
      passed: false,
      details: [...details, `FAIL: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  return { passed: true, details }
}

const result = await run_()
console.log("─".repeat(72))
console.log("probe: resolution_runs_no_pack_code")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
