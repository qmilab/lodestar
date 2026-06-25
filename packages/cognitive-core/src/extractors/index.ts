import { registerExtractor } from "./base.js"
import { FsReadExtractor } from "./fs-read.js"
import { GitStatusExtractor } from "./git-status.js"

/**
 * Register the built-in extractors. Call once at process start.
 *
 * Custom extractors are registered separately by calling registerExtractor()
 * directly.
 */
export function registerBuiltInExtractors(): void {
  registerExtractor(GitStatusExtractor)
  registerExtractor(FsReadExtractor)
}

export { GitStatusExtractor, FsReadExtractor }
// DocumentationExtractor is opt-in (not a built-in): consumers that want
// content-level claims register it explicitly, exactly like any other
// custom extractor.
export {
  DocumentationExtractor,
  DOCUMENTATION_SOURCE_SCHEMA_KEY,
  type DocumentationSourcePayload,
} from "./documentation.js"
// The generic LLM-driven extractor is opt-in (not a built-in): registering it
// claims the reserved __generic__ fallback slot, so it must be a deliberate
// choice (replay-stable schema-bound extraction stays the default). Pair it
// with a GenericAwareEvidenceLinker so its claims stay `unverified` (#163).
export {
  createGenericLLMExtractor,
  renderObservationText,
  type GenericExtractionModel,
  type GenericExtractionRequest,
  type GenericClaimDraft,
  type GenericLLMExtractorOptions,
} from "./generic-llm.js"
export {
  type ClaimExtractor,
  type ExtractionInput,
  GENERIC_EXTRACTOR_SCHEMA_KEY,
  registerExtractor,
  lookupExtractor,
} from "./base.js"
