export { CognitiveCore, type IngestInput, type IngestResult } from "./core.js"
export {
  EvidenceLinker,
  type EvidenceLinkerLike,
  type LinkForClaimInput,
} from "./evidence-linker.js"
export { DocAwareEvidenceLinker } from "./doc-evidence-linker.js"
export {
  ExplanationGenerator,
  type BuildExplanationInput,
} from "./explanation.js"
export {
  registerBuiltInExtractors,
  registerExtractor,
  lookupExtractor,
  GitStatusExtractor,
  FsReadExtractor,
  DocumentationExtractor,
  DOCUMENTATION_SOURCE_SCHEMA_KEY,
  type DocumentationSourcePayload,
  type ClaimExtractor,
  type ExtractionInput,
} from "./extractors/index.js"
export {
  type WorldModel,
  type WorldModelEntry,
  type WorldModelSetInput,
  InMemoryWorldModel,
} from "./world-model/index.js"
export {
  Reflection,
  type ReflectionInputs,
  type ReflectionContext,
  type ReflectionEmitter,
  type RunInput as ReflectionRunInput,
  type RunResult as ReflectionRunResult,
  type AppliedSummary as ReflectionAppliedSummary,
} from "./reflection.js"
