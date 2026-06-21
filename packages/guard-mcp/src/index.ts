export {
  type DownstreamServerConfig,
  DownstreamServerConfigSchema,
  loadProxyConfig,
  type PersistenceConfig,
  PersistenceConfigSchema,
  type ProxyConfig,
  ProxyConfigSchema,
  type ProxyPolicyConfig,
  ProxyPolicyConfigSchema,
  type ToolContractDefaults,
  ToolContractDefaultsSchema,
} from "./config.js"

export { compileProxyPolicy, compileProxyPolicyWithSentinels } from "./policy.js"

export {
  type ApprovalResolution,
  ApprovalResolutionSchema,
  approvalResolutionPath,
  approvalsChannelDir,
  deleteApprovalResolution,
  readApprovalResolution,
  resolutionToOutcome,
  writeApprovalResolution,
  // Approval transport seam (ADR-0015), re-exported from guard.
  type ApprovalChannel,
  type ApprovalRef,
  type ApprovalChannelConfig,
  type SecretValue,
  ApprovalChannelConfigSchema,
  FileApprovalChannel,
  HttpApprovalChannel,
  assertChannelEndpoint,
  createApprovalChannel,
  httpChannelForbidsUnsigned,
} from "./approvals-channel.js"

export {
  collectPaginatedTools,
  DownstreamConnection,
  mergeDownstreamEnv,
} from "./downstream.js"

export {
  MCPAwareEvidenceLinker,
  MCP_EXTERNAL_DOCUMENT_RELATION,
  MCP_TOOL_INVOCATION_RELATION,
  MCP_TOOL_RESULT_SCHEMA_KEY,
  MCPToolResultExtractor,
  type MCPToolResultObservationPayload,
  MCPToolResultObservationSchema,
  registerMCPProxyExtractors,
  registerMCPToolResultSchema,
} from "./observation.js"

export {
  buildPolicyDeniedResult,
  type CallToolContentBlock,
  type CallToolResultLike,
  isPolicyDeniedResult,
  type PolicyDeniedDetails,
} from "./policy-result.js"

export {
  MCPProxy,
  type MCPProxyOverrides,
  PROXY_DECISION_SYNTHESIS_ACTOR,
} from "./proxy.js"

export {
  buildLodestarToolForMCP,
  CONSERVATIVE_TOOL_DEFAULTS,
  namespacedToolName,
  registerDownstreamToolsWithKernel,
  sanitizeAdvertisedTool,
} from "./tool-adapter.js"

export {
  type UpstreamCallToolHandler,
  UpstreamServer,
} from "./upstream.js"
