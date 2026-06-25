import type { Claim, Observation } from "@qmilab/lodestar-core"
import { type ClaimExtractor, type ExtractionInput, GENERIC_EXTRACTOR_SCHEMA_KEY } from "./base.js"

/**
 * A single claim candidate proposed by a {@link GenericExtractionModel}.
 *
 * Deliberately minimal — the same fields the deterministic schema-bound
 * extractors populate. The model returns *what* it inferred; the extractor
 * stamps the provenance (`extraction_method`, `source_observation_ids`,
 * scope, sensitivity, authorship) so a draft can never lie about where it
 * came from.
 */
export interface GenericClaimDraft {
  /** Human-readable claim, e.g. "The deploy step failed on host db-2". */
  statement: string
  /**
   * Optional queryable predicate. Provide it when the claim asserts a
   * `(subject, relation) = object` proposition — that is what makes the
   * claim participate in the cross-belief join, contradiction routing, and
   * the world model. Free-form-only claims (no predicate) are recorded but
   * never joined.
   */
  predicate?: { subject: string; relation: string; object: unknown }
}

/**
 * What the generic extractor asks an LLM to do: read observation text and
 * return claim drafts.
 */
export interface GenericExtractionRequest {
  /** Best-effort plain-text rendering of the observation payload. */
  text: string
  /** The observation's schema key, for prompt context. */
  schema: string
  /** The full observation, for models that want structured access to the payload. */
  observation: Observation
}

/**
 * The provider-agnostic seam the generic extractor calls.
 *
 * Lodestar ships **no** LLM client, key handling, or prompt — those are the
 * consumer's. An implementation makes the actual completion call and returns
 * structured drafts. Keeping the model behind this interface is what lets the
 * extractor stay in `@qmilab/lodestar-cognitive-core` (no network, no SDK, no
 * secrets) and lets a probe drive it with a deterministic stub.
 *
 * The drafts are **non-authoritative**: every claim the extractor mints from
 * them is `extraction_method: "llm"`, and a {@link GenericAwareEvidenceLinker}
 * stamps their source evidence at `model_inference` quality, so the
 * auto-observation (Parallax) gate keeps the resulting belief `unverified`.
 */
export interface GenericExtractionModel {
  extractClaims(input: GenericExtractionRequest): Promise<GenericClaimDraft[]>
}

export interface GenericLLMExtractorOptions {
  /**
   * Cap on claims emitted per observation. A noisy model (or a poisoned
   * observation that coaxes one) must not be able to flood the report /
   * belief store. Mirrors the per-section caps the documentation extractor
   * applies. Default 8.
   */
  maxClaims?: number
  /**
   * Cap on the byte length of the observation text handed to the model.
   * Defends against an oversized payload. Default 16384.
   */
  maxTextBytes?: number
}

const DEFAULT_MAX_CLAIMS = 8
const DEFAULT_MAX_TEXT_BYTES = 16_384

/**
 * Create the **opt-in** generic LLM-driven claim extractor for the reserved
 * {@link GENERIC_EXTRACTOR_SCHEMA_KEY} slot. Register it explicitly to extract
 * claims from arbitrary tool-result / observation text that has no
 * schema-bound extractor:
 *
 * ```ts
 * registerExtractor(createGenericLLMExtractor(myModel))
 * ```
 *
 * It is **never** part of {@link registerBuiltInExtractors} — replay-stable,
 * deterministic schema-bound extraction stays the default, and an LLM
 * extractor is opted into deliberately.
 *
 * Safety contract (the reason a generic extractor is acceptable at all):
 * every claim is `extraction_method: "llm"`, and its supporting evidence must
 * be stamped `model_inference` so the Round 5 auto-observation gate keeps the
 * belief `unverified` — it cannot self-promote to `supported`. That stamping
 * is the linker's job, so **pair this extractor with a
 * {@link GenericAwareEvidenceLinker}** (or any linker that downgrades `llm`
 * claims). Registered with the base linker, an `llm` claim's source evidence
 * stays `direct_observation` and the gate would NOT engage — the opt-in is the
 * extractor *and* its linker.
 */
export function createGenericLLMExtractor(
  model: GenericExtractionModel,
  options: GenericLLMExtractorOptions = {},
): ClaimExtractor {
  const maxClaims = options.maxClaims ?? DEFAULT_MAX_CLAIMS
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES

  return {
    schema_key: GENERIC_EXTRACTOR_SCHEMA_KEY,
    async extract(input: ExtractionInput): Promise<Claim[]> {
      const { observation, context } = input
      const text = renderObservationText(observation, maxTextBytes)
      const drafts = await model.extractClaims({
        text,
        schema: observation.schema,
        observation,
      })

      const now = new Date().toISOString()
      const claims: Claim[] = []
      for (const draft of drafts) {
        if (claims.length >= maxClaims) break
        const statement = typeof draft.statement === "string" ? draft.statement.trim() : ""
        if (!statement) continue // a draft with no statement is not a claim

        claims.push({
          id: crypto.randomUUID(),
          statement,
          ...(isValidPredicate(draft.predicate) ? { structured_predicate: draft.predicate } : {}),
          source_observation_ids: [observation.id],
          extraction_method: "llm",
          extracted_by: context.actor_id,
          status: "extracted",
          scope: context.default_scope,
          sensitivity: context.default_sensitivity,
          authors: [context.actor_id],
          created_at: now,
        })
      }
      return claims
    },
  }
}

/** A predicate is usable only if subject + relation are non-empty strings. */
function isValidPredicate(
  predicate: GenericClaimDraft["predicate"],
): predicate is { subject: string; relation: string; object: unknown } {
  return (
    !!predicate &&
    typeof predicate.subject === "string" &&
    predicate.subject.length > 0 &&
    typeof predicate.relation === "string" &&
    predicate.relation.length > 0
  )
}

/**
 * Best-effort plain-text rendering of an observation payload for the model.
 *
 * Prefers a conventional text-bearing field (`text` / `contents` / `content` /
 * `output` / `stdout` / `body` / `message`) when present and a string;
 * otherwise falls back to a stable JSON stringification. Truncated to
 * `maxTextBytes` so an oversized payload cannot blow up the prompt.
 */
export function renderObservationText(observation: Observation, maxTextBytes: number): string {
  const payload = observation.payload as Record<string, unknown> | null | undefined
  let text: string | undefined
  if (payload && typeof payload === "object") {
    for (const field of ["text", "contents", "content", "output", "stdout", "body", "message"]) {
      const value = payload[field]
      if (typeof value === "string") {
        text = value
        break
      }
    }
  }
  if (text === undefined) {
    try {
      text = JSON.stringify(observation.payload)
    } catch {
      text = String(observation.payload)
    }
  }
  return text.length > maxTextBytes ? text.slice(0, maxTextBytes) : text
}
