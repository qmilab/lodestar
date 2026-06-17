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
import { detectSandboxMechanism } from "@qmilab/lodestar-harness"
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

  test("auto-loads a genuine bundled first-party pack unsigned (source mode)", async () => {
    // lodestar-core is in the first-party allowlist and resolves via the walk-up
    // anchored at the CLI source, so `list` succeeds without --allow-unsigned —
    // the quickstart must keep working from the repo source tree.
    expect(await harnessCommand(["list", "--pack", "lodestar-core"])).toBe(0)
  })

  test("does NOT auto-trust an arbitrarily-named bare pack via the cwd fallback", async () => {
    // The Codex finding: `--pack acme` where ./packs/acme exists but is NOT a
    // bundled first-party pack must still require an explicit opt-out — neither
    // bare-name syntax nor a coincidental cwd resolution grants trust.
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

describe("lodestar harness run --allow-env (#114, ADR-0022)", () => {
  test("accepts a repeatable --allow-env and runs the pack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-allowenv-"))
    await makePack(dir)
    // The noop probe exits 0; we only assert the flag parses and the run succeeds.
    expect(
      await harnessCommand([
        "run",
        "--pack",
        dir,
        "--allow-unsigned",
        "--no-record",
        "--allow-env",
        "LODESTAR_TEST_DATABASE_URL",
        "--allow-env",
        "TZ",
      ]),
    ).toBe(0)
  })

  test("rejects --allow-env with no value (usage error)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-allowenv-bad-"))
    await makePack(dir)
    expect(
      await harnessCommand([
        "run",
        "--pack",
        dir,
        "--allow-unsigned",
        "--no-record",
        "--allow-env",
      ]),
    ).toBe(2)
  })
})

describe("lodestar harness run --sandbox flags (#121, ADR-0023)", () => {
  const HAS_SANDBOX = detectSandboxMechanism() !== null

  test("--no-sandbox runs an external pack without a sandbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-nosbx-"))
    await makePack(dir)
    expect(
      await harnessCommand([
        "run",
        "--pack",
        dir,
        "--allow-unsigned",
        "--no-record",
        "--no-sandbox",
      ]),
    ).toBe(0)
  })

  test("--allow-read with no value is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-allowread-bad-"))
    await makePack(dir)
    expect(
      await harnessCommand([
        "run",
        "--pack",
        dir,
        "--allow-unsigned",
        "--no-record",
        "--no-sandbox",
        "--allow-read",
      ]),
    ).toBe(2)
  })

  // An external pack defaults to sandbox ON; these need a real mechanism.
  const sbxTest = HAS_SANDBOX ? test : test.skip
  sbxTest(
    "sandboxes an external pack by default (accepts --allow-read + an IP --allow-host)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-sbx-"))
      await makePack(dir)
      expect(
        await harnessCommand([
          "run",
          "--pack",
          dir,
          "--allow-unsigned",
          "--no-record",
          "--allow-read",
          dir,
          "--allow-host",
          "10.0.0.5:5432", // an IP literal — expressible on both platforms
        ]),
      ).toBe(0)
    },
  )

  // Codex P2: a bundled pack addressed BY PATH must also default to NO sandbox
  // (the default is keyed on the genuine-bundled signal, not the path-strict
  // trust flag). If it regressed to sandbox-on, the first-party probes (which
  // import repo packages) would fail — exit 1 with a mechanism, exit 2 without.
  // So exit 0 proves the bundled-by-path default-off on every platform.
  test("a bundled pack addressed by PATH defaults to NO sandbox", async () => {
    const bundledPath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "packs",
      "coding-agent-safety",
    )
    expect(
      await harnessCommand(["run", "--pack", bundledPath, "--no-record", "--allow-unsigned"]),
    ).toBe(0)
  })

  // The mirror: where no mechanism exists, the default-on path must fail closed.
  const noSbxTest = HAS_SANDBOX ? test.skip : test
  noSbxTest("fails closed for an external pack when no mechanism is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-failclosed-"))
    await makePack(dir)
    expect(await harnessCommand(["run", "--pack", dir, "--allow-unsigned", "--no-record"])).toBe(2)
  })

  // macOS SBPL cannot express a hostname --allow-host; it must be REJECTED rather
  // than silently widened to all-egress (the Codex P1). Only meaningful on macOS.
  const macosTest = HAS_SANDBOX && process.platform === "darwin" ? test : test.skip
  macosTest("rejects a hostname --allow-host on macOS (no all-egress widening)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-cli-badhost-"))
    await makePack(dir)
    expect(
      await harnessCommand([
        "run",
        "--pack",
        dir,
        "--allow-unsigned",
        "--no-record",
        "--allow-host",
        "evil.example.com", // a bare hostname — unexpressible, must fail closed
      ]),
    ).toBe(2)
  })
})
