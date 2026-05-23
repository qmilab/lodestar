import { FsReadExtractor } from "./fs-read"
import { GitStatusExtractor } from "./git-status"
import { registerExtractor } from "./base"

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
export { type ClaimExtractor, type ExtractionInput, registerExtractor, lookupExtractor } from "./base"
