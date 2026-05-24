export {
  registerTool,
  lookupTool,
  listTools,
  _resetToolsForTests,
  type Tool,
  type SandboxProfile,
  type Permission,
  type Effect,
  type ToolContext,
  type CapabilityHandle,
  type ObservationFactory,
  type PreconditionFactory,
} from "./registry"

export {
  ActionKernel,
  type PolicyGate,
  type PolicyDecision,
  type PreconditionChecker,
  type ToolContextResolver,
} from "./kernel"
