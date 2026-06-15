#!/usr/bin/env bun
/**
 * Probe: pack_resolves_from_npm
 *
 * Source resolution (#86, ADR-0018, ADR-0016 §1): a pack that ships as a
 * published artifact resolves to immutable, content-verified bytes via a
 * non-executing fetch, and then goes through the #88 signature + content-digest
 * verification before its probes could run. The pin is recorded.
 *
 *   A. NPM — a pack published to a (local stand-in) npm registry resolves from an
 *      exact version + SRI integrity, the signature + content digest verify over
 *      the *fetched* bytes, and the loaded pin (version + integrity) is recorded.
 *   B. NPM TAMPERED — an artifact whose downloaded bytes do not match the pinned
 *      SRI is REJECTED, even when the registry advertises the pinned hash. This is
 *      the load-bearing check: source resolution cannot launder a swapped artifact.
 *   C. GIT — the same pack, resolved from a git repository pinned to a FULL commit
 *      SHA, loads and records the commit.
 *
 * Everything runs offline: a local Bun HTTP server stands in for the registry and
 * a local git repository stands in for the remote.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_PACK_SPEC_VERSION,
  type PackContentDigest,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { ProbePackError, loadProbePackFromSource } from "@qmilab/lodestar-harness"

const AUTHOR_ID = "trusted-pack-author"
const AT = "2026-01-01T00:00:00.000Z"
const PKG = "example-probe-pack"
const VERSION = "1.4.2"
const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\n"

function contentDigest(): PackContentDigest {
  return {
    algorithm: "sha256",
    files: [{ path: PROBE_FILE, sha256: createHash("sha256").update(PROBE_BODY).digest("hex") }],
  }
}

/** A signed manifest declaring one probe, for a given distribution source_type. */
function signedManifest(sourceType: "npm" | "git", privateKeyPem: string): ProbePackManifest {
  const unsigned: ProbePackManifest = {
    name: PKG,
    version: VERSION,
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: sourceType,
    coverage_areas: ["pack_registry"],
    invariants: ["pack_source_resolution"],
    probes: [{ name: "sample", file: PROBE_FILE }],
    author_id: AUTHOR_ID,
    content_digest: contentDigest(),
  }
  const signature = signProbePackManifest(unsigned, { authorId: AUTHOR_ID, privateKeyPem, at: AT })
  return { ...unsigned, signature }
}

function sha512Sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

/** Flip the first base64 char of an SRI to get a syntactically-valid but wrong pin. */
function corruptSri(sri: string): string {
  const dash = sri.indexOf("-")
  const head = sri.slice(0, dash + 1)
  const body = sri.slice(dash + 1)
  const first = body[0] === "A" ? "B" : "A"
  return head + first + body.slice(1)
}

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

/** Build the conventional npm tarball (a `package/` prefix) and return its bytes. */
async function buildTarball(manifest: ProbePackManifest): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), "lodestar-probe-npm-stage-"))
  const pkgDir = join(staging, "package")
  await mkdir(join(pkgDir, "probes"), { recursive: true })
  await writeFile(join(pkgDir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
  await writeFile(join(pkgDir, PROBE_FILE), PROBE_BODY)
  const tgz = join(staging, "pack.tgz")
  const r = await run("tar", ["-czf", tgz, "-C", staging, "package"])
  if (r.code !== 0) throw new Error(`tar pack failed: ${r.stderr}`)
  return Buffer.from(await Bun.file(tgz).arrayBuffer())
}

/** A local stand-in npm registry: serves the version metadata + the tarball. */
function startRegistry(
  advertisedIntegrity: string,
  tarball: Buffer,
): { registry: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)
      if (path === `/${PKG}/${VERSION}`) {
        return Response.json({
          dist: { tarball: `${url.origin}/-/pack.tgz`, integrity: advertisedIntegrity },
        })
      }
      if (path === "/-/pack.tgz") {
        return new Response(tarball, { headers: { "content-type": "application/octet-stream" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { registry: server.url.origin, stop: () => server.stop(true) }
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

async function run_(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  try {
    const operator = generateEd25519KeyPair()
    const pinned = [{ actor_id: AUTHOR_ID, public_key: operator.publicKeyPem }]

    // ── A — npm happy path: resolve, verify over fetched bytes, record the pin ──
    const npmManifest = signedManifest("npm", operator.privateKeyPem)
    const tarball = await buildTarball(npmManifest)
    const integrity = sha512Sri(tarball)
    {
      const reg = startRegistry(integrity, tarball)
      try {
        const pack = await loadProbePackFromSource(
          { type: "npm", package: PKG, version: VERSION, integrity, registry: reg.registry },
          { authorizedAuthorKeys: pinned },
        )
        if (pack.probes.length !== 1) throw new Error("A: npm pack resolved without its probe")
        if (pack.source?.ref.type !== "npm")
          throw new Error("A: resolved source not recorded as npm")
        if (pack.source.ref.version !== VERSION || pack.source.ref.integrity !== integrity) {
          throw new Error("A: resolved pin (version + integrity) not recorded")
        }
      } finally {
        reg.stop()
      }
    }
    details.push(
      "A: pack resolves from npm (exact version + SRI), signature + digest verify over fetched bytes, pin recorded ✓",
    )

    // ── B — tampered artifact: downloaded bytes ≠ pinned SRI → rejected ─────────
    // The registry advertises the (corrupt) pinned hash so the registry-vs-pin
    // check passes; the real bytes still hash to the true SRI, so the bytes-vs-pin
    // check — the load-bearing one — rejects.
    {
      const wrong = corruptSri(integrity)
      const reg = startRegistry(wrong, tarball)
      try {
        await assertRejects(
          () =>
            loadProbePackFromSource(
              {
                type: "npm",
                package: PKG,
                version: VERSION,
                integrity: wrong,
                registry: reg.registry,
              },
              { authorizedAuthorKeys: pinned },
            ),
          "integrity mismatch",
        )
      } finally {
        reg.stop()
      }
    }
    details.push(
      "B: downloaded bytes that do not match the pinned SRI → rejected (no laundering) ✓",
    )

    // ── C — git: resolve the same pack from a full pinned commit SHA ────────────
    const gitManifest = signedManifest("git", operator.privateKeyPem)
    const repo = await mkdtemp(join(tmpdir(), "lodestar-probe-git-repo-"))
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
    await writeFile(join(repo, "lodestar.probe-pack.json"), JSON.stringify(gitManifest, null, 2))
    await writeFile(join(repo, PROBE_FILE), PROBE_BODY)
    const init = await run("git", ["init", "-q", repo], { env: gitEnv })
    if (init.code !== 0) throw new Error(`C: git init failed: ${init.stderr}`)
    await run("git", ["-C", repo, "add", "-A"], { env: gitEnv })
    const commit = await run("git", ["-C", repo, "commit", "-q", "-m", "pack"], { env: gitEnv })
    if (commit.code !== 0) throw new Error(`C: git commit failed: ${commit.stderr}`)
    const sha = (await run("git", ["-C", repo, "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim()

    const gitPack = await loadProbePackFromSource(
      { type: "git", url: repo, commit: sha },
      { authorizedAuthorKeys: pinned },
    )
    if (gitPack.probes.length !== 1) throw new Error("C: git pack resolved without its probe")
    if (gitPack.source?.ref.type !== "git" || gitPack.source.ref.commit !== sha) {
      throw new Error("C: resolved git commit pin not recorded")
    }
    await rm(repo, { recursive: true, force: true })
    details.push("C: pack resolves from git at a full pinned commit SHA, commit recorded ✓")
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
console.log("probe: pack_resolves_from_npm")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
