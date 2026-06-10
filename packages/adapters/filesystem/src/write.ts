import type { Stats } from "node:fs"
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { type Tool, registerTool } from "@qmilab/lodestar-action-kernel"
import { registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * fs.write — write a file under a hard-scoped writable root.
 *
 * Graduates the example-local `doc.write` from `examples/documentation-agent/`
 * into the reusable filesystem adapter (issue #79, ADR-0012). This is a
 * TS-level governance boundary, not an OS sandbox. It enforces, in-process:
 *
 *   - **Path confinement under the scoped root.** The destination is resolved
 *     against a `writableRoot` fixed at construction time. Escapes are refused
 *     lexically (`..`, absolute paths outside the root) AND physically: the
 *     deepest existing ancestor of the destination is `realpath`'d and must
 *     still sit inside the real root, so a symlinked directory inside the root
 *     cannot redirect the write outside it. A destination that is itself a
 *     symlink is refused outright rather than followed.
 *   - **No host-environment passthrough.** There is no subprocess and no shell:
 *     `process.env` is never consulted, and `~` / `$VAR` in paths are literal
 *     characters, never expanded. The root is operator-fixed at construction;
 *     nothing about the write destination can come from the host environment.
 *   - **Bounded write size.** Contents larger than `maxBytes` are REJECTED
 *     before anything touches disk — never silently truncated, because a
 *     truncated write is a corrupted artifact, not a bounded capture.
 *   - **No silent directory creation.** A missing parent directory fails the
 *     write unless the operator opted in via `createDirs`; created directories
 *     are confined exactly like the file itself.
 *
 * Trust: L3 (local reversible — modify project state). Sandbox: write-local.
 * Reversibility: compensable (the prior contents can be restored; the output
 * records `previous_bytes` so an auditor can see what was replaced). The tool
 * flows through the kernel's two-phase propose → arbitrate → execute path —
 * `execute` is the only code path that touches disk, so a held or rejected
 * action writes nothing.
 *
 * What it does NOT claim: OS-level enforcement (namespaces, read-only bind
 * mounts) and filesystem-race (TOCTOU at the syscall level) containment are
 * out of scope, exactly as for the shell/git/http adapters (ADR-0004).
 */

export const FsWriteOutputSchema = z
  .object({
    path: z.string().describe("the relative path that was requested"),
    bytes_written: z.number().int().nonnegative(),
    created: z.boolean().describe("true if the file did not exist before this write"),
    previous_bytes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("size of the file this write replaced; null when the file was created"),
  })
  .describe("fs.write tool output")

// Idempotent: registering the same key twice throws ("bump the version"), but this
// module's registration is a process-global side effect at import time. Guard it so
// a double import (e.g. via both the real path and a workspace self-symlink) is a
// harmless no-op rather than a crash.
if (!registry.has("fs.write@1")) {
  registry.register("fs.write@1", FsWriteOutputSchema)
}

const FsWriteInputSchema = z.object({
  path: z.string().min(1).describe("relative path under the writable root"),
  contents: z.string(),
})

export type FsWriteInput = z.infer<typeof FsWriteInputSchema>
export type FsWriteOutput = z.infer<typeof FsWriteOutputSchema>

const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024 // 1 MiB

export interface FsWriteOptions {
  /** The scoped root every write is confined under. Fixed at construction. */
  writableRoot: string
  /**
   * Maximum contents size in bytes. Oversized writes are REJECTED (the action
   * fails), never truncated. Default 1 MiB.
   */
  maxBytes?: number
  /**
   * Create missing parent directories (inside the root) for the destination.
   * Default false: a missing parent fails the write rather than silently
   * growing the tree.
   */
  createDirs?: boolean
}

/**
 * Construct an fs.write tool bound to a writable root.
 */
export function makeFsWriteTool(options: FsWriteOptions): Tool<FsWriteInput, FsWriteOutput> {
  const root = resolve(options.writableRoot)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_WRITE_BYTES
  const createDirs = options.createDirs ?? false
  return {
    name: "fs.write",
    inputs: FsWriteInputSchema,
    output_schema_key: "fs.write@1",
    effects: [
      {
        kind: "world_state_change",
        description: "writes a file under the scoped writable root",
        scope_hint: root,
      },
    ],
    reversibility: "compensable",
    permissions: ["fs.write"],
    required_trust_level: 3,
    sandbox: "write-local",
    preconditions: () => [],
    execute: async (inputs) => {
      const size = Buffer.byteLength(inputs.contents, "utf8")
      // Bounded write: reject BEFORE touching disk; never truncate.
      if (size > maxBytes) {
        throw new Error(
          `fs.write: contents (${size} bytes) exceed the ${maxBytes}-byte cap; refusing to write`,
        )
      }

      const requested = resolve(root, inputs.path)
      // Security (lexical): refuse paths that escape the writable root,
      // including `..` traversal and absolute paths outside the root.
      const rel = relative(root, requested)
      if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== requested) {
        throw new Error(`fs.write: path '${inputs.path}' escapes writable root`)
      }

      // Security (symlink): the destination (and some of its parents, when
      // `createDirs` is on) may not exist yet, so resolve the deepest EXISTING
      // ancestor's real path and confirm it is still inside the real root.
      // A symlinked directory anywhere in the chain resolves here and is
      // caught — the lexical check above cannot see through symlinks.
      let ancestor = dirname(requested)
      for (;;) {
        try {
          await lstat(ancestor)
          break
        } catch (err) {
          if ((err as { code?: string }).code !== "ENOENT") throw err
          if (ancestor === root) break // root must exist; realpath below will throw if not
          ancestor = dirname(ancestor)
        }
      }
      const realRoot = await realpath(root)
      const realAncestor = await realpath(ancestor)
      if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
        throw new Error(`fs.write: path '${inputs.path}' resolves outside writable root`)
      }
      // The remainder below the verified ancestor is purely lexical (no `..`,
      // already confined above), so re-rooting it on the ancestor's REAL path
      // gives the physical destination.
      const realTarget = join(realAncestor, relative(ancestor, requested))

      if (ancestor !== dirname(requested)) {
        // Some parent directories are missing.
        if (!createDirs) {
          throw new Error(
            `fs.write: parent directory of '${inputs.path}' does not exist (createDirs is off)`,
          )
        }
        await mkdir(dirname(realTarget), { recursive: true })
      }

      // If the destination itself exists, it must be a regular file — refuse
      // to follow a symlink out of the root, and refuse to clobber non-files.
      let st: Stats | undefined
      try {
        st = await lstat(realTarget)
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err
      }
      if (st?.isSymbolicLink()) {
        throw new Error(`fs.write: path '${inputs.path}' is a symlink; refusing to follow it`)
      }
      if (st && !st.isFile()) {
        throw new Error(`fs.write: path '${inputs.path}' exists and is not a regular file`)
      }
      const created = st === undefined
      const previousBytes: number | null = st ? st.size : null

      await writeFile(realTarget, inputs.contents, "utf8")
      return {
        path: inputs.path,
        bytes_written: size,
        created,
        previous_bytes: previousBytes,
      }
    },
  }
}

/**
 * Convenience: register fs.write bound to a writable root.
 */
export function registerFsWriteTool(options: FsWriteOptions): void {
  registerTool(makeFsWriteTool(options))
}
