import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ProbePackManifest,
  generateEd25519KeyPair,
  lookupPinnedKey,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { mergePinnedAuthorKeys, packCommand, parseSourceArg } from "./pack.js"

/** Capture process.std{out,err}.write for the duration of `fn`. */
async function captureStdio(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const sink = ((chunk: unknown) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stdout.write = sink
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    const code = await fn()
    return { code, out: out.join("") }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

/**
 * `lodestar pack` argument + key-merge logic. These pin the Codex review fix: a
 * `--author-key` flag must override a stale trust-config entry for the same author
 * (key rotation), and the source parser must hold the immutable-pin contract.
 */

describe("pack keygen flag validation", () => {
  test("--out with no value errors (exit 2) and never prints the private key", async () => {
    // The footgun: a missing --out value must not fall through to the stdout path,
    // which would print the freshly generated PRIVATE key.
    const { code, out } = await captureStdio(() =>
      packCommand(["keygen", "--author", "acme", "--out"]),
    )
    expect(code).toBe(2)
    expect(out).not.toContain("PRIVATE KEY")
    expect(out).not.toContain("BEGIN")
  })

  test("--out swallowing the next flag errors rather than consuming it", async () => {
    const { code, out } = await captureStdio(() =>
      packCommand(["keygen", "--out", "--author", "acme"]),
    )
    expect(code).toBe(2)
    expect(out).not.toContain("PRIVATE KEY")
  })

  test("exactly one of --author / --attester is required", async () => {
    const neither = await captureStdio(() => packCommand(["keygen"]))
    expect(neither.code).toBe(2)
    const both = await captureStdio(() =>
      packCommand(["keygen", "--author", "a", "--attester", "b"]),
    )
    expect(both.code).toBe(2)
  })

  test("--attester mints a badge key pinned under attester_keys (ADR-0020)", async () => {
    const { code, out } = await captureStdio(() => packCommand(["keygen", "--attester", "scanner"]))
    expect(code).toBe(0)
    expect(out).toContain("attester_keys")
    expect(out).toContain("attester_id")
    expect(out).toContain("pack attest")
    // The author pin shape must NOT be what's printed for an attester key.
    expect(out).not.toContain('"actor_id"')
  })
})

describe("mergePinnedAuthorKeys", () => {
  test("a flag key overrides a config entry for the same author", () => {
    const config = [{ actor_id: "acme", public_key: "CONFIG-KEY" }]
    const flags = [{ actor_id: "acme", public_key: "FLAG-KEY" }]
    const merged = mergePinnedAuthorKeys(config, flags)
    // lookupPinnedKey returns the first match for an author_id; the flag must win.
    expect(lookupPinnedKey(merged, "acme")).toBe("FLAG-KEY")
  })

  test("distinct authors from config and flags both resolve", () => {
    const merged = mergePinnedAuthorKeys(
      [{ actor_id: "alice", public_key: "ALICE" }],
      [{ actor_id: "bob", public_key: "BOB" }],
    )
    expect(lookupPinnedKey(merged, "alice")).toBe("ALICE")
    expect(lookupPinnedKey(merged, "bob")).toBe("BOB")
  })
})

describe("parseSourceArg", () => {
  test("npm needs a version and an integrity hash", () => {
    expect(parseSourceArg("npm:@acme/foo", {})).toHaveProperty("error")
    expect(parseSourceArg("npm:@acme/foo@1.2.3", {})).toHaveProperty("error") // missing integrity
    const ok = parseSourceArg("npm:@acme/foo@1.2.3", { integrity: "sha512-abc" })
    expect(ok).toEqual({
      ref: { type: "npm", package: "@acme/foo", version: "1.2.3", integrity: "sha512-abc" },
    })
  })

  test("npm carries an optional registry", () => {
    const ok = parseSourceArg("npm:foo@1.0.0", {
      integrity: "sha512-x",
      registry: "https://r.example.com",
    })
    expect(ok).toEqual({
      ref: {
        type: "npm",
        package: "foo",
        version: "1.0.0",
        integrity: "sha512-x",
        registry: "https://r.example.com",
      },
    })
  })

  test("git pins the commit in the fragment", () => {
    const sha = "a".repeat(40)
    expect(parseSourceArg(`git:https://x/y.git#${sha}`, {})).toEqual({
      ref: { type: "git", url: "https://x/y.git", commit: sha },
    })
    // No fragment → error (a mutable ref is rejected downstream, but a missing one
    // is a parse error here).
    expect(parseSourceArg("git:https://x/y.git", {})).toHaveProperty("error")
  })

  test("local accepts a prefixed or bare path", () => {
    const a = parseSourceArg("local:./p", {})
    const b = parseSourceArg("./p", {})
    expect(a).toHaveProperty("ref")
    expect(b).toHaveProperty("ref")
    if ("ref" in a && "ref" in b) {
      expect(a.ref.type).toBe("local")
      expect(b.ref.type).toBe("local")
      // Both resolve the same relative path to the same absolute one.
      expect(a.ref).toEqual(b.ref)
    }
  })
})

/**
 * `pack attest --kind probe_results` must forward the operator's `--allow-env`
 * allowlist into the probe run (Codex P2). The runner spawns probes under a
 * scoped env (#114, ADR-0022), so without the thread-through an env-gated probe
 * would skip/fail and the badge would attest a degraded run. The probe below
 * passes ONLY when the sentinel var reaches it, so the attest summary's
 * pass/fail count is a direct read of whether `--allow-env` was honoured.
 */
describe("pack attest --allow-env (Codex P2 — env reaches the attest run)", () => {
  const AUTHOR_ID = "env-author"
  const ENV_VAR = "LODESTAR_ATTEST_ENV_TEST"
  const SENTINEL = "attest-sentinel-value"
  // Exits 0 iff the sentinel var was forwarded into the scoped probe env.
  const PROBE_BODY = `process.exit(process.env.${ENV_VAR} === ${JSON.stringify(SENTINEL)} ? 0 : 1)\n`

  /** Materialise a signed, badgeable pack with the single env-gated probe. */
  async function makeSignedPack(): Promise<{ dir: string; authorPubPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-attest-env-"))
    await writeFile(join(dir, "probe.ts"), PROBE_BODY)
    const unsigned: ProbePackManifest = {
      name: "env-attest-pack",
      version: "0.0.0",
      spec_version: "1",
      source_type: "local",
      coverage_areas: ["t"],
      invariants: ["t"],
      probes: [{ name: "env-probe", file: "probe.ts" }],
      author_id: AUTHOR_ID,
      content_digest: {
        algorithm: "sha256",
        files: [
          { path: "probe.ts", sha256: createHash("sha256").update(PROBE_BODY).digest("hex") },
        ],
      },
    }
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const manifest: ProbePackManifest = {
      ...unsigned,
      signature: signProbePackManifest(unsigned, {
        authorId: AUTHOR_ID,
        privateKeyPem,
        at: "2026-01-01T00:00:00.000Z",
      }),
    }
    await writeFile(join(dir, "lodestar.probe-pack.json"), JSON.stringify(manifest, null, 2))
    const authorPubPath = join(dir, "author.pub")
    await writeFile(authorPubPath, publicKeyPem)
    return { dir, authorPubPath }
  }

  /** Write an attester private key to a file and return its path. */
  async function makeAttesterKey(dir: string): Promise<string> {
    const { privateKeyPem } = generateEd25519KeyPair()
    const keyPath = join(dir, "attester.key")
    await writeFile(keyPath, privateKeyPem)
    return keyPath
  }

  test("forwards the var so an env-gated probe runs for real (pass) — and omitting it fails", async () => {
    const { dir, authorPubPath } = await makeSignedPack()
    const keyDir = await mkdtemp(join(tmpdir(), "lodestar-attest-key-"))
    const attesterKeyPath = await makeAttesterKey(keyDir)
    process.env[ENV_VAR] = SENTINEL
    try {
      const base = [
        "attest",
        "--pack",
        dir,
        "--kind",
        "probe_results",
        "--attester",
        "scan-bot",
        "--key",
        attesterKeyPath,
        "--author-key",
        `${AUTHOR_ID}=${authorPubPath}`,
      ]

      // WITH --allow-env: the sentinel reaches the probe → it passes.
      const withFlag = await captureStdio(() => packCommand([...base, "--allow-env", ENV_VAR]))
      expect(withFlag.code).toBe(0)
      expect(withFlag.out).toContain("1 passed, 0 failed")

      // WITHOUT --allow-env: the scoped env withholds the var → the probe fails,
      // proving the flag (not host inheritance) is what delivered it.
      const withoutFlag = await captureStdio(() => packCommand(base))
      expect(withoutFlag.out).toContain("0 passed, 1 failed")
    } finally {
      delete process.env[ENV_VAR]
      await rm(dir, { recursive: true, force: true })
      await rm(keyDir, { recursive: true, force: true })
    }
  })

  test("--allow-env with no value is a usage error (exit 2)", async () => {
    const { code } = await captureStdio(() =>
      packCommand(["attest", "--kind", "probe_results", "--attester", "x", "--allow-env"]),
    )
    expect(code).toBe(2)
  })
})
