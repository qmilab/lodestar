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
export {
  type ClaimExtractor,
  type ExtractionInput,
  registerExtractor,
  lookupExtractor,
} from "./base.js"
