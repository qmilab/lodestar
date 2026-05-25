export { CognitiveCore, type IngestInput, type IngestResult } from "./core.js"
export { EvidenceLinker } from "./evidence-linker.js"
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
  type ClaimExtractor,
  type ExtractionInput,
} from "./extractors/index.js"
export {
  type WorldModel,
  type WorldModelEntry,
  type WorldModelSetInput,
  InMemoryWorldModel,
} from "./world-model/index.js"
