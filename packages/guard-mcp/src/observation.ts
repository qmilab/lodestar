import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  type Claim,
  type EvidenceItem,
  type EvidenceSet,
  type Observation,
  registry,
} from "@qmilab/lodestar-core"
import {
  type ClaimExtractor,
  EvidenceLinker,
  type ExtractionInput,
  lookupExtractor,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import type { BeliefStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"

/**
 * Schema-bound observation payload for tool calls forwarded through the
 * MCP proxy. One observation per inbound `tools/call` from the wrapped
 * agent. The downstream MCP server's CallToolResult is captured here
 * along with the original tool name and arguments, so the trust report
 * can show exactly what crossed the boundary.
 *
 * Keeping a single observation schema (rather than one per downstream
 * tool) is deliberate: the MCP proxy is plumbing, not a tool author. It
 * has no schema knowledge about what filesystem.read_file or git.status
 * mean — the downstream server owns that. What the proxy DOES know is
 * the shape of the MCP CallToolResult envelope, and it can faithfully
 * record that.
 */
export const MCPToolResultObservationSchema = z.object({
  /** The fully-qualified Lodestar tool name, e.g. "mcp.filesystem.read_file". */
  tool_name: z.string(),
  /** Original arguments the wrapped agent supplied. Untyped — downstream validates. */
  args: z.record(z.unknown()),
  /** The downstream server's name as declared in proxy config. */
  downstream_server: z.string(),
  /** Whether the downstream marked this result as an error. */
  is_error: z.boolean(),
  /**
   * Raw content blocks from the CallToolResult, in order.
   *
   * The known set is text/image/audio/resource. Forward-compatibility
   * for content kinds Lodestar does not model yet uses an explicit
   * `"unknown"` discriminant so TypeScript narrowing still works
   * downstream — the shaping function in `tool-adapter.ts`
   * translates an unrecognised wire `type` into this tag and stashes
   * the original block under `raw`.
   */
  content: z.array(
    // Every variant uses `.catchall(z.unknown())` so forward-compat
    // fields the MCP spec carries on content blocks — `annotations`
    // (audience/priority/lastModified), `_meta`, future fields —
    // round-trip through the observation unchanged. Pre-fix, the
    // mapper cherry-picked only the documented fields, so an agent
    // that consumed annotations or `_meta` from a successful tool
    // call had them silently disappear.
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("text"),
          text: z.string(),
        })
        .catchall(z.unknown()),
      z
        .object({
          type: z.literal("image"),
          data: z.string(),
          mimeType: z.string(),
        })
        .catchall(z.unknown()),
      z
        .object({
          type: z.literal("audio"),
          data: z.string(),
          mimeType: z.string(),
        })
        .catchall(z.unknown()),
      z
        .object({
          type: z.literal("resource"),
          // MCP embedded resources carry payload as EITHER `text`
          // (UTF-8 string) OR `blob` (base64-encoded binary). Both
          // fields are optional in the schema so the proxy preserves
          // whichever the downstream sent; the SDK enforces "exactly
          // one" at the wire. The inner object also uses
          // `.catchall(z.unknown())` so block-level `_meta` on the
          // resource (distinct from the outer block's `_meta`) is
          // preserved.
          resource: z
            .object({
              uri: z.string(),
              mimeType: z.string().optional(),
              text: z.string().optional(),
              blob: z.string().optional(),
            })
            .catchall(z.unknown()),
        })
        .catchall(z.unknown()),
      // `resource_link` — current-spec MCP content block that points
      // at a resource by URI without inlining its bytes. Distinct from
      // `resource` (which embeds the payload).
      z
        .object({
          type: z.literal("resource_link"),
          uri: z.string(),
          name: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
        })
        .catchall(z.unknown()),
      z
        .object({
          type: z.literal("unknown"),
          original_type: z.string(),
          raw: z.unknown(),
        })
        .catchall(z.unknown()),
    ]),
  ),
  /**
   * Machine-readable typed output some MCP tools include alongside the
   * human-readable `content` blocks. Tools that declare an
   * `outputSchema` typically populate this; the proxy must round-trip
   * it unchanged or agents that rely on the structured field break
   * even though the tool call succeeded.
   *
   * Optional, permissive shape — the contents are tool-specific.
   */
  structured_content: z.record(z.string(), z.unknown()).optional(),
  /**
   * Result-level `_meta` from the downstream's `CallToolResult`. The
   * MCP spec uses this for protocol-level metadata (progress tokens,
   * task associations, server-defined extensions). Pre-fix the
   * proxy dropped it, so agents that consume `_meta` saw nothing
   * even when the downstream populated it. Round-tripped to the
   * upstream as `_meta` by `payloadToCallToolResult`.
   */
  meta: z.record(z.string(), z.unknown()).optional(),
})

export type MCPToolResultObservationPayload = z.infer<
  typeof MCPToolResultObservationSchema
>

export const MCP_TOOL_RESULT_SCHEMA_KEY = "mcp.tool_result@1"

/**
 * Register the MCP tool result observation schema with the global
 * schema registry. Idempotent — the registry's own state is the
 * source of truth, so after `registry._resetForTests()` a subsequent
 * call will re-register cleanly (necessary because probes share the
 * registry singleton).
 *
 * Called once by `registerMCPProxyExtractors()` at proxy startup.
 */
export function registerMCPToolResultSchema(): void {
  if (registry.has(MCP_TOOL_RESULT_SCHEMA_KEY)) return
  registry.register(MCP_TOOL_RESULT_SCHEMA_KEY, MCPToolResultObservationSchema)
}

/**
 * Relation marker on a Claim's structured_predicate that flags the
 * claim as carrying text that came from a document/resource inside the
 * MCP tool's response (file contents, embedded resources, etc.). The
 * MCP-aware evidence linker reads this marker to downgrade the source
 * observation's evidence quality from `tool_result` to
 * `external_document`, which trips the firewall's auto-observation
 * gate (Round 5 Parallax invariant).
 */
export const MCP_EXTERNAL_DOCUMENT_RELATION = "mcp.external_document_content"

/**
 * Relation marker on a Claim's structured_predicate for the
 * tool-result envelope claim — "tool X called with args Y returned N
 * content blocks". The fact of the call is `tool_result` evidence
 * quality.
 */
export const MCP_TOOL_INVOCATION_RELATION = "mcp.tool_invocation"

/**
 * Schema-bound extractor for `mcp.tool_result@1` observations.
 *
 * Emits two distinct kinds of claims so the evidence-quality layer can
 * treat them differently:
 *
 *   1. **Envelope claim** — "tool X invocation Y returned N content
 *      blocks, isError=Z". Quality = `tool_result`. This is the
 *      record of what crossed the boundary.
 *
 *   2. **External document content claims** — one per text or
 *      embedded-resource content block. Quality = `external_document`.
 *      These carry the potentially-hostile contents of a file or
 *      web page, and the firewall's auto-observation gate prevents
 *      them from promoting to `truth_status: supported` without a
 *      higher-authority confirmation.
 *
 * Image and audio content blocks are recorded in the envelope but do
 * not produce per-block claims in v0 — they are not text the planner
 * can reason against. A future extractor can change that.
 */
export const MCPToolResultExtractor: ClaimExtractor = {
  schema_key: MCP_TOOL_RESULT_SCHEMA_KEY,
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = MCPToolResultObservationSchema.parse(obs.payload)
    const ctx = input.context
    const now = new Date().toISOString()
    const claims: Claim[] = []

    const contentKinds = payload.content.map((block) => block.type)
    const envelopeStatement =
      `MCP tool '${payload.tool_name}' (server: ${payload.downstream_server}) ` +
      `returned ${payload.content.length} content block${payload.content.length === 1 ? "" : "s"} ` +
      `[${contentKinds.join(", ")}]` +
      (payload.is_error ? " (downstream marked is_error=true)" : "")

    claims.push({
      id: randomUUID(),
      statement: envelopeStatement,
      structured_predicate: {
        subject: `tool:${payload.tool_name}`,
        relation: MCP_TOOL_INVOCATION_RELATION,
        object: {
          args: payload.args,
          content_kinds: contentKinds,
          is_error: payload.is_error,
          invocation_id: obs.source.invocation_id,
        },
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })

    payload.content.forEach((block, index) => {
      // The text of an "image"/"audio" block is base64 binary data and is
      // not a document-style claim. A "resource" block may or may not have
      // inlined text (it can be a URI reference). We extract claim text
      // from text blocks unconditionally, and from resource blocks only
      // when they include inlined text. Future extractors can read
      // resources by URI; v0 stays local.
      let text: string | undefined
      let subject: string | undefined
      if (block.type === "text") {
        text = block.text
        subject = `mcp_content:${payload.tool_name}:${obs.source.invocation_id}:#${index}`
      } else if (block.type === "resource") {
        text = block.resource.text
        subject = `mcp_resource:${block.resource.uri}`
      } else {
        return
      }
      if (text === undefined || text.length === 0) return

      // Truncate long content in the human-readable statement so the
      // trust report stays scannable; the full content lives in the
      // observation payload, not the claim statement.
      const truncatedStatement = text.length > 200 ? `${text.slice(0, 200)}…` : text
      claims.push({
        id: randomUUID(),
        statement:
          `External document content via '${payload.tool_name}' content block #${index}: ${truncatedStatement}`,
        structured_predicate: {
          subject,
          relation: MCP_EXTERNAL_DOCUMENT_RELATION,
          // Object carries the verbatim text. The world model index will
          // pick this up keyed by subject; subsequent reads of the same
          // resource can update it without losing provenance because the
          // observation id is in source_observation_ids.
          object: { text, content_index: index },
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      })
    })

    return claims
  },
}

/**
 * Evidence linker that downgrades evidence quality for MCP claims
 * whose source is an external-document content block.
 *
 * The base EvidenceLinker treats every non-synthetic observation as
 * `direct_observation` evidence — fine for first-party tools like
 * `fs.read` running inside Lodestar's own sandbox, but wrong for an
 * MCP CallToolResult whose contents could be a file the agent was
 * asked to summarise. Per Guardrail #4 in the Batch 3 spec:
 *
 *   "the fact that we read this file is tool_result evidence, but
 *    any claims extracted from the file's contents are
 *    external_document evidence."
 *
 * This linker enforces that:
 *   - claims with `structured_predicate.relation = mcp.tool_invocation`
 *     → source evidence is `tool_result` quality
 *   - claims with `structured_predicate.relation =
 *     mcp.external_document_content` → source evidence is
 *     `external_document` quality
 *   - all other claims fall through to base behaviour
 *     (`direct_observation` quality).
 *
 * The downgrade to `external_document` is what trips the Round 5
 * auto-observation gate inside CognitiveCore, keeping hostile content
 * from auto-promoting to `truth_status: supported`.
 */
export class MCPAwareEvidenceLinker extends EvidenceLinker {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    beliefs: BeliefStore,
  ) {
    super(evidenceStore, beliefs)
  }

  override async linkForClaim(input: {
    claim: Claim
    source_observations: Observation[]
    assessor_actor_id: string
  }): Promise<EvidenceSet> {
    const relation = input.claim.structured_predicate?.relation
    const targetQuality: EvidenceItem["quality"] | undefined =
      relation === MCP_EXTERNAL_DOCUMENT_RELATION
        ? "external_document"
        : relation === MCP_TOOL_INVOCATION_RELATION
          ? "tool_result"
          : undefined
    if (targetQuality === undefined) {
      // Non-MCP claim, defer to the base linker. (Hosts that share a
      // single CognitiveCore across MCP and non-MCP claims will land
      // here for the non-MCP paths.)
      return super.linkForClaim(input)
    }
    // Re-implement linkForClaim's body with the MCP-adjusted quality.
    // Doing this here — rather than calling super and then overwriting
    // the persisted evidence set — avoids a duplicate `put` against
    // EvidenceStore, which is a strict insert and would throw on the
    // second write.
    const items: EvidenceItem[] = input.source_observations.map((obs) => ({
      source_id: obs.id,
      relation: "supports",
      quality: obs.trust === "synthetic" ? "synthetic_probe" : targetQuality,
      independence_group: `obs:${obs.source.tool}`,
      freshness: "fresh",
      notes: `mcp.${relation === MCP_EXTERNAL_DOCUMENT_RELATION ? "external_document" : "tool_invocation"} from ${obs.schema}`,
    }))
    const evidenceSet: EvidenceSet = {
      id: randomUUID(),
      claim_id: input.claim.id,
      items,
      assessed_by: input.assessor_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidenceStore.put(evidenceSet)
    return evidenceSet
  }
}

/**
 * Register the MCP schema + extractor with the cognitive core's
 * registry. Idempotent — uses the registry's own state for guarding
 * so a probe's `_resetForTests()` cleanly re-registers on the next
 * call.
 *
 * Called once by `MCPProxy.start()` before any observation is ingested.
 */
export function registerMCPProxyExtractors(): void {
  registerMCPToolResultSchema()
  // The extractor registry throws on duplicate registration. Guard
  // via lookupExtractor, which falls back to a `__generic__` entry
  // when the specific key is missing — so we test identity by
  // `schema_key` rather than mere presence.
  const existing = lookupExtractor(MCP_TOOL_RESULT_SCHEMA_KEY)
  if (existing && existing.schema_key === MCP_TOOL_RESULT_SCHEMA_KEY) return
  registerExtractor(MCPToolResultExtractor)
}
