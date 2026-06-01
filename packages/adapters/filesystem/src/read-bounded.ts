import { open } from "node:fs/promises"

/**
 * Read at most `maxBytes` *bytes* from `absolutePath`, then UTF-8 decode.
 *
 * Reading a bounded buffer — rather than slurping the whole file with
 * `readFile` and then `String.slice(maxBytes)` — enforces `max_bytes` as a
 * real byte cap two ways:
 *
 *  - It never loads more than the requested bytes into memory, so a huge
 *    file cannot blow the heap just to be truncated afterwards.
 *  - `String.slice` counts UTF-16 code units, not bytes, so on multibyte
 *    content it can emit far more bytes than requested. A byte-bounded read
 *    cannot; a multibyte character straddling the boundary is simply cut at
 *    the byte limit (its trailing bytes decode to the replacement char).
 *
 * `fileSize` is the stat'd size, used to decide whether truncation happened
 * without a second filesystem round-trip.
 */
export async function readBoundedUtf8(
  absolutePath: string,
  fileSize: number,
  maxBytes: number,
): Promise<{ contents: string; truncated: boolean }> {
  const truncated = fileSize > maxBytes
  const toRead = truncated ? maxBytes : fileSize
  const handle = await open(absolutePath, "r")
  try {
    if (toRead <= 0) return { contents: "", truncated }
    const buffer = Buffer.alloc(toRead)
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0)
    return { contents: buffer.subarray(0, bytesRead).toString("utf8"), truncated }
  } finally {
    await handle.close()
  }
}
