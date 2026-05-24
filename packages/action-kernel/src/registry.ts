import type { z } from "zod"
import type {
  ActionPrecondition,
  Observation,
  Reversibility,
  TrustLevel,
} from "@qmilab/lodestar-core"

/**
 * Sandbox profiles available to tools.
 *
 * - read: fs read only; no network; no shell; no writes
 * - write-isolated: fs read/write in tempfs; no network; no shell
 * - write-local: fs read/write in project root; no network beyond allowlist;
 *                no shell
 * - controlled-shell: read/write + shell with command allowlist; container
 *                     sandbox; restricted network egress
 */
export type SandboxProfile =
  | "read"
  | "write-isolated"
  | "write-local"
  | "controlled-shell"

/**
 * Permission tokens. Narrower than sandbox profiles; declarative.
 */
export type Permission =
  | "fs.read"
  | "fs.write"
  | "shell.exec"
  | "network.egress"
  | "secret.sign"

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
