import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@qmilab/lodestar-action-kernel"
import { makeFsWriteTool } from "./write.js"

// Mechanism-level tests: the tool's execute() is exercised directly. The
// adversarial end-to-end invariants (two-phase hold, TOCTOU revalidation,
// trust floor) are locked by the harness probe
// packs/lodestar-core/probes/filesystem-adapter-enforces-write-invariants.ts.

const ctx: ToolContext = {
  session_id: "test-session",
  project_id: "test-project",
  actor_id: "test-actor",
  capabilities: new Map(),
}

let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lodestar-fswrite-root-"))
  outside = mkdtempSync(join(tmpdir(), "lodestar-fswrite-outside-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("writes a new file and reports created=true / previous_bytes=null", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  const out = await tool.execute({ path: "notes.md", contents: "hello" }, ctx)
  expect(out).toEqual({ path: "notes.md", bytes_written: 5, created: true, previous_bytes: null })
  expect(existsSync(join(root, "notes.md"))).toBe(true)
})

test("overwrite reports created=false and the replaced size", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  writeFileSync(join(root, "notes.md"), "previous contents")
  const out = await tool.execute({ path: "notes.md", contents: "new" }, ctx)
  expect(out.created).toBe(false)
  expect(out.previous_bytes).toBe(17)
})

test("rejects .. traversal out of the root", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  await expect(tool.execute({ path: "../escape.txt", contents: "x" }, ctx)).rejects.toThrow(
    /escapes writable root/,
  )
})

test("rejects an absolute path outside the root", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  await expect(
    tool.execute({ path: join(outside, "abs-escape.txt"), contents: "x" }, ctx),
  ).rejects.toThrow(/escapes writable root/)
})

test("rejects writing to the root itself", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  await expect(tool.execute({ path: ".", contents: "x" }, ctx)).rejects.toThrow(
    /escapes writable root/,
  )
})

test("rejects a write through a symlinked directory pointing outside the root", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  symlinkSync(outside, join(root, "sneaky"))
  await expect(tool.execute({ path: "sneaky/inner.txt", contents: "x" }, ctx)).rejects.toThrow(
    /resolves outside writable root/,
  )
  expect(existsSync(join(outside, "inner.txt"))).toBe(false)
})

test("refuses a destination that is itself a symlink", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  const target = join(outside, "target.txt")
  writeFileSync(target, "untouched")
  symlinkSync(target, join(root, "alias.txt"))
  await expect(tool.execute({ path: "alias.txt", contents: "x" }, ctx)).rejects.toThrow(
    /is a symlink; refusing/,
  )
})

test("missing parent fails without createDirs, succeeds with it (confined)", async () => {
  const strict = makeFsWriteTool({ writableRoot: root })
  await expect(strict.execute({ path: "a/b/c.txt", contents: "x" }, ctx)).rejects.toThrow(
    /parent directory .* does not exist/,
  )
  const lenient = makeFsWriteTool({ writableRoot: root, createDirs: true })
  const out = await lenient.execute({ path: "a/b/c.txt", contents: "x" }, ctx)
  expect(out.created).toBe(true)
  expect(existsSync(join(root, "a", "b", "c.txt"))).toBe(true)
})

test("createDirs cannot escape through a symlinked ancestor", async () => {
  const tool = makeFsWriteTool({ writableRoot: root, createDirs: true })
  symlinkSync(outside, join(root, "sneaky"))
  await expect(tool.execute({ path: "sneaky/deep/inner.txt", contents: "x" }, ctx)).rejects.toThrow(
    /resolves outside writable root/,
  )
  expect(existsSync(join(outside, "deep"))).toBe(false)
})

test("rejects contents over the byte cap without touching disk", async () => {
  const tool = makeFsWriteTool({ writableRoot: root, maxBytes: 16 })
  await expect(tool.execute({ path: "big.txt", contents: "x".repeat(17) }, ctx)).rejects.toThrow(
    /exceed the 16-byte cap/,
  )
  expect(existsSync(join(root, "big.txt"))).toBe(false)
})

test("does not expand ~ or $VAR — paths are literal", async () => {
  const tool = makeFsWriteTool({ writableRoot: root, createDirs: true })
  const out = await tool.execute({ path: "$HOME/literal.txt", contents: "x" }, ctx)
  expect(out.created).toBe(true)
  // The write landed under a directory literally named "$HOME" inside the root.
  expect(existsSync(join(root, "$HOME", "literal.txt"))).toBe(true)
})

test("refuses to clobber a directory", async () => {
  const tool = makeFsWriteTool({ writableRoot: root })
  mkdirSync(join(root, "adir"))
  await expect(tool.execute({ path: "adir", contents: "x" }, ctx)).rejects.toThrow(
    /exists and is not a regular file/,
  )
})
