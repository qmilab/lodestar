import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PackSourceRef } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { resolveGitSource } from "./git-source.js"
import { resolveNpmSource } from "./npm-source.js"
import { resolvePackSource } from "./source.js"
import { extractTarball } from "./tar.js"

const sha512 = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`

/** A fake fetch routing the registry metadata endpoint and the tarball endpoint. */
function fakeFetch(opts: { meta: unknown; metaStatus?: number; tarball?: Buffer }): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith("/-/pack.tgz")) {
      return new Response(opts.tarball ?? Buffer.alloc(0))
    }
    return new Response(JSON.stringify(opts.meta), {
      status: opts.metaStatus ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("resolvePackSource", () => {
  test("local resolves in place to its path", async () => {
    const resolved = await resolvePackSource({ type: "local", path: "/some/pack" })
    expect(resolved.root).toBe("/some/pack")
    expect(resolved.ref.type).toBe("local")
  })

  test("rejects a git ref that is not a full 40-hex commit SHA", async () => {
    for (const commit of ["main", "v1.0.0", "abc1234", "0".repeat(39), "A".repeat(40)]) {
      const ref = { type: "git", url: "/repo", commit } as PackSourceRef
      await expect(resolvePackSource(ref)).rejects.toThrow(/40-hex commit SHA/)
    }
  })

  test("rejects an npm version that is a range, not exact", async () => {
    const ref = {
      type: "npm",
      package: "p",
      version: "^1.0.0",
      integrity: "sha512-AAAA",
    } as PackSourceRef
    await expect(resolvePackSource(ref)).rejects.toThrow(/Invalid pack source descriptor/)
  })
})

describe("resolveNpmSource integrity gates", () => {
  const REG = "http://registry.test"

  test("rejects when the registry-advertised integrity differs from the pin", async () => {
    const fetchImpl = fakeFetch({
      meta: { dist: { tarball: `${REG}/-/pack.tgz`, integrity: "sha512-OTHER" } },
    })
    await expect(
      resolveNpmSource(
        { type: "npm", package: "p", version: "1.0.0", integrity: "sha512-PINNED", registry: REG },
        { fetchImpl },
      ),
    ).rejects.toThrow(/does not match the pinned integrity/)
  })

  test("rejects when the downloaded bytes do not match the pinned SRI", async () => {
    const tarball = Buffer.from("not the pinned bytes")
    const wrongPin = sha512(Buffer.from("different bytes entirely"))
    const fetchImpl = fakeFetch({
      // Registry advertises the (wrong) pin so the registry-vs-pin check passes;
      // the bytes-vs-pin check is the one that must fire.
      meta: { dist: { tarball: `${REG}/-/pack.tgz`, integrity: wrongPin } },
      tarball,
    })
    await expect(
      resolveNpmSource(
        { type: "npm", package: "p", version: "1.0.0", integrity: wrongPin, registry: REG },
        { fetchImpl },
      ),
    ).rejects.toThrow(/integrity mismatch/)
  })

  test("surfaces a non-OK registry response as a ProbePackError", async () => {
    const fetchImpl = fakeFetch({ meta: {}, metaStatus: 404 })
    await expect(
      resolveNpmSource(
        { type: "npm", package: "p", version: "1.0.0", integrity: "sha512-AAAA", registry: REG },
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(ProbePackError)
  })

  test("aborts and rejects a tarball that exceeds the size cap (before integrity)", async () => {
    const big = Buffer.alloc(4096, 7)
    const fetchImpl = fakeFetch({
      meta: { dist: { tarball: `${REG}/-/pack.tgz`, integrity: "sha512-AAAA" } },
      tarball: big,
    })
    await expect(
      resolveNpmSource(
        { type: "npm", package: "p", version: "1.0.0", integrity: "sha512-AAAA", registry: REG },
        { fetchImpl, maxTarballBytes: 64 },
      ),
    ).rejects.toThrow(/cap/)
  })
})

describe("extractTarball confinement", () => {
  test("rejects a tarball with a symlink entry BEFORE writing anything (tar-slip)", async () => {
    const stage = await mkdtemp(join(tmpdir(), "lodestar-tar-evil-"))
    const pkg = join(stage, "package")
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, "real.ts"), "ok")
    // The write-through vector: a symlink pointing outside the pack root. tar can
    // write *through* it during extraction, so it must be refused at the pre-scan.
    await symlink("/etc/hosts", join(pkg, "evil-link"))
    const tgz = join(stage, "evil.tgz")
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", stage, "package"]).exitCode).toBe(0)

    const dest = await mkdtemp(join(tmpdir(), "lodestar-tar-dest-"))
    await expect(extractTarball(tgz, dest)).rejects.toThrow(/link entry/)
    // The pre-scan ran first: extraction never started, so nothing was written.
    expect(existsSync(join(dest, "real.ts"))).toBe(false)
    expect(existsSync(join(dest, "evil-link"))).toBe(false)
  })

  test("fails closed when the entry listing is truncated (cannot scan it all)", async () => {
    const stage = await mkdtemp(join(tmpdir(), "lodestar-tar-big-"))
    const pkg = join(stage, "package")
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, "a.ts"), "1")
    await writeFile(join(pkg, "b.ts"), "2")
    const tgz = join(stage, "ok.tgz")
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", stage, "package"]).exitCode).toBe(0)

    const dest = await mkdtemp(join(tmpdir(), "lodestar-tar-bigdest-"))
    // A tiny cap forces the listing to truncate even for this small archive: an
    // unscannable listing must be refused, not extracted, so an unsafe entry past
    // the cut-off cannot slip through.
    await expect(extractTarball(tgz, dest, { maxListingBytes: 16 })).rejects.toThrow(
      /too large to scan safely/,
    )
    expect(existsSync(join(dest, "a.ts"))).toBe(false)
  })
})

describe("git source confinement", () => {
  test("rejects a checkout containing a symlink (e.g. a symlinked manifest)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "lodestar-git-symlink-"))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Probe",
      GIT_AUTHOR_EMAIL: "probe@example.com",
      GIT_COMMITTER_NAME: "Probe",
      GIT_COMMITTER_EMAIL: "probe@example.com",
    }
    await writeFile(join(repo, "real.ts"), "ok")
    // A symlinked manifest would be followed by loadProbePack outside the root.
    await symlink("/etc/hosts", join(repo, "lodestar.probe-pack.json"))
    expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(0)
    Bun.spawnSync(["git", "-C", repo, "add", "-A"], { env })
    expect(Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "x"], { env }).exitCode).toBe(0)
    const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { env })
      .stdout.toString()
      .trim()

    await expect(resolveGitSource({ type: "git", url: repo, commit: sha })).rejects.toThrow(
      /symlink/,
    )
  })
})

describe("direct resolver input validation", () => {
  test("resolveNpmSource rejects a non-exact version even when called directly", async () => {
    await expect(
      resolveNpmSource({
        type: "npm",
        package: "p",
        version: "latest",
        integrity: "sha512-AAAA",
      } as never),
    ).rejects.toThrow(/Invalid npm pack source/)
  })

  test("resolveGitSource rejects a mutable ref even when called directly", async () => {
    await expect(
      resolveGitSource({ type: "git", url: "/repo", commit: "main" } as never),
    ).rejects.toThrow(/40-hex commit SHA/)
  })
})

describe("git source credential redaction", () => {
  test("does not leak URL userinfo in a clone-failure error", async () => {
    // Port 1 is closed → connection refused, so the clone fails fast. The error
    // must carry the redacted URL, never the embedded token.
    const url = "http://user:s3cr3t-token@127.0.0.1:1/repo.git"
    let message = ""
    try {
      await resolveGitSource({ type: "git", url, commit: "0".repeat(40) })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toContain("s3cr3t-token")
    expect(message).toContain("***")
  })
})
