import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  confineLexically,
  confineReadTarget,
  confineToRoot,
  confineWriteTarget,
} from "./confine.js"

const CTX = { tool: "probe.tool", rootLabel: "test root" }

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "lodestar-confine-"))
}

test("lexical: rejects .. and outside absolute paths; allowRoot gates the root itself", () => {
  const root = tmpRoot()
  try {
    const cr = confineToRoot(root)
    expect(() => confineLexically(cr, "../x", CTX)).toThrow(/escapes test root/)
    expect(() => confineLexically(cr, "/etc/passwd", CTX)).toThrow(/escapes test root/)
    expect(() => confineLexically(cr, ".", CTX)).toThrow(/escapes test root/)
    expect(confineLexically(cr, ".", { ...CTX, allowRoot: true })).toBe(cr.root)
    expect(confineLexically(cr, "a/b.txt", CTX)).toBe(join(cr.root, "a/b.txt"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("read: a symlink under the root pointing outside is refused", async () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  try {
    const cr = confineToRoot(root)
    writeFileSync(join(outside, "secret.txt"), "outside")
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"))
    await expect(confineReadTarget(cr, "leak.txt", CTX)).rejects.toThrow(
      /resolves outside test root/,
    )
    writeFileSync(join(root, "ok.txt"), "inside")
    expect(await confineReadTarget(cr, "ok.txt", CTX)).toBe(join(realpathSync(root), "ok.txt"))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("write: deepest-existing-ancestor walk catches a symlinked directory and reports missing parents", async () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  try {
    const cr = confineToRoot(root)
    symlinkSync(outside, join(root, "sneaky"))
    await expect(confineWriteTarget(cr, "sneaky/deep/x.txt", CTX)).rejects.toThrow(
      /resolves outside test root/,
    )
    const direct = await confineWriteTarget(cr, "x.txt", CTX)
    expect(direct.parentMissing).toBe(false)
    expect(direct.realTarget).toBe(join(realpathSync(root), "x.txt"))
    const nested = await confineWriteTarget(cr, "a/b/x.txt", CTX)
    expect(nested.parentMissing).toBe(true)
    expect(nested.realTarget).toBe(join(realpathSync(root), "a/b/x.txt"))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("realRoot is memoized on success, not on failure", async () => {
  const parent = tmpRoot()
  const lateRoot = join(parent, "late")
  try {
    const cr = confineToRoot(lateRoot)
    // Root does not exist yet: the failure must not be cached.
    await expect(cr.realRoot()).rejects.toThrow()
    mkdirSync(lateRoot, { recursive: true })
    expect(await cr.realRoot()).toBe(realpathSync(lateRoot))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
