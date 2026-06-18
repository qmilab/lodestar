/**
 * @qmilab/lodestar-runtime-core — the language-agnostic governance-gate sidecar.
 *
 * Govern an agent runtime that does not speak MCP (LangGraph, CrewAI, AutoGen)
 * by remoting each native tool call through the Action Kernel over a thin
 * NDJSON-RPC seam. The reusable spine of the runtime-adapter epic (ADR-0024):
 * each framework contributes only a small native hook; the gate server is shared.
 */

export { RuntimeGate, RUNTIME_DECISION_SYNTHESIS_ACTOR } from "./gate.js"
export type { RuntimeGateOverrides } from "./gate.js"

export {
  RuntimeGateConfigSchema,
  loadRuntimeGateConfig,
  hasUnauthenticatedApprovalGap,
  CONSERVATIVE_TOOL_DEFAULTS,
  ToolContractDefaultsSchema,
  RuntimePolicyConfigSchema,
  ApprovalsConfigSchema,
  AuthorizedApproverSchema,
  PersistenceConfigSchema,
} from "./config.js"
export type {
  RuntimeGateConfig,
  ToolContractDefaults,
  RuntimePolicyConfig,
  ApprovalsConfig,
  AuthorizedApprover,
  PersistenceConfig,
} from "./config.js"

export { compileRuntimePolicy, compileRuntimePolicyWithSentinels } from "./policy.js"

export {
  RUNTIME_TOOL_RESULT_SCHEMA_KEY,
  RUNTIME_TOOL_INVOCATION_RELATION,
  RUNTIME_EXTERNAL_DOCUMENT_RELATION,
  RuntimeToolResultObservationSchema,
  RuntimeToolResultExtractor,
  RuntimeAwareEvidenceLinker,
  registerRuntimeExtractors,
  registerRuntimeToolResultSchema,
} from "./observation.js"
export type { RuntimeToolResultObservationPayload } from "./observation.js"

export { stdioChannel, createLoopbackPair } from "./connection.js"
export type { RpcChannel } from "./connection.js"

export {
  InboundMessageSchema,
  RegisterToolMessageSchema,
  GovernMessageSchema,
  ResumeMessageSchema,
  ToolResultMessageSchema,
  ToolErrorMessageSchema,
  ShutdownMessageSchema,
  ToolResultDocumentSchema,
} from "./protocol.js"
export type {
  InboundMessage,
  OutboundMessage,
  ReadyMessage,
  RegisteredMessage,
  GovernResultMessage,
  GovernResultPhase,
  RunToolMessage,
  ErrorMessage,
  ToolResultDocument,
} from "./protocol.js"
