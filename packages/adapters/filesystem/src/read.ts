import { readFile, stat } from "node:fs/promises"
import { resolve, relative } from "node:path"
import { z } from "zod"
import { registry } from "@orrery/core"
import { registerTool, type Tool } from "@orrery/action-kernel"

/**
 * fs.read — read a file's contents.
 *
 * Trust: L0 (observation only).
 * Sandbox: read.
 *
 * Security: the path is resolved against a project root provided at
 * construction time. Paths that escape the root are rejected.
 */

export const FsReadOutputSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  contents: z.string(),
  truncated: z.boolean(),
}).describe("fs.read tool output")

// Register the output schema with the global registry.
// This is what the action kernel uses to validate tool outputs.
registry.register("fs.read@1", FsReadOutputSchema)

const FsReadInputSchema = z.object({
  path: z.string().describe("relative path under project root"),
  max_bytes: z.number().int().positive().optional(),
})

const DEFAULT_MAX_BYTES = 1024 * 1024

/**
 * Construct an fs.read tool bound to a project root.
 * The same tool implementation can be registered for different
 * project roots in the future via a per-session adapter pattern.
 */
export function makeFsReadTool(projectRoot: string): Tool<z.infer<typeof FsReadInputSchema>, z.infer<typeof FsReadOutputSchema>> {
  const root = resolve(projectRoot)
  return {
    name: "fs.read",
    inputs: FsReadInputSchema,
    output_schema_key: "fs.read@1",
    effects: [],
    reversibility: "reversible",
    permissions: ["fs.read"],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: () => [],
    execute: async (inputs) => {
      const fullPath = resolve(root, inputs.path)
      // Security: refuse paths outside the project root
      const rel = relative(root, fullPath)
      if (rel.startsWith("..") || resolve(root, rel) !== fullPath) {
        throw new Error(`fs.read: path '${inputs.path}' escapes project root`)
      }

      const st = await stat(fullPath)
      if (!st.isFile()) {
        throw new Error(`fs.read: '${inputs.path}' is not a regular file`)
      }

      const maxBytes = inputs.max_bytes ?? DEFAULT_MAX_BYTES
      const bytes = st.size
      const raw = await readFile(fullPath, "utf8")
      const truncated = bytes > maxBytes
      const contents = truncated ? raw.slice(0, maxBytes) : raw

      return { path: inputs.path, bytes, contents, truncated }
    },
  }
}

/**
 * Convenience: register fs.read with a given project root.
 */
export function registerFsReadTool(projectRoot: string): void {
  registerTool(makeFsReadTool(projectRoot))
}
