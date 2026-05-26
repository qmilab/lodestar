import { z } from "zod"
import {
  type Permission,
  type SandboxProfile,
  type Tool as LodestarTool,
  registerTool,
  lookupTool,
  unregisterTool,
} from "@qmilab/lodestar-action-kernel"
import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import type { ToolContractDefaults } from "./config.js"
import type { DownstreamConnection } from "./downstream.js"
import {
  MCP_TOOL_RESULT_SCHEMA_KEY,
  type MCPToolResultObservationPayload,
} from "./observation.js"
import { stripReservedLodestarMeta } from "./policy-result.js"

/**
 * Conservative defaults applied to a downstream MCP tool when the
 * operator config has no `tool_defaults` entry for it.
 *
 * The bias is intentional: the proxy refuses to assume a downstream
 * tool is safe just because the downstream server's annotations say
 * so (MCP spec marks tool annotations as untrusted unless from a
 * trusted server). Operators opting into a lower-trust default for a
 * specific tool must do so explicitly in the config file.
 */
export const CONSERVATIVE_TOOL_DEFAULTS: ToolContractDefaults = {
  reversibility: "irreversible",
  permissions: ["fs.read", "fs.write", "shell.exec", "network.egress"],
  sandbox: "controlled-shell",
  required_trust_level: 3,
  blast_radius: "external",
}

/**
 * Inputs the Lodestar wrapper of an MCP tool accepts. We do not
 * re-validate against the downstream's `inputSchema` here: the
 * downstream server is the schema owner, and it will validate
 * itself when the call arrives. The proxy's job is to record and
 * gate, not to second-guess the downstream's domain logic.
 *
 * The kernel does require a Zod schema for inputs, so we use a
 * generic record of unknown values. The kernel's `propose()` parses
 * inputs exactly once against this schema; per the kernel's
 * documented invariant we do not re-parse downstream.
 */
const MCPToolInputsSchema = z.record(z.unknown())

/**
 * Lodestar tool-name regex: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`.
 * The downstream MCP tool's name plus the proxy's namespace prefix
 * must match this. Single-segment validator below — applied per
 * segment.
 */
const SEGMENT_RE = /^[a-z][a-z0-9_]*$/

/**
 * Build a fully-qualified Lodestar tool name for an MCP tool.
 *
 * Format: `mcp.<server>.<tool>`. Throws if either segment fails the
 * kernel's segment regex — the proxy refuses to silently sanitise
 * names, because a sanitised name in the event log makes the audit
 * trail ambiguous (which downstream tool was called?).
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  if (!SEGMENT_RE.test(serverName)) {
    throw new Error(
      `mcp-proxy: downstream server name '${serverName}' must match ${SEGMENT_RE} ` +
        `(lowercase, alphanumeric, underscore; starts with a letter). ` +
        `Rename the downstream in the proxy config.`,
    )
  }
  if (!SEGMENT_RE.test(toolName)) {
    throw new Error(
      `mcp-proxy: downstream tool name '${toolName}' from server '${serverName}' ` +
        `must match ${SEGMENT_RE} to satisfy the action-kernel registry's naming rule. ` +
        `The downstream server is exposing a tool with characters Lodestar cannot represent.`,
    )
  }
  return `mcp.${serverName}.${toolName}`
}

/**
 * Build a single Lodestar `Tool` that wraps one downstream MCP tool.
 *
 * The returned tool's `execute()` forwards the call to the downstream
 * client and shapes the result into an `MCPToolResultObservationPayload`
 * that conforms to the `mcp.tool_result@1` schema. The kernel
 * validates that payload and constructs the Observation.
 *
 * `defaults` controls the security-relevant ActionContract fields. If
 * the operator did not supply an entry for this tool in the config,
 * the caller should pass `CONSERVATIVE_TOOL_DEFAULTS`.
 */
export function buildLodestarToolForMCP(args: {
  lodestarName: string
  downstreamName: string
  downstream: DownstreamConnection
  mcpTool: MCPTool
  defaults: ToolContractDefaults
}): LodestarTool<Record<string, unknown>, MCPToolResultObservationPayload> {
  const {
    lodestarName,
    downstreamName,
    downstream,
    mcpTool,
    defaults,
  } = args

  // Permissions must be assigned at registration; sandbox is a string
  // enum that the kernel uses to compose runtime restrictions. Both
  // come from operator config (or conservative defaults).
  const permissions: Permission[] = [...defaults.permissions]
  const sandbox: SandboxProfile = defaults.sandbox

  return {
    name: lodestarName,
    inputs: MCPToolInputsSchema,
    output_schema_key: MCP_TOOL_RESULT_SCHEMA_KEY,
    effects: [
      {
        kind: "external_call",
        description:
          `forwards to MCP server '${downstreamName}' tool '${mcpTool.name}'` +
          (mcpTool.description ? `: ${mcpTool.description}` : ""),
      },
    ],
    reversibility: defaults.reversibility,
    permissions,
    required_trust_level: defaults.required_trust_level,
    sandbox,
    preconditions: () => [],
    execute: async (inputs): Promise<MCPToolResultObservationPayload> => {
      const downstreamResult: CallToolResult = await downstream.callTool(
        mcpTool.name,
        inputs,
      )
      return shapeMCPCallToolResultAsObservation({
        toolName: lodestarName,
        downstreamServer: downstreamName,
        args: inputs,
        result: downstreamResult,
      })
    },
  }
}

/**
 * Convert an MCP CallToolResult to the payload shape required by
 * `mcp.tool_result@1`.
 *
 * Content-block normalisation is deliberately permissive on the
 * unknown-block branch: an MCP server speaking a newer spec version
 * might emit content blocks Lodestar doesn't recognise. Rather than
 * crash on the boundary, the proxy records the unknown block under
 * `{ type: <original>, raw: <verbatim> }` so the event log preserves
 * what arrived. The downstream-marked-error flag is preserved as-is.
 */
function shapeMCPCallToolResultAsObservation(input: {
  toolName: string
  downstreamServer: string
  args: Record<string, unknown>
  result: CallToolResult
}): MCPToolResultObservationPayload {
  const content: MCPToolResultObservationPayload["content"] = input.result.content.map(
    (block) => {
      // The MCP types are wide unions. Each variant copies the
      // documented fields, then spreads the remaining keys (such as
      // `annotations`, `_meta`, future spec additions) via
      // `copyExtras` so the catchall on the observation schema
      // preserves them. Pre-fix, the mapper cherry-picked only the
      // documented fields, which silently dropped any block-level
      // metadata a downstream relied on.
      if (block.type === "text") {
        const raw = block as Record<string, unknown>
        const out: Record<string, unknown> = {
          type: "text" as const,
          text: typeof raw.text === "string" ? raw.text : "",
        }
        copyExtras(raw, out, ["type", "text"])
        return out as MCPToolResultObservationPayload["content"][number]
      }
      if (block.type === "image") {
        const raw = block as Record<string, unknown>
        const out: Record<string, unknown> = {
          type: "image" as const,
          data: typeof raw.data === "string" ? raw.data : "",
          mimeType:
            typeof raw.mimeType === "string"
              ? raw.mimeType
              : "application/octet-stream",
        }
        copyExtras(raw, out, ["type", "data", "mimeType"])
        return out as MCPToolResultObservationPayload["content"][number]
      }
      if (block.type === "audio") {
        const raw = block as Record<string, unknown>
        const out: Record<string, unknown> = {
          type: "audio" as const,
          data: typeof raw.data === "string" ? raw.data : "",
          mimeType:
            typeof raw.mimeType === "string"
              ? raw.mimeType
              : "application/octet-stream",
        }
        copyExtras(raw, out, ["type", "data", "mimeType"])
        return out as MCPToolResultObservationPayload["content"][number]
      }
      if (block.type === "resource") {
        const raw = block as Record<string, unknown>
        const rawResource = (raw.resource ?? {}) as Record<string, unknown>
        const resource: Record<string, unknown> = {
          uri: typeof rawResource.uri === "string" ? rawResource.uri : "",
        }
        if (typeof rawResource.mimeType === "string") resource.mimeType = rawResource.mimeType
        if (typeof rawResource.text === "string") resource.text = rawResource.text
        if (typeof rawResource.blob === "string") resource.blob = rawResource.blob
        // Preserve any extra resource-level fields (e.g. resource._meta).
        copyExtras(rawResource, resource, ["uri", "mimeType", "text", "blob"])
        const out: Record<string, unknown> = {
          type: "resource" as const,
          resource,
        }
        // Preserve any extra block-level fields (annotations, _meta, …).
        copyExtras(raw, out, ["type", "resource"])
        return out as MCPToolResultObservationPayload["content"][number]
      }
      if (block.type === "resource_link") {
        const raw = block as Record<string, unknown>
        const out: Record<string, unknown> = {
          type: "resource_link" as const,
          uri: typeof raw.uri === "string" ? raw.uri : "",
          name: typeof raw.name === "string" ? raw.name : "",
        }
        if (typeof raw.title === "string") out.title = raw.title
        if (typeof raw.description === "string") out.description = raw.description
        if (typeof raw.mimeType === "string") out.mimeType = raw.mimeType
        if (typeof raw.size === "number") out.size = raw.size
        // Preserve any additional fields (annotations, _meta, icons, …).
        copyExtras(raw, out, ["type", "uri", "name", "title", "description", "mimeType", "size"])
        return out as MCPToolResultObservationPayload["content"][number]
      }
      // Forward-compat: the SDK's TypeScript union is closed at compile
      // time, but a future SDK release could ship a new content kind
      // before Lodestar's handlers learn about it. Defend via cast.
      const fallback = block as { type?: unknown }
      return {
        type: "unknown" as const,
        original_type: String(fallback.type),
        raw: block,
      }
    },
  )

  const observation: MCPToolResultObservationPayload = {
    tool_name: input.toolName,
    args: input.args,
    downstream_server: input.downstreamServer,
    is_error: input.result.isError === true,
    content,
  }
  // Tools that declare an `outputSchema` may emit `structuredContent`
  // alongside the human-readable `content` blocks. Round-trip it
  // unchanged so agents that key off the structured field still see
  // the typed payload.
  const structured = (input.result as { structuredContent?: unknown }).structuredContent
  if (structured !== undefined && structured !== null && typeof structured === "object") {
    observation.structured_content = structured as Record<string, unknown>
  }
  // Round-trip result-level `_meta` (progress tokens, task associations,
  // server-defined extensions). Pre-Codex review this was dropped.
  //
  // The reserved `_lodestar` key inside `_meta` is a Lodestar-authored
  // marker (see `policy-result.ts`). A hostile or compromised
  // downstream could put a forged `policy_denied`/`tool_not_advertised`
  // marker there to make probes and sentinels misclassify its result
  // as a Lodestar decision; we strip it at capture so it never lands
  // in the audit trail.
  const meta = (input.result as { _meta?: unknown })._meta
  if (meta !== undefined && meta !== null && typeof meta === "object") {
    observation.meta = stripReservedLodestarMeta(meta as Record<string, unknown>)
  }
  return observation
}


/**
 * Copy every key from `src` to `dst` that is not in `excluded`. Used
 * to preserve forward-compatible MCP fields (annotations, _meta,
 * icons, etc.) that the proxy doesn't know about but must
 * round-trip transparently.
 *
 * Trust-boundary precaution: when copying an `_meta` object, the
 * reserved Lodestar marker key is stripped. Without this, a hostile
 * downstream could attach `_meta: { _lodestar: { kind: "policy_
 * denied", ... } }` to a content block and slip a fake decision
 * marker into the observation payload — which `isPolicyDeniedResult`
 * (and any sentinel pattern-matching on the marker) would
 * misclassify as a Lodestar-authored event.
 */
function copyExtras(
  src: Record<string, unknown>,
  dst: Record<string, unknown>,
  excluded: string[],
): void {
  const skip = new Set(excluded)
  for (const key of Object.keys(src)) {
    if (skip.has(key)) continue
    const value = src[key]
    if (key === "_meta" && value !== null && typeof value === "object") {
      dst[key] = stripReservedLodestarMeta(value as Record<string, unknown>)
    } else {
      dst[key] = value
    }
  }
}

/**
 * Register one Lodestar tool per downstream MCP tool, returning the
 * list of namespaced Lodestar names that the caller now owns.
 *
 * The function is **not** idempotent on collision. If `lookupTool`
 * already returns a tool for a given namespaced name, this is treated
 * as an error: a prior `MCPProxy` either failed to clean up (didn't
 * call `stop()` / didn't unregister) or two proxies are trying to
 * coexist in the same process for overlapping downstream tool names.
 * In either case, silently keeping the prior registration would route
 * future calls through a stale closure bound to a dead child process
 * or to a different proxy's policy defaults, which is worse than
 * failing loudly at startup.
 *
 * **Transactional.** If the loop throws partway through (e.g., the
 * fifth tool's name is already registered), this function rolls back
 * its own earlier registrations from the same call before
 * re-throwing. Pre-Codex review, partial success would strand the
 * earlier registrations: the caller's tracker only learned about
 * registrations once the helper returned successfully, so the
 * startup rollback path couldn't see them. Now the helper either
 * registers all of the downstream's tools or none.
 *
 * Callers (`MCPProxy.start`) catch this and surface it as a
 * startup failure that includes the offending tool name. They are
 * still responsible for unregistering registrations from PRIOR
 * helper calls (e.g., from downstream #1 when downstream #2's call
 * to this helper failed).
 */
export function registerDownstreamToolsWithKernel(args: {
  downstream: DownstreamConnection
  defaultsByTool: Record<string, ToolContractDefaults>
  conservativeDefaults?: ToolContractDefaults
  /**
   * Optional sink invoked once per downstream tool the helper
   * declines to register because it requires task-based execution
   * (`execution.taskSupport === "required"`) and the v0 proxy only
   * forwards synchronous CallTool requests. The sink lets the caller
   * surface the skipped tools to operators (typically via stderr).
   */
  onTaskRequiredSkipped?: (info: {
    downstreamName: string
    toolName: string
    lodestarName: string
  }) => void
}): Array<{ lodestarName: string; mcpTool: MCPTool }> {
  const registered: Array<{ lodestarName: string; mcpTool: MCPTool }> = []
  const fallback = args.conservativeDefaults ?? CONSERVATIVE_TOOL_DEFAULTS
  try {
    for (const mcpTool of args.downstream.getTools()) {
      const lodestarName = namespacedToolName(
        args.downstream.config.name,
        mcpTool.name,
      )
      // Skip tools that require task-based execution. The MCP spec's
      // `execution.taskSupport: "required"` says "the client MUST
      // invoke this via the tasks API." The proxy only knows the
      // synchronous `callTool` API today; advertising the tool would
      // mislead spec-compliant clients (they would issue a task call
      // and get a protocol error) and non-task clients (they would
      // hit the throw inside the SDK's `callTool`). Drop them at
      // startup with a visible warning so operators know they can
      // safely re-add them once Lodestar grows task support.
      const taskSupport = (mcpTool as { execution?: { taskSupport?: string } })
        .execution?.taskSupport
      if (taskSupport === "required") {
        args.onTaskRequiredSkipped?.({
          downstreamName: args.downstream.config.name,
          toolName: mcpTool.name,
          lodestarName,
        })
        continue
      }
      if (lookupTool(lodestarName) !== undefined) {
        throw new Error(
          `mcp-proxy: tool '${lodestarName}' is already registered in the ` +
            `action-kernel. This usually means a prior MCPProxy instance ` +
            `did not call stop() (which deregisters its tools), or two ` +
            `proxies are coexisting in the same process for the same ` +
            `downstream name. Stop the prior proxy or rename the ` +
            `downstream server in your config.`,
        )
      }
      const defaults = args.defaultsByTool[lodestarName] ?? fallback
      registerTool(
        buildLodestarToolForMCP({
          lodestarName,
          downstreamName: args.downstream.config.name,
          downstream: args.downstream,
          mcpTool,
          defaults,
        }),
      )
      registered.push({ lodestarName, mcpTool })
    }
  } catch (err) {
    // Roll back our own partial work — every `lodestarName` we
    // successfully registered before the throw must come out of the
    // process-wide registry. `unregisterTool` is idempotent on
    // missing names, so a double-rollback from the caller is harmless.
    for (const { lodestarName } of registered) {
      unregisterTool(lodestarName)
    }
    throw err
  }
  return registered
}
