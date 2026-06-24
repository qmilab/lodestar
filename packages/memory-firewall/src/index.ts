export {
  MemoryFirewall,
  type FirewallAuditEvent,
} from "./firewall.js"

export {
  GatedRetrieval,
  predicateKey,
  type RetrievalQuery,
  type RetrievalResult,
  type BeliefRejection,
} from "./retrieval.js"

export {
  type ClaimStore,
  type ClaimFilter,
  type ClaimTransition,
  type ClaimTransitionInput,
  InMemoryClaimStore,
} from "./stores/claim-store.js"

export {
  type BeliefStore,
  type BeliefFilter,
  type BeliefAxisTransition,
  type BeliefAxisTransitionInput,
  type LifecycleAxis,
  InMemoryBeliefStore,
} from "./stores/belief-store.js"

export {
  type EvidenceStore,
  InMemoryEvidenceStore,
  aggregateStrength,
} from "./stores/evidence-store.js"

// NOTE: the Postgres-backed stores are deliberately NOT re-exported here.
// They depend on Bun's native `bun:sql`, so importing them eagerly from the
// package root would break Node/npm consumers of the published `import`/
// `default` path who only use the in-memory stores. They live behind the
// `@qmilab/lodestar-memory-firewall/postgres` subpath instead (see package.json
// exports), so only callers that opt into the Postgres backend pull in `bun`.

export {
  type TransitionAuthority,
  type Transition,
  isTransitionAllowed,
  authoritiesFor,
} from "./transitions.js"

export {
  AdapterImportOptionsSchema,
  AdapterImportResultSchema,
  notImplementedFor,
  type AdapterImportOptions,
  type AdapterImportResult,
  type ExternalMemoryAdapter,
} from "./adapter-contract.js"
