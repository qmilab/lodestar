import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import {
  type Tool as LodestarTool,
  type Permission,
  type SandboxProfile,
  lookupTool,
  registerTool,
  unregisterTool,
} from "@qmilab/lodestar-action-kernel"
import { z } from "zod"
import type { ToolContractDefaults } from "./config.js"
import type { DownstreamConnection } from "./downstream.js"
import { type MCPToolResultObservationPayload, MCP_TOOL_RESULT_SCHEMA_KEY } from "./observation.js"
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
      `mcp-proxy: downstream server name '${serverName}' must match ${SEGMENT_RE} (lowercase, alphanumeric, underscore; starts with a letter). Rename the downstream in the proxy config.`,
    )
  }
  if (!SEGMENT_RE.test(toolName)) {
    throw new Error(
      `mcp-proxy: downstream tool name '${toolName}' from server '${serverName}' must match ${SEGMENT_RE} to satisfy the action-kernel registry's naming rule. The downstream server is exposing a tool with characters Lodestar cannot represent.`,
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
  const { lodestarName, downstreamName, downstream, mcpTool, defaults } = args

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
        description: `forwards to MCP server '${downstreamName}' tool '${mcpTool.name}'${mcpTool.description ? `: ${mcpTool.description}` : ""}`,
      },
    ],
    reversibility: defaults.reversibility,
    permissions,
    required_trust_level: defaults.required_trust_level,
    sandbox,
    preconditions: () => [],
    execute: async (inputs): Promise<MCPToolResultObservationPayload> => {
      const downstreamResult: CallToolResult = await downstream.callTool(mcpTool.name, inputs)
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
  const content: MCPToolResultObservationPayload["content"] = input.result.content.map((block) => {
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
        mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
      }
      copyExtras(raw, out, ["type", "data", "mimeType"])
      return out as MCPToolResultObservationPayload["content"][number]
    }
    if (block.type === "audio") {
      const raw = block as Record<string, unknown>
      const out: Record<string, unknown> = {
        type: "audio" as const,
        data: typeof raw.data === "string" ? raw.data : "",
        mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
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
    //
    // Trust-boundary precaution (Codex round 13): deep-strip the
    // reserved `_lodestar` key from every `_meta` reachable inside
    // the raw block before persisting. Known content blocks get
    // this treatment via `copyExtras`; without doing it here too,
    // a hostile downstream could smuggle a forged
    // `_meta._lodestar` marker into the observation payload via
    // an unrecognised content kind's nested metadata.
    const fallback = block as { type?: unknown }
    return {
      type: "unknown" as const,
      original_type: String(fallback.type),
      raw: stripReservedLodestarMetaDeep(block),
    }
  })

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
 * Build a sanitised version of a downstream MCP tool that is safe to
 * advertise upstream. The wrapped agent's runtime almost always
 * pipes `description`, `annotations.title`, and schema `description`
 * fields into the model prompt — so prompt-injection text embedded
 * in any of those reaches the model before any `tools/call` /
 * `mcp.tool_result@1` defense fires. The MCP spec explicitly marks
 * `annotations` as untrusted unless the server is itself trusted;
 * the same caution applies to `description` and to every nested
 * description inside `inputSchema`/`outputSchema`.
 *
 * v0 sanitisation strategy: replace `description` with a Lodestar-
 * issued safe summary that names the proxy + the tool, drop
 * `annotations`/`_meta`/`icons`, recursively strip `description`
 * fields from input/output schemas, and force
 * `execution.taskSupport` to `"forbidden"` so MCP clients that
 * support the experimental tasks API don't send task-augmented
 * calls the v0 proxy can't forward.
 *
 * The original tool metadata is captured via the
 * `mcp_proxy.tool_advertised` audit event the proxy emits at
 * startup, so operators investigating a denial still have the
 * downstream's verbatim catalog text in the event log.
 *
 * The lodestar-namespaced `name` and the `inputSchema`'s property
 * names + types ride through unchanged — the model needs them to
 * call the tool correctly.
 */
export function sanitizeAdvertisedTool(args: {
  mcpTool: MCPTool
  lodestarName: string
  downstreamName: string
}): MCPTool {
  const safeDescription = `Tool '${args.lodestarName}' (proxied from downstream '${args.downstreamName}'). The original description is recorded in the Lodestar event log; it is not forwarded to the wrapped agent's prompt to prevent prompt-injection text in downstream tool metadata from reaching the model.`
  const inputSchema = sanitizeSchema(args.mcpTool.inputSchema) as MCPTool["inputSchema"]
  const out: Record<string, unknown> = {
    name: args.lodestarName,
    description: safeDescription,
    inputSchema,
  }
  // outputSchema is optional in MCP; if present, sanitise it the
  // same way so a hostile downstream can't push prompt content
  // via its schema annotations or extension keys.
  const outputSchema = (args.mcpTool as { outputSchema?: unknown }).outputSchema
  if (outputSchema !== undefined) {
    out.outputSchema = sanitizeSchema(outputSchema)
  }
  // execution.taskSupport: forbidden. Any MCP client supporting the
  // experimental tasks API will see "this tool is sync only" and
  // not try to invoke it via createTask/pollTask, which v0 doesn't
  // forward. Tools that originally said "required" never reach
  // here — `registerDownstreamToolsWithKernel` already dropped them.
  out.execution = { taskSupport: "forbidden" as const }
  // Deliberately NOT forwarded: annotations, _meta, icons, title.
  // Each is untrusted free text in a place the wrapped agent's
  // runtime may surface to the model.
  return out as MCPTool
}

/**
 * Allowlist of JSON Schema structural keywords the proxy will copy
 * verbatim into an advertised tool's schema. Anything not in this
 * set is dropped at schema level.
 *
 * The allowlist closes prompt-injection channels through:
 *   - Annotation fields (`description`, `title`, `$comment`,
 *     `default`, `examples`) — the round-15..20 denylist already
 *     covered these, but a denylist can't catch...
 *   - Arbitrary extension keys (`x-instructions`, `x-system`,
 *     `x-anything-else`) — a hostile downstream can put prompt text
 *     in any key whose name they invent. Codex round 21 flagged
 *     this as the remaining bypass. The fix flips polarity:
 *     ALLOW only the structural keywords below; DROP everything
 *     else.
 *
 * The allowlist covers JSON Schema Draft 2020-12 structural
 * keywords. Reasoning per group:
 *
 *   • `type` / `enum` / `const` — value constraints the model
 *     MUST honour to construct valid calls. Removing them breaks
 *     tool invocation.
 *   • String / number / object / array constraints — declare
 *     valid value shapes; same reason.
 *   • `properties` / `patternProperties` / `propertyNames` /
 *     `dependentSchemas` / `$defs` / `definitions` — maps from
 *     property names → schemas. Their KEYS are property names
 *     (preserved via `sanitizePropertyMap`); their VALUES are
 *     schemas (recursively sanitised).
 *   • `items` / `prefixItems` / `additionalItems` / `additional
 *     Properties` / `contains` / `if` / `then` / `else` / `not`
 *     / `allOf` / `anyOf` / `oneOf` — values are schemas (or
 *     arrays of schemas) and recurse through `sanitizeSchema`.
 *   • `required` / `dependentRequired` — arrays of property
 *     names; pass through (strings, not schemas).
 *   • `$ref` — JSON pointer string. Pass through; the SDK
 *     resolves it client-side and won't render a long URI into
 *     the model prompt the way it renders descriptions.
 */
const ALLOWED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  // Core type system
  "type",
  // Numeric constraints
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // String constraints
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // Object size / shape
  "minProperties",
  "maxProperties",
  "properties",
  "patternProperties",
  "propertyNames",
  "additionalProperties",
  "required",
  "dependentRequired",
  "dependentSchemas",
  // Array size / shape
  "items",
  "prefixItems",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  // Logical composition
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  // Value enumeration
  "enum",
  "const",
  // Schema references
  "$ref",
  "$defs",
  "definitions",
])

/**
 * Allowed schema keys whose value is a map of property name →
 * schema. Property NAMES at the next level pass through unchanged
 * (the model needs them to call the tool); each value is then
 * recursively `sanitizeSchema`d.
 */
const SCHEMA_KEYS_AS_PROPERTY_MAP: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
])

/**
 * Allowed schema keys whose value is itself a schema (or, in the
 * case of `allOf` / `anyOf` / `oneOf` / `prefixItems`, an array of
 * schemas) that must be recursively sanitised.
 */
const SCHEMA_KEYS_AS_NESTED_SCHEMA: ReadonlySet<string> = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "propertyNames",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
])

/**
 * Allowlist-based sanitiser for a JSON Schema fragment. Drops every
 * key not in `ALLOWED_SCHEMA_KEYS`; recurses through nested schemas
 * and property maps; leaves value-position keys (`enum`, `const`,
 * `type`, numeric/string constraints, `required` arrays) verbatim.
 *
 * Pre-Codex-round-21 the sanitiser used a denylist that only knew
 * about specific annotation keys. Custom extension keys
 * (`x-instructions`, `x-system`, anything not on the denylist)
 * survived into the advertised catalog and could be rendered into
 * the model prompt by clients that include the full schema. The
 * allowlist closes that channel categorically.
 */
function sanitizeSchema(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  // A schema can also be a boolean (`additionalProperties: true`)
  // or appear inside an array of schemas (`allOf: [s1, s2]`).
  if (Array.isArray(value)) {
    return value.map(sanitizeSchema)
  }
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      // Drops every key the allowlist doesn't recognise. Includes:
      // every annotation field (description / title / $comment /
      // default / examples), every extension key (x-*), every
      // legacy or future schema key Lodestar hasn't whitelisted.
      // Dropping is the safe default.
      continue
    }
    const v = obj[key]
    if (SCHEMA_KEYS_AS_PROPERTY_MAP.has(key)) {
      out[key] = sanitizePropertyMap(v)
    } else if (SCHEMA_KEYS_AS_NESTED_SCHEMA.has(key)) {
      out[key] = sanitizeSchema(v)
    } else {
      // Value-position keys (enum / const / required / type /
      // numeric constraints / format / $ref / etc.) pass through
      // verbatim. enum/const values can be arbitrary JSON; they
      // are the legitimate value set the API expects, not free
      // text annotations, so we keep them as-is.
      out[key] = v
    }
  }
  return out
}

/**
 * Sanitise the value of a schema key that maps property name →
 * schema (such as `properties` or `patternProperties`). KEYS at
 * this level are property names — preserve every one (the model
 * needs them to call the tool, even when they collide with
 * schema-keyword strings like `description`). Each VALUE is a
 * schema that gets recursively sanitised by `sanitizeSchema`.
 */
function sanitizePropertyMap(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value
  }
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    out[key] = sanitizeSchema(obj[key])
  }
  return out
}

/**
 * Recursively strip the reserved `_lodestar` key from every `_meta`
 * object reachable from `value`. Used to sanitise the verbatim
 * payload captured for `unknown`-type content blocks before storing
 * it in the observation, so a hostile downstream cannot smuggle a
 * forged Lodestar decision marker via an unrecognised content
 * kind's nested `_meta`.
 *
 * Returns a deep copy of objects and arrays; primitives are returned
 * by value. Leaves any non-`_meta` keys untouched so the operator
 * can still inspect what the downstream emitted.
 */
function stripReservedLodestarMetaDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripReservedLodestarMetaDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    const child = obj[key]
    if (key === "_meta" && child !== null && typeof child === "object" && !Array.isArray(child)) {
      out[key] = stripReservedLodestarMeta(child as Record<string, unknown>)
    } else {
      out[key] = stripReservedLodestarMetaDeep(child)
    }
  }
  return out
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
    /**
     * Best-effort Lodestar-namespaced name. `undefined` when the
     * downstream's native name doesn't satisfy the action-kernel
     * registry regex; in that case the skip happens before
     * `namespacedToolName` runs, so we can only report what the
     * downstream called the tool.
     */
    lodestarName: string | undefined
  }) => void
}): Array<{ lodestarName: string; mcpTool: MCPTool }> {
  const registered: Array<{ lodestarName: string; mcpTool: MCPTool }> = []
  const fallback = args.conservativeDefaults ?? CONSERVATIVE_TOOL_DEFAULTS
  try {
    for (const mcpTool of args.downstream.getTools()) {
      // Skip tools that require task-based execution BEFORE running
      // the name through `namespacedToolName`. The MCP spec's
      // `execution.taskSupport: "required"` says "the client MUST
      // invoke this via the tasks API"; the proxy only forwards
      // synchronous CallTool, so a task-required tool is going to
      // be dropped from the catalog either way. Skipping pre-
      // validation means a task-required tool with a non-
      // conformant name (e.g. `long-running` with a hyphen) does
      // not tank the whole downstream — the sibling sync tools
      // still register cleanly.
      const taskSupport = (mcpTool as { execution?: { taskSupport?: string } }).execution
        ?.taskSupport
      if (taskSupport === "required") {
        args.onTaskRequiredSkipped?.({
          downstreamName: args.downstream.config.name,
          toolName: mcpTool.name,
          lodestarName: undefined,
        })
        continue
      }
      const lodestarName = namespacedToolName(args.downstream.config.name, mcpTool.name)
      if (lookupTool(lodestarName) !== undefined) {
        throw new Error(
          `mcp-proxy: tool '${lodestarName}' is already registered in the action-kernel. This usually means a prior MCPProxy instance did not call stop() (which deregisters its tools), or two proxies are coexisting in the same process for the same downstream name. Stop the prior proxy or rename the downstream server in your config.`,
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
