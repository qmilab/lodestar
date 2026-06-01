import { realpath, stat } from "node:fs/promises"
import { basename, extname, relative, resolve, sep } from "node:path"
import { type Tool, registerTool } from "@qmilab/lodestar-action-kernel"
import { registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import { readBoundedUtf8 } from "./read-bounded.js"

/**
 * doc.read — read a file's contents for documentation-claim extraction.
 *
 * Trust: L0 (observation only).
 * Sandbox: read.
 *
 * The difference from `fs.read` is the output schema and intent. `fs.read`
 * emits an `fs.read@1` observation whose only downstream claim is "the file
 * exists with size N". `doc.read` emits a `documentation.source@1`
 * observation tagged with a `kind` so the cognitive core's
 * `DocumentationExtractor` can read *into* the bytes and emit content
 * claims ("package depends on X", "function `f` takes (a, b)", …).
 *
 * Security: same project-root containment as `fs.read` — paths that escape
 * the root are rejected.
 */

export const DocumentationSourceOutputSchema = z
  .object({
    path: z.string(),
    kind: z.enum(["package_json", "markdown", "source"]),
    contents: z.string(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .describe("doc.read tool output")

// Register the output schema with the global registry so the action kernel
// can validate the tool's output. Kept in sync with
// `DocumentationSourcePayload` in `@qmilab/lodestar-cognitive-core`.
registry.register("documentation.source@1", DocumentationSourceOutputSchema)

const DocReadInputSchema = z.object({
  path: z.string().describe("relative path under project root"),
  max_bytes: z.number().int().positive().optional(),
})

const DEFAULT_MAX_BYTES = 1024 * 1024

/** Classify how the bytes should be interpreted for claim extraction. */
function classifyKind(path: string): "package_json" | "markdown" | "source" {
  if (basename(path) === "package.json") return "package_json"
  const ext = extname(path).toLowerCase()
  if (ext === ".md" || ext === ".markdown") return "markdown"
  return "source"
}

/**
 * Construct a doc.read tool bound to a project root. Mirrors
 * {@link makeFsReadTool} but emits a `documentation.source@1` observation.
 */
export function makeDocReadTool(
  projectRoot: string,
): Tool<z.infer<typeof DocReadInputSchema>, z.infer<typeof DocumentationSourceOutputSchema>> {
  const root = resolve(projectRoot)
  return {
    name: "doc.read",
    inputs: DocReadInputSchema,
    output_schema_key: "documentation.source@1",
    effects: [],
    reversibility: "reversible",
    permissions: ["fs.read"],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: () => [],
    execute: async (inputs) => {
      const requested = resolve(root, inputs.path)
      // Security (lexical): refuse paths that escape the project root.
      const rel = relative(root, requested)
      if (rel.startsWith("..") || resolve(root, rel) !== requested) {
        throw new Error(`doc.read: path '${inputs.path}' escapes project root`)
      }
      // Security (symlink): resolve symlinks and confirm the real target is
      // still inside the real root. A symlink under the root must not be
      // able to redirect the read outside it — the lexical check above
      // cannot see through symlinks.
      const realRoot = await realpath(root)
      const realTarget = await realpath(requested)
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        throw new Error(`doc.read: path '${inputs.path}' resolves outside project root`)
      }

      const st = await stat(realTarget)
      if (!st.isFile()) {
        throw new Error(`doc.read: '${inputs.path}' is not a regular file`)
      }

      const maxBytes = inputs.max_bytes ?? DEFAULT_MAX_BYTES
      const bytes = st.size
      const { contents, truncated } = await readBoundedUtf8(realTarget, bytes, maxBytes)

      return { path: inputs.path, kind: classifyKind(inputs.path), contents, bytes, truncated }
    },
  }
}

/** Convenience: register doc.read with a given project root. */
export function registerDocReadTool(projectRoot: string): void {
  registerTool(makeDocReadTool(projectRoot))
}
