/**
 * Reserved key inside an MCP `_meta` object. Carries Lodestar-
 * authored markers (`kind`, `tool_name`, `reason`, `action_id`,
 * `args`, `denied_at`) that probes, sentinels, and clients use to
 * recognise proxy-emitted control results — specifically the
 * `policy_denied` / `tool_not_advertised` / `tool_registration_lost`
 * / `execution_failed` / `precondition_failed` decisions the proxy
 * makes.
 *
 * The proxy MUST strip this key from any downstream-supplied `_meta`
 * before forwarding upstream and before persisting in an
 * observation; otherwise a hostile or compromised downstream server
 * could spoof a `_lodestar.kind: "policy_denied"` marker on its own
 * result and trick `isPolicyDeniedResult` (and any sentinel that
 * pattern-matches on the marker) into misclassifying a real tool
 * result as a Lodestar decision.
 */
export const LODESTAR_META_KEY = "_lodestar"

/**
 * Return a shallow copy of `meta` with the reserved Lodestar key
 * removed. Used by both the capture path
 * (`shapeMCPCallToolResultAsObservation`) and the round-trip path
 * (`payloadToCallToolResult`) — belt-and-braces against any
 * intermediate code that doesn't filter on its own.
 *
 * Pass-through if `meta` does not contain the reserved key, or if
 * `meta` is null/undefined.
 */
export function stripReservedLodestarMeta<T extends Record<string, unknown> | undefined>(
  meta: T,
): T {
  if (meta === undefined) return meta
  if (meta === null) return meta
  if (!(LODESTAR_META_KEY in meta)) return meta
  const filtered: Record<string, unknown> = {}
  for (const key of Object.keys(meta)) {
    if (key === LODESTAR_META_KEY) continue
    filtered[key] = (meta as Record<string, unknown>)[key]
  }
  return filtered as T
}

/**
 * Synthetic MCP CallToolResult constructed when the Action Kernel
 * denies a forwarded tool call. The wrapped agent receives a
 * structured tool result — NOT an MCP-level protocol error — so it
 * can read the denial as a normal tool response and revise its plan
 * rather than treating it as a transport-level abort.
 *
 * Choice rationale (locked at the start of Batch 3): protocol errors
 * make most existing agents (Claude Code, Cursor, Aider) report a
 * fatal transport failure and stop the session. A synthetic tool
 * result with `isError: true` is read by the agent as "the tool
 * failed, here is why, plan around it." That gives the trust layer
 * leverage to shape agent behaviour rather than blocking it
 * brittlely.
 *
 * The structured `_lodestar` payload is included as a text content
 * block alongside the human-readable message so downstream consumers
 * (sentinels, post-hoc analysis) can detect denial events
 * machine-readably without parsing prose.
 */
export interface PolicyDeniedDetails {
  /** Fully-qualified Lodestar tool name (e.g. "mcp.filesystem.write_file"). */
  tool_name: string
  /** The arguments the wrapped agent supplied; recorded for the audit trail. */
  args: Record<string, unknown>
  /** Human-readable reason the policy gate produced. */
  reason: string
  /**
   * Optional categorisation: e.g. "trust_level_too_low",
   * "precondition_failed", "tool_not_registered". Sentinels can pattern
   * match on this without parsing the reason text.
   */
  kind?: string
  /** The Action ID the kernel assigned, for cross-referencing the event log. */
  action_id?: string
}

/**
 * Content block kinds the proxy can emit upstream.
 *
 * Mirrors the MCP `CallToolResult` content union (as of protocol
 * version 2025-03-26): text, image, audio, and embedded resource.
 * Synthetic results (policy_denied, kernel-level errors) emit text;
 * forwarded results from a downstream server pass each block through
 * unchanged. Pre-Codex review this was text-only, which silently
 * corrupted image/audio/resource downstream tools — now fixed.
 */
/**
 * Each variant carries an `& { [k: string]: unknown }` index signature
 * so the proxy can round-trip MCP's forward-compatible fields
 * (`annotations`, block-level `_meta`, future spec additions)
 * unchanged. Without it, the round-trip path would have no place to
 * stash those keys and they would be silently dropped — Codex's
 * concern about transparent wrapping.
 */
export type CallToolContentBlock =
  | ({ type: "text"; text: string } & { [k: string]: unknown })
  | ({ type: "image"; data: string; mimeType: string } & { [k: string]: unknown })
  | ({ type: "audio"; data: string; mimeType: string } & { [k: string]: unknown })
  | ({
      type: "resource"
      /**
       * Embedded resource payload. The MCP wire format carries EITHER
       * `text` (UTF-8) OR `blob` (base64). The proxy must preserve
       * whichever the downstream sent; dropping `blob` would silently
       * corrupt binary embeds (PDFs, images-as-resource, etc.). The
       * inner index signature carries resource-level `_meta`.
       */
      resource: {
        uri: string
        mimeType?: string
        text?: string
        blob?: string
      } & { [k: string]: unknown }
    } & { [k: string]: unknown })
  | ({
      type: "resource_link"
      uri: string
      name: string
      title?: string
      description?: string
      mimeType?: string
      size?: number
    } & { [extra: string]: unknown })

export interface CallToolResultLike {
  content: CallToolContentBlock[]
  isError: boolean
  /**
   * Machine-readable typed output. Tools with a declared output schema
   * populate this alongside the human-readable `content`. The proxy
   * must round-trip it unchanged or agents that consume the structured
   * field break despite the tool call succeeding.
   */
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * Build a CallToolResult-shaped object that reports a policy denial.
 *
 * Returns a plain object (not a class instance) so it serialises
 * cleanly across the MCP transport. The MCP TypeScript SDK accepts
 * any value that conforms to the CallToolResult schema; this matches.
 */
export function buildPolicyDeniedResult(
  details: PolicyDeniedDetails,
): CallToolResultLike {
  const kind = details.kind ?? "policy_denied"
  const humanText =
    `Lodestar policy denied this tool call.\n\n` +
    `Tool: ${details.tool_name}\n` +
    `Reason: ${details.reason}\n` +
    `Denial kind: ${kind}` +
    (details.action_id ? `\nAction id: ${details.action_id}` : "")

  return {
    content: [{ type: "text", text: humanText }],
    isError: true,
    _meta: {
      _lodestar: {
        kind,
        tool_name: details.tool_name,
        reason: details.reason,
        action_id: details.action_id,
        args: details.args,
        denied_at: new Date().toISOString(),
      },
    },
  }
}

/**
 * Returns true if a CallToolResult was produced by
 * `buildPolicyDeniedResult` rather than by an actual downstream
 * server. Used by tests, probes, and the wrapped example to assert
 * the agent saw a denial.
 *
 * Detects via the `_meta._lodestar.kind` marker — bespoke and not
 * something a downstream server is likely to fake by accident.
 */
export function isPolicyDeniedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false
  const meta = (result as { _meta?: unknown })._meta
  if (typeof meta !== "object" || meta === null) return false
  const marker = (meta as { _lodestar?: unknown })._lodestar
  if (typeof marker !== "object" || marker === null) return false
  return typeof (marker as { kind?: unknown }).kind === "string"
}
