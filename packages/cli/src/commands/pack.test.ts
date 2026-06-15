import { describe, expect, test } from "bun:test"
import { lookupPinnedKey } from "@qmilab/lodestar-core"
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
