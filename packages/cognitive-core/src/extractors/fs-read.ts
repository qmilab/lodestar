import type { Claim } from "@orrery/core"
import type { ClaimExtractor, ExtractionInput } from "./base"

/**
 * Schema-bound extractor for fs.read@1 observations.
 *
 * Produces one claim per read: "file X exists at size N bytes."
 *
 * The file *contents* are NOT extracted as claims at this stage.
 * Content-derived claims come from downstream extractors that consume
 * the read content (e.g. a JSON-schema extractor, a markdown-summary
 * extractor). This separation keeps the file-existence claim independent
 * of any interpretation of the bytes inside.
 */
export const FsReadExtractor: ClaimExtractor = {
  schema_key: "fs.read@1",
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = obs.payload as {
      path: string
      bytes: number
      contents: string
      truncated: boolean
    }
    const now = new Date().toISOString()
    const ctx = input.context

    return [
      {
        id: crypto.randomUUID(),
        statement: `File '${payload.path}' exists with size ${payload.bytes} bytes${payload.truncated ? " (read truncated)" : ""}`,
        structured_predicate: {
          subject: `file:${payload.path}`,
          relation: "exists_with_size",
          object: payload.bytes,
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      },
    ]
  },
}
