import { z } from "zod"
import {
  type Permission,
  type SandboxProfile,
  type Tool as LodestarTool,
  registerTool,
  lookupTool,
} from "@qmilab/lodestar-action-kernel"
import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import type { ToolContractDefaults } from "./config.js"
import type { DownstreamConnection } from "./downstream.js"
import {
  MCP_TOOL_RESULT_SCHEMA_KEY,
  type MCPToolResultObservationPayload,
} from "./observation.js"

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
  const content = input.result.content.map((block) => {
    // The MCP types are wide unions. Discriminate on `type` and pull
    // through only the fields our observation schema expects;
    // anything else is recorded as an `unknown` raw block.
    if (block.type === "text") {
      return { type: "text" as const, text: typeof block.text === "string" ? block.text : "" }
    }
    if (block.type === "image") {
      return {
        type: "image" as const,
        data: typeof block.data === "string" ? block.data : "",
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
      }
    }
    if (block.type === "audio") {
      return {
        type: "audio" as const,
        data: typeof block.data === "string" ? block.data : "",
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
      }
    }
    if (block.type === "resource") {
      const resource = (block as { resource?: { uri?: unknown; mimeType?: unknown; text?: unknown } }).resource ?? {}
      const out: { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } } = {
        type: "resource",
        resource: { uri: typeof resource.uri === "string" ? resource.uri : "" },
      }
      if (typeof resource.mimeType === "string") out.resource.mimeType = resource.mimeType
      if (typeof resource.text === "string") out.resource.text = resource.text
      return out
    }
    return { type: "unknown" as const, original_type: String(block.type), raw: block }
  })

  return {
    tool_name: input.toolName,
    args: input.args,
    downstream_server: input.downstreamServer,
    is_error: input.result.isError === true,
    content,
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
 * Callers (`MCPProxy.start`) catch this and surface it as a
 * startup failure that includes the offending tool name.
 */
export function registerDownstreamToolsWithKernel(args: {
  downstream: DownstreamConnection
  defaultsByTool: Record<string, ToolContractDefaults>
  conservativeDefaults?: ToolContractDefaults
}): Array<{ lodestarName: string; mcpTool: MCPTool }> {
  const registered: Array<{ lodestarName: string; mcpTool: MCPTool }> = []
  const fallback = args.conservativeDefaults ?? CONSERVATIVE_TOOL_DEFAULTS
  for (const mcpTool of args.downstream.getTools()) {
    const lodestarName = namespacedToolName(
      args.downstream.config.name,
      mcpTool.name,
    )
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
  return registered
}
