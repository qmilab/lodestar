import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBoundedUtf8 } from "./read-bounded.js"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lodestar-read-bounded-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("returns the whole file when it is within the cap", async () => {
  const p = join(dir, "small.txt")
  writeFileSync(p, "hello")
  const { contents, truncated } = await readBoundedUtf8(p, 5, 1024)
  expect(contents).toBe("hello")
  expect(truncated).toBe(false)
})

test("caps an ASCII file at maxBytes", async () => {
  const p = join(dir, "ascii.txt")
  writeFileSync(p, "abcdefghij") // 10 bytes
  const { contents, truncated } = await readBoundedUtf8(p, 10, 4)
  expect(contents).toBe("abcd")
  expect(truncated).toBe(true)
})

test("caps by BYTES, not UTF-16 code units, for multibyte content", async () => {
  const p = join(dir, "multibyte.txt")
  const body = "é".repeat(10) // 20 bytes (2 each), but only 10 UTF-16 code units
  writeFileSync(p, body)
  const fileSize = Buffer.byteLength(body, "utf8")
  expect(fileSize).toBe(20)

  const { contents, truncated } = await readBoundedUtf8(p, fileSize, 5)
  expect(truncated).toBe(true)
  // A 5-byte cap can hold at most two whole "é" (2 bytes each). The old
  // `readFile` + `String.slice(5)` path counted UTF-16 units, so it would
  // have emitted five "é" — 10 bytes, double the requested cap.
  const eAcuteCount = (contents.match(/é/g) ?? []).length
  expect(eAcuteCount).toBeLessThanOrEqual(2)
})

test("handles an empty file", async () => {
  const p = join(dir, "empty.txt")
  writeFileSync(p, "")
  const { contents, truncated } = await readBoundedUtf8(p, 0, 1024)
  expect(contents).toBe("")
  expect(truncated).toBe(false)
})
