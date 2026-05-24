import type { Claim, Observation, ResourceScope, Sensitivity } from "@qmilab/lodestar-core"

/**
 * An extractor consumes an Observation and produces zero or more Claims.
 *
 * Two flavours:
 * - Schema-bound: registered against a specific observation schema key
 *   (e.g. "git.status@1"); deterministic; no LLM call.
 * - Generic LLM-driven: applies when no schema-bound extractor matches;
 *   uses prompting against the observation payload.
 *
 * Schema-bound extractors are preferred when available because they are
 * deterministic, cheap, and replay-stable. LLM extractors are a fallback.
 */
export interface ClaimExtractor {
  /**
   * The observation schema key this extractor handles, or "__generic__"
   * for the LLM-driven fallback.
   */
  schema_key: string

  /**
   * Extract claims from a single observation. The extractor may emit
   * multiple claims (e.g. a git.status observation may yield separate
   * claims about branch identity and dirty-file count).
   *
   * The extractor receives the observation and a context describing
   * the actor making the extraction and the scope to apply.
   */
  extract(input: ExtractionInput): Promise<Claim[]>
}

export interface ExtractionInput {
  observation: Observation
  context: {
    actor_id: string
    project_id: string
    session_id: string
    default_scope: ResourceScope
    default_sensitivity: Sensitivity
  }
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const extractors = new Map<string, ClaimExtractor>()

export function registerExtractor(extractor: ClaimExtractor): void {
  if (extractors.has(extractor.schema_key)) {
    throw new Error(`Extractor registry: schema_key '${extractor.schema_key}' already registered`)
  }
  extractors.set(extractor.schema_key, extractor)
}

export function lookupExtractor(schema_key: string): ClaimExtractor | undefined {
  return extractors.get(schema_key) ?? extractors.get("__generic__")
}

export function _resetExtractorsForTests(): void {
  extractors.clear()
}
