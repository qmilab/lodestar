export {
  MemoryFirewall,
  type FirewallAuditEvent,
} from "./firewall.js"

export {
  GatedRetrieval,
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

// Postgres-backed stores (v0.2). Same interfaces as the in-memory stores;
// durable and shared across sessions. Additive — not wired into the proxy yet.
export {
  PostgresBeliefStore,
  PostgresClaimStore,
  PostgresEvidenceStore,
  createPostgresStores,
  ensureSchema,
  dropSchema,
  truncateAll,
  TABLES,
  type PostgresStores,
} from "./stores/postgres.js"

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
