import { writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { type Tool, registerTool } from "@qmilab/lodestar-action-kernel"
import { registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * doc.write — overwrite a file under a hard-scoped writable root.
 *
 * Example-local on purpose: a general-purpose `fs.write` adapter needs a
 * fuller sandbox/reversibility story (a follow-up). This tool is bound to
 * the example's `workspace/` directory and rejects any path that escapes
 * it, so the demo can perform a real, governed mutation without risk to
 * the rest of the repo.
 *
 * Trust: L1 (write-local). Reversibility: compensable (the prior contents
 * can be restored). It flows through the kernel's two-phase
 * propose → arbitrate → execute path like any other action.
 */

export const DocWriteOutputSchema = z
  .object({
    path: z.string(),
    bytes_written: z.number().int().nonnegative(),
  })
  .describe("doc.write tool output")

registry.register("doc.write@1", DocWriteOutputSchema)

const DocWriteInputSchema = z.object({
  path: z.string().describe("relative path under the writable root"),
  contents: z.string(),
})

export function makeDocWriteTool(
  writableRoot: string,
): Tool<z.infer<typeof DocWriteInputSchema>, z.infer<typeof DocWriteOutputSchema>> {
  const root = resolve(writableRoot)
  return {
    name: "doc.write",
    inputs: DocWriteInputSchema,
    output_schema_key: "doc.write@1",
    effects: [
      {
        kind: "world_state_change",
        description: "overwrites a documentation file on disk",
        scope_hint: root,
      },
    ],
    reversibility: "compensable",
    permissions: ["fs.write"],
    required_trust_level: 1,
    sandbox: "write-local",
    preconditions: () => [],
    execute: async (inputs) => {
      const fullPath = resolve(root, inputs.path)
      // Security: refuse paths outside the writable root.
      const rel = relative(root, fullPath)
      if (rel.startsWith("..") || resolve(root, rel) !== fullPath) {
        throw new Error(`doc.write: path '${inputs.path}' escapes writable root`)
      }
      await writeFile(fullPath, inputs.contents, "utf8")
      return { path: inputs.path, bytes_written: Buffer.byteLength(inputs.contents, "utf8") }
    },
  }
}

export function registerDocWriteTool(writableRoot: string): void {
  registerTool(makeDocWriteTool(writableRoot))
}
