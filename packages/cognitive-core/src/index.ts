export { CognitiveCore, type IngestInput, type IngestResult } from "./core"
export { EvidenceLinker } from "./evidence-linker"
export {
  ExplanationGenerator,
  type BuildExplanationInput,
} from "./explanation"
export {
  registerBuiltInExtractors,
  registerExtractor,
  lookupExtractor,
  GitStatusExtractor,
  FsReadExtractor,
  type ClaimExtractor,
  type ExtractionInput,
} from "./extractors"
export {
  type WorldModel,
  type WorldModelEntry,
  type WorldModelSetInput,
  InMemoryWorldModel,
} from "./world-model"
