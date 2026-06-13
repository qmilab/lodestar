import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PackContentDigest,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { harnessCommand } from "./harness.js"

/**
 * `lodestar harness run/list` verify-on-load trust plumbing (#88, ADR-0017).
 * These pin the two CLI regressions Codex's review caught: an unsigned non-bundled
 * pack must NOT auto-load just because it was addressed by a bare name, and a
 * signed external pack must be loadable by pinning its author key with
 * `--author-key`.
 */

const AUTHOR_ID = "acme-packs"
const PROBE_BODY = "#!/usr/bin/env bun\nexport {}\n"

function contentDigest(): PackContentDigest {
  return {
    algorithm: "sha256",
    files: [{ path: "noop.ts", sha256: createHash("sha256").update(PROBE_BODY).digest("hex") }],
  }
}

function baseManifest(): ProbePackManifest {
  return {
    name: "acme-pack",
    version: "0.0.0",
    spec_version: "1",
    source_type: "local",
    coverage_areas: ["x"],
    invariants: ["y"],
    probes: [{ name: "noop", file: "noop.ts" }],
  }
}

/** Materialise a pack dir; `sign` with the given key when provided, else unsigned. */
async function makePack(dir: string, privateKeyPem?: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "noop.ts"), PROBE_BODY)
  let manifest: ProbePackManifest = baseManifest()
  if (privateKeyPem) {
    const unsigned: ProbePackManifest = {
      ...manifest,
      author_id: AUTHOR_ID,
      content_digest: contentDigest(),
    }
    manifest = {
      ...unsigned,
      signature: signProbePackManifest(unsigned, {
        authorId: AUTHOR_ID,
        privateKeyPem,
        at: "2026-01-01T00:00:00.000Z",
      }),
    }
  }
  await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
}

let savedCwd: string | undefined
afterEach(() => {
  if (savedCwd) {
    process.chdir(savedCwd)
    savedCwd = undefined
  }
})

describe("lodestar harness verify-on-load", () => {
  test("rejects an unsigned path-based pack without --allow-unsigned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-unsigned-"))
    await makePack(dir)
    expect(await harnessCommand(["list", "--pack", dir])).toBe(2)
  })

  test("loads an unsigned path-based pack with --allow-unsigned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-unsigned-ok-"))
    await makePack(dir)
    expect(await harnessCommand(["list", "--pack", dir, "--allow-unsigned"])).toBe(0)
  })

  test("does NOT auto-trust an unsigned bare-name pack resolved via the cwd fallback", async () => {
    // The exact Codex finding: `--pack acme` where ./packs/acme exists but is NOT
    // bundled with the CLI must still require an explicit opt-out.
    const root = await mkdtemp(join(tmpdir(), "lodestar-cli-cwd-"))
    await makePack(join(root, "packs", "acme"))
    savedCwd = process.cwd()
    process.chdir(root)
    expect(await harnessCommand(["list", "--pack", "acme"])).toBe(2)
    expect(await harnessCommand(["list", "--pack", "acme", "--allow-unsigned"])).toBe(0)
  })

  test("rejects a signed pack when its author key is not pinned", async () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-signed-nopin-"))
    await makePack(dir, privateKeyPem)
    expect(await harnessCommand(["list", "--pack", dir])).toBe(2)
  })

  test("loads a signed pack when its author key is pinned via --author-key", async () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-signed-"))
    await makePack(dir, privateKeyPem)
    const keyPath = join(dir, "author.pub")
    await writeFile(keyPath, publicKeyPem)
    expect(
      await harnessCommand(["list", "--pack", dir, "--author-key", `${AUTHOR_ID}=${keyPath}`]),
    ).toBe(0)
  })

  test("rejects a malformed --author-key spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-badkey-"))
    await makePack(dir)
    expect(await harnessCommand(["list", "--pack", dir, "--author-key", "no-equals-sign"])).toBe(2)
  })
})
