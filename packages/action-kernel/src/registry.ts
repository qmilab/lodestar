import type {
  ActionPrecondition,
  Observation,
  Reversibility,
  TrustLevel,
} from "@qmilab/lodestar-core"
import type { z } from "zod"

/**
 * Sandbox profiles available to tools.
 *
 * - read: fs read only; no network; no shell; no writes
 * - write-isolated: fs read/write in tempfs; no network; no shell
 * - write-local: fs read/write in project root; no network beyond allowlist;
 *                no shell
 * - controlled-shell: read/write + shell with command allowlist; container
 *                     sandbox; restricted network egress
 * - controlled-network: network egress to an operator allowlist of destinations;
 *                       in-process signing with scoped secrets; no shell, no fs
 *                       writes. For native egress tools that talk a protocol
 *                       directly rather than via a subprocess (e.g. the Nostr
 *                       adapter's relay client). Sibling of controlled-shell.
 */
export type SandboxProfile =
  | "read"
  | "write-isolated"
  | "write-local"
  | "controlled-shell"
  | "controlled-network"

/**
 * Permission tokens. Narrower than sandbox profiles; declarative.
 */
export type Permission = "fs.read" | "fs.write" | "shell.exec" | "network.egress" | "secret.sign"

/**
 * A registered tool. Tools are pure data: schemas, declared effects,
 * declared sandbox needs, and an async `execute` function.
 *
 * The kernel validates `inputs` before invocation and `outputs` after.
 * Invalid outputs raise a structural error rather than entering cognition.
 */
export interface Tool<TIn = unknown, TOut = unknown> {
  /** Tool name in the form `namespace.action` (no version). */
  name: string

  /** Zod schema for inputs. Validated at proposal time. */
  inputs: z.ZodType<TIn>

  /**
   * Schema registry key for outputs (e.g. "git.status@1").
   * The kernel uses this to look up the output schema and validate
   * the tool's result before constructing an Observation.
   */
  output_schema_key: string

  /** Declared effects on world state. Empty array means read-only. */
  effects: Effect[]

  /** Reversibility of side effects. */
  reversibility: Reversibility

  /** Required permissions. The kernel composes the sandbox from these. */
  permissions: Permission[]

  /** Minimum trust level required to invoke. */
  required_trust_level: TrustLevel

  /** Sandbox profile this tool needs. */
  sandbox: SandboxProfile

  /**
   * Preconditions the tool publishes. The kernel collects these into
   * the ActionContract and re-evaluates them at execution time.
   */
  preconditions?: PreconditionFactory<TIn>

  /**
   * Pure function that executes the tool. MUST NOT have side effects
   * outside the declared `effects`. The kernel calls this only after
   * policy approval.
   */
  execute: (inputs: TIn, ctx: ToolContext) => Promise<TOut>
}

export interface Effect {
  kind: "world_state_change" | "external_call" | "publication"
  description: string
  scope_hint?: string
}

export interface ToolContext {
  session_id: string
  project_id: string
  actor_id: string
  /** Capability handles for secrets. Tools never see raw secret values. */
  capabilities: ReadonlyMap<string, CapabilityHandle>
}

export interface CapabilityHandle {
  id: string
  kind: "sign" | "fetch" | "publish"
  /** Opaque token; the kernel resolves it to a real capability at use time. */
  token: string
}

export type PreconditionFactory<TIn> = (inputs: TIn) => ActionPrecondition[]

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const tools = new Map<string, Tool>()

export function registerTool<TIn, TOut>(tool: Tool<TIn, TOut>): void {
  if (tools.has(tool.name)) {
    throw new Error(`tool registry: '${tool.name}' is already registered`)
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(tool.name)) {
    throw new Error(
      `tool registry: '${tool.name}' must match 'namespace.action', e.g. 'git.status'`,
    )
  }
  tools.set(tool.name, tool as Tool)
}

export function lookupTool(name: string): Tool | undefined {
  return tools.get(name)
}

export function listTools(): string[] {
  return Array.from(tools.keys()).sort()
}

/**
 * Remove a previously-registered tool from the registry.
 *
 * Returns `true` if a tool was removed, `false` if no tool with that
 * name was registered. The function is intentionally permissive on
 * `false` so callers can use it as part of idempotent cleanup paths
 * (e.g., `MCPProxy.stop()` deregistering the downstream tools it
 * registered at `start()`).
 *
 * **TOCTOU note.** The registry is process-wide. A tool deregistered
 * mid-call — between `propose` and `execute` of an in-flight action
 * — would not affect that action (the kernel already holds a Tool
 * reference via `lookupTool` at propose time). New `propose` calls
 * after deregistration will fail because the name is no longer
 * present. Callers that need to drain in-flight actions before
 * deregistering must do so themselves; this function does not wait.
 */
export function unregisterTool(name: string): boolean {
  return tools.delete(name)
}

/**
 * For tests only. Do NOT call from production code.
 */
export function _resetToolsForTests(): void {
  tools.clear()
}

export type ObservationFactory = (
  payload: unknown,
  source: Observation["source"],
  context: Observation["context"],
  sensitivity: Observation["sensitivity"],
) => Observation
