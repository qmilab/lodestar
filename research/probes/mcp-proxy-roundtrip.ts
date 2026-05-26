#!/usr/bin/env bun
/**
 * Probe: mcp_proxy_roundtrip
 *
 * Verifies that a tool call through the Batch 3 MCP proxy produces the
 * expected epistemic-chain entries in the event log, with real
 * session/project IDs propagated end-to-end (no stub leak).
 *
 * Flow:
 *   1. Construct an `MCPProxy` against an in-process fake downstream
 *      that advertises one tool, `echo`, and returns a text content
 *      block when called.
 *   2. Start the proxy (no-op upstream so we don't open stdio).
 *   3. Drive one `handleCallTool` invocation directly — the same code
 *      path that runs when an MCP client calls `tools/call`.
 *   4. Read the persisted event log and assert:
 *      a. Every envelope carries the host-provided session/project IDs.
 *      b. The chain `action.proposed → action.approved →
 *         action.completed` is present.
 *      c. `observation.recorded` carries the `mcp.tool_result@1`
 *         schema key and the host's session/project ids in context.
 *      d. At least one Claim with the
 *         `mcp.tool_invocation` predicate relation was extracted.
 *      e. At least one Belief was adopted at `truth_status: supported`
 *         (the envelope claim — tool_result quality, strong enough to
 *         auto-promote).
 *      f. The returned CallToolResult round-tripped the downstream
 *         text content faithfully.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import type {
  Belief,
  Claim,
  EventEnvelope,
  Observation,
} from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import {
  DownstreamConnection,
  MCPProxy,
  MCP_TOOL_INVOCATION_RELATION,
  MCP_TOOL_RESULT_SCHEMA_KEY,
  type ProxyConfig,
  UpstreamServer,
} from "@qmilab/lodestar-guard-mcp"
import type {
  CallToolResult,
  Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"

interface ProbeResult {
  passed: boolean
  details: string
}

const REAL_SESSION_ID = "probe-session-roundtrip-7e3f"
const REAL_PROJECT_ID = "probe-project-roundtrip-9a1c"
const REAL_ACTOR_ID = "agent:probe-roundtrip"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "echo"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`

class FakeDownstreamConnection extends DownstreamConnection {
  constructor(
    cfg: ProxyConfig["downstream_servers"][number],
    private readonly fakeTools: MCPTool[],
    private readonly fakeCallTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<CallToolResult>,
  ) {
    super(cfg, { name: "probe-fake-client", version: "0.0.0" })
  }
  override async start(): Promise<void> {}
  override getTools(): readonly MCPTool[] {
    return this.fakeTools
  }
  override async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return this.fakeCallTool(name, args)
  }
  override async stop(): Promise<void> {}
}

class NoOpUpstreamServer extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()
  registry._resetForTests()
  _resetEventLogStateForTests()

  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-mcp-roundtrip-"))
  try {
    const echoTool: MCPTool = {
      name: DOWNSTREAM_TOOL_NAME,
      description: "Echo a message back",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    }
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const fakeCallTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      calls.push({ name, args })
      const msg = typeof args.message === "string" ? args.message : ""
      return {
        content: [{ type: "text", text: `echo: ${msg}` }],
        isError: false,
      }
    }

    const config: ProxyConfig = {
      project_id: REAL_PROJECT_ID,
      actor_id: REAL_ACTOR_ID,
      session_id: REAL_SESSION_ID,
      log_root: logDir,
      default_scope: { level: "project", identifier: REAL_PROJECT_ID },
      default_sensitivity: "internal",
      auto_approve_ceiling: 2,
      downstream_servers: [
        { name: DOWNSTREAM_NAME, command: "not-spawned", args: [] },
      ],
      tool_defaults: {
        [LODESTAR_TOOL_NAME]: {
          reversibility: "reversible",
          permissions: [],
          sandbox: "read",
          required_trust_level: 0,
          blast_radius: "self",
        },
      },
    }

    const proxy = new MCPProxy(config, {
      downstreamFactory: (cfg) =>
        cfg.downstream_servers.map(
          (entry) => new FakeDownstreamConnection(entry, [echoTool], fakeCallTool),
        ),
      upstreamFactory: (tools, handler) =>
        new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
    })

    await proxy.start()

    // Drive one tool call directly — mirrors what a wrapped MCP agent
    // would do via tools/call.
    const result = await proxy.handleCallTool({
      name: LODESTAR_TOOL_NAME,
      arguments: { message: "hello" },
    })
    if (calls.length !== 1) {
      return {
        passed: false,
        details: `expected the fake downstream to be called exactly once, got ${calls.length}`,
      }
    }
    if (result.isError === true) {
      const meta = (result._meta as { _lodestar?: unknown })?._lodestar ?? "(no _meta marker)"
      const firstText = result.content[0]?.type === "text" ? result.content[0].text : "(no text content)"
      return {
        passed: false,
        details:
          `expected the round-trip CallToolResult to have isError=false; got true. ` +
          `Meta: ${JSON.stringify(meta)}. Text: ${firstText}`,
      }
    }
    const text = result.content[0]?.type === "text" ? result.content[0].text : undefined
    if (text !== "echo: hello") {
      return {
        passed: false,
        details: `result text round-trip mismatch: got '${text ?? "(undefined)"}', expected 'echo: hello'`,
      }
    }

    await proxy.stop()

    // Read the persisted event log and project the chain.
    const reader = new EventLogReader(logDir)
    const envelopes: EventEnvelope[] = await reader.readSession(
      REAL_PROJECT_ID,
      REAL_SESSION_ID,
    )

    if (envelopes.length === 0) {
      return {
        passed: false,
        details:
          `no events found in the log for session=${REAL_SESSION_ID}, project=${REAL_PROJECT_ID}. ` +
          `Either the writer didn't flush or the IDs leaked into a different partition.`,
      }
    }

    // (a) Every envelope carries the real session/project IDs.
    for (const env of envelopes) {
      if (
        env.session_id !== REAL_SESSION_ID ||
        env.project_id !== REAL_PROJECT_ID
      ) {
        return {
          passed: false,
          details:
            `event ${env.id} type=${env.type} carries session=${env.session_id} ` +
            `project=${env.project_id} (expected ${REAL_SESSION_ID} / ${REAL_PROJECT_ID}). ` +
            `Likely a stub-fallback regression in the proxy or kernel.`,
        }
      }
      if (
        env.session_id === "session-stub" ||
        env.project_id === "project-stub"
      ) {
        return {
          passed: false,
          details:
            `event ${env.id} type=${env.type} carries a Round-5-forbidden stub id`,
        }
      }
    }

    // (b) Chain: proposed → approved → completed.
    const types = envelopes.map((e) => e.type)
    for (const expected of ["action.proposed", "action.approved", "action.completed"]) {
      if (!types.includes(expected)) {
        return {
          passed: false,
          details:
            `expected event of type '${expected}' in the chain; saw [${types.join(", ")}]`,
        }
      }
    }

    // (c) Observation.recorded carries the right schema + context.
    const obsEvent = envelopes.find((e) => e.type === "observation.recorded")
    if (!obsEvent) {
      return { passed: false, details: "no observation.recorded event in the log" }
    }
    const obs = obsEvent.payload as Observation
    if (obs.schema !== MCP_TOOL_RESULT_SCHEMA_KEY) {
      return {
        passed: false,
        details:
          `observation.recorded carried schema='${obs.schema}', expected '${MCP_TOOL_RESULT_SCHEMA_KEY}'`,
      }
    }
    if (
      obs.context.session_id !== REAL_SESSION_ID ||
      obs.context.project_id !== REAL_PROJECT_ID
    ) {
      return {
        passed: false,
        details:
          `observation.context = ${JSON.stringify(obs.context)}; expected ` +
          `session=${REAL_SESSION_ID} project=${REAL_PROJECT_ID}`,
      }
    }

    // (d) The tool_invocation envelope claim was extracted.
    const claimEvents = envelopes.filter((e) => e.type === "claim.extracted")
    const claims = claimEvents.map((e) => e.payload as Claim)
    const envelopeClaim = claims.find(
      (c) => c.structured_predicate?.relation === MCP_TOOL_INVOCATION_RELATION,
    )
    if (!envelopeClaim) {
      return {
        passed: false,
        details:
          `expected at least one claim with structured_predicate.relation=` +
          `'${MCP_TOOL_INVOCATION_RELATION}'; saw ${claims.length} claims with ` +
          `relations: [${claims.map((c) => c.structured_predicate?.relation ?? "(none)").join(", ")}]`,
      }
    }

    // (e) At least one Belief adopted at truth_status: supported.
    const beliefEvents = envelopes.filter((e) => e.type === "belief.adopted")
    const beliefs = beliefEvents.map((e) => e.payload as Belief)
    const supportedBelief = beliefs.find((b) => b.truth_status === "supported")
    if (!supportedBelief) {
      return {
        passed: false,
        details:
          `expected at least one belief at truth_status='supported' (the ` +
          `envelope claim is tool_result quality, strength 0.85, should ` +
          `auto-promote); saw ${beliefs.length} beliefs with statuses: ` +
          `[${beliefs.map((b) => b.truth_status).join(", ")}]`,
      }
    }

    await proxy.stop()

    // ─────────────────────────────────────────────────────────────
    // Sub-case B: image content blocks round-trip unchanged.
    //
    // Codex review P2.1: pre-fix, the proxy downgraded image / audio
    // / resource blocks to text placeholders, silently corrupting
    // any downstream that returned non-text content. Verify the
    // upstream receives the original image bytes + mimeType.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subBResult = await subcaseImageRoundtrip(logDir)
    if (!subBResult.passed) return subBResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case C: two concurrent tools/call invocations do not race.
    //
    // Codex review P1.2: pre-fix, `MCPProxy.capture` was a single
    // slot the observation sink wrote to. Overlapping calls would
    // overwrite each other's capture, leading the proxy to return
    // call A's observation for call B's response (or throw "no
    // observation produced"). The fix keys captures by
    // invocation_id. Verify that two calls launched in parallel
    // each receive their own result.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subCResult = await subcaseConcurrentCalls(logDir)
    if (!subCResult.passed) return subCResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case D: a second MCPProxy in the same process starts
    // cleanly after the first is stopped.
    //
    // Codex review P2.2: pre-fix, tool-adapter silently skipped
    // re-registration when a name was already present, so a second
    // proxy would advertise the tool but execute against the prior
    // (dead) proxy's downstream closure. The fix is twofold:
    // `unregisterTool` in action-kernel + `MCPProxy.stop()`
    // deregistering the tools it owns. Verify start → stop → start
    // cycles cleanly.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subDResult = await subcaseStopThenRestart(logDir)
    if (!subDResult.passed) return subDResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case E: embedded resource `blob` round-trips unchanged.
    //
    // Codex review round 2, P2.1: the resource branch dropped the
    // base64 `blob` field (preserved only uri/mimeType/text).
    // Verifies a downstream returning a binary-payload resource
    // (PDF, etc.) survives the proxy with its bytes intact.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subEResult = await subcaseResourceBlobRoundtrip(logDir)
    if (!subEResult.passed) return subEResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case F: registerDownstreamToolsWithKernel is transactional.
    //
    // Codex review round 2, P2.3: when the helper throws partway
    // through a downstream's tool list (e.g., a name collision on
    // the fifth tool), the earlier four registrations stranded in
    // the process-wide kernel registry. Verify the helper rolls
    // back its own partial work AND a subsequent proxy.start()
    // works cleanly.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subFResult = await subcaseHelperRollback(logDir)
    if (!subFResult.passed) return subFResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case G: resource_link content blocks round-trip with all
    // metadata preserved.
    //
    // Codex review round 3, P2.2: pre-fix resource_link fell into
    // the "unknown" branch and got corrupted to a text placeholder,
    // dropping URI / name / mimeType / size for agents that consume
    // current-spec MCP servers.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subGResult = await subcaseResourceLinkRoundtrip(logDir)
    if (!subGResult.passed) return subGResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case H: structuredContent on CallToolResult round-trips.
    //
    // Codex review round 3, P2.3: tools that declare an output
    // schema emit `structuredContent` alongside `content`. Pre-fix
    // the proxy dropped it, breaking agents that consume the typed
    // field.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subHResult = await subcaseStructuredContentRoundtrip(logDir)
    if (!subHResult.passed) return subHResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case I: result-level _meta and content-block annotations /
    // _meta round-trip unchanged.
    //
    // Codex review round 4, P2.1: the mapper cherry-picked only the
    // documented fields from each block and dropped result-level
    // _meta, content _meta, and annotations. Any downstream MCP
    // server whose client consumed those fields would see them
    // silently disappear despite the tool call succeeding.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subIResult = await subcaseMetadataRoundtrip(logDir)
    if (!subIResult.passed) return subIResult

    // ─────────────────────────────────────────────────────────────
    // Sub-case J: a failed start() does NOT emit guard.session.ended
    // on top of guard.session.failed.
    //
    // Codex review round 4, P2.2: pre-fix, after start() threw the
    // CLI's catch path called proxy.stop(), which still saw
    // started=true and emitted guard.session.ended — making a
    // failed session look cleanly closed. Verify the rollback now
    // resets started, so a follow-up stop() is a no-op.
    // ─────────────────────────────────────────────────────────────
    _resetToolsForTests()
    _resetEventLogStateForTests()
    const subJResult = await subcaseFailedStartNoSpuriousEnd(logDir)
    if (!subJResult.passed) return subJResult

    return {
      passed: true,
      details:
        `MCP proxy round-trip clean: ${envelopes.length} envelopes carried real ` +
        `session/project IDs (no stub leak); chain proposed→approved→completed ` +
        `present; observation.recorded carried schema='${MCP_TOOL_RESULT_SCHEMA_KEY}'; ` +
        `${claims.length} claims extracted with at least one ${MCP_TOOL_INVOCATION_RELATION}; ` +
        `${beliefs.length} beliefs adopted (at least one supported); fake downstream ` +
        `was called exactly once and the text content round-tripped unchanged. ` +
        `Sub-case B (image round-trip): ${subBResult.details}. ` +
        `Sub-case C (concurrent calls): ${subCResult.details}. ` +
        `Sub-case D (stop+restart): ${subDResult.details}. ` +
        `Sub-case E (resource blob round-trip): ${subEResult.details}. ` +
        `Sub-case F (helper rollback): ${subFResult.details}. ` +
        `Sub-case G (resource_link round-trip): ${subGResult.details}. ` +
        `Sub-case H (structuredContent round-trip): ${subHResult.details}. ` +
        `Sub-case I (_meta + annotations round-trip): ${subIResult.details}. ` +
        `Sub-case J (failed start does not emit session.ended): ${subJResult.details}.`,
    }
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

/**
 * Sub-case I: result-level `_meta`, content-block `_meta`, and
 * `annotations` round-trip unchanged from the downstream through the
 * proxy to the upstream.
 */
async function subcaseMetadataRoundtrip(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "metasrv"
  const toolName = "annotated_text"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const RESULT_META = { progressToken: "p-xyz-123", "x-server-trace-id": "trace-9001" }
  const BLOCK_META = { "x-block-id": "blk-abc", custom_field: 42 }
  const BLOCK_ANNOTATIONS = {
    audience: ["user", "assistant"],
    priority: 0.8,
    lastModified: "2026-05-26T12:00:00Z",
  }
  const tool: MCPTool = {
    name: toolName,
    description: "Return text with annotations + _meta",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [tool]
    }
    override async callTool(): Promise<CallToolResult> {
      return {
        content: [
          {
            type: "text",
            text: "annotated content",
            annotations: BLOCK_ANNOTATIONS,
            _meta: BLOCK_META,
          },
        ] as unknown as CallToolResult["content"],
        isError: false,
        _meta: RESULT_META,
      } as CallToolResult
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-meta",
    actor_id: "agent:probe-roundtrip-meta",
    session_id: "probe-roundtrip-meta-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-meta" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    if (result.isError === true) {
      return { passed: false, details: `meta-roundtrip result.isError=true` }
    }
    // (1) result-level _meta survived
    if (!result._meta) {
      return {
        passed: false,
        details:
          `result._meta was undefined; expected to round-trip { progressToken, x-server-trace-id }`,
      }
    }
    if (JSON.stringify(result._meta) !== JSON.stringify(RESULT_META)) {
      return {
        passed: false,
        details: `result._meta did not round-trip exactly: ${JSON.stringify(result._meta)}`,
      }
    }
    // (2) content-block _meta survived
    const block = result.content[0]
    if (!block || block.type !== "text") {
      return { passed: false, details: `expected one text block; got ${block?.type ?? "(none)"}` }
    }
    const blockRecord = block as Record<string, unknown>
    if (JSON.stringify(blockRecord._meta) !== JSON.stringify(BLOCK_META)) {
      return {
        passed: false,
        details:
          `block._meta did not round-trip. Got: ${JSON.stringify(blockRecord._meta)}. ` +
          `Pre-fix block-level _meta and annotations were silently dropped.`,
      }
    }
    // (3) content-block annotations survived
    if (JSON.stringify(blockRecord.annotations) !== JSON.stringify(BLOCK_ANNOTATIONS)) {
      return {
        passed: false,
        details:
          `block.annotations did not round-trip. Got: ${JSON.stringify(blockRecord.annotations)}`,
      }
    }
  } finally {
    await proxy.stop()
  }
  return {
    passed: true,
    details:
      "result-level _meta, content-block _meta, and content-block annotations all round-tripped intact",
  }
}

/**
 * Sub-case J: when start() fails (e.g., a downstream throws on
 * connect), the proxy emits guard.session.failed and a follow-up
 * stop() does NOT emit guard.session.ended.
 */
async function subcaseFailedStartNoSpuriousEnd(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "willfail"
  // A downstream whose start() throws synchronously inside the
  // proxy's startup. This simulates "downstream command failed to
  // start" / "transport handshake broke" — both real failure
  // modes the Codex review called out.
  const FAILURE_REASON = "synthetic downstream-start failure"
  const failingDownstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {
      throw new Error(FAILURE_REASON)
    }
    override getTools(): readonly MCPTool[] {
      return []
    }
    override async callTool(): Promise<CallToolResult> {
      throw new Error("should never be called — start() already failed")
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-failedstart",
    actor_id: "agent:probe-roundtrip-failedstart",
    session_id: "probe-roundtrip-failedstart-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-failedstart" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {},
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [failingDownstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  let threw = false
  try {
    await proxy.start()
  } catch {
    threw = true
  }
  if (!threw) {
    await proxy.stop()
    return { passed: false, details: `proxy.start() did not throw despite failing downstream` }
  }
  // Mirror the CLI's catch path: call stop() after start() threw.
  // With the round-4 fix, this must NOT emit guard.session.ended.
  await proxy.stop()

  // Inspect the event log for this session.
  const reader = new EventLogReader(logDir)
  const envelopes = await reader.readSession(
    config.project_id,
    config.session_id as string,
  )
  const types = envelopes.map((e) => e.type)
  const hasFailed = types.includes("guard.session.failed")
  const hasEnded = types.includes("guard.session.ended")
  if (!hasFailed) {
    return {
      passed: false,
      details: `expected guard.session.failed in the log; got [${types.join(", ")}]`,
    }
  }
  if (hasEnded) {
    return {
      passed: false,
      details:
        `the trust report would show this failed startup as if it closed cleanly. ` +
        `guard.session.ended found alongside guard.session.failed: [${types.join(", ")}]`,
    }
  }
  return {
    passed: true,
    details:
      "failed start() emitted guard.session.failed; subsequent stop() did NOT emit guard.session.ended",
  }
}

/**
 * Sub-case G: resource_link block round-trips with metadata intact.
 */
async function subcaseResourceLinkRoundtrip(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "linksrv"
  const toolName = "find_resource"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const LINK_URI = "file:///workspace/docs/design.pdf"
  const LINK_NAME = "design.pdf"
  const LINK_DESCRIPTION = "Latest design document"
  const LINK_MIME = "application/pdf"
  const LINK_SIZE = 12345
  const tool: MCPTool = {
    name: toolName,
    description: "Find a resource by name",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [tool]
    }
    override async callTool(): Promise<CallToolResult> {
      // The SDK's CallToolResult type narrows content blocks; cast
      // the resource_link variant in since older type definitions
      // may not yet cover it.
      return {
        content: [
          {
            type: "resource_link",
            uri: LINK_URI,
            name: LINK_NAME,
            description: LINK_DESCRIPTION,
            mimeType: LINK_MIME,
            size: LINK_SIZE,
          },
        ] as unknown as CallToolResult["content"],
        isError: false,
      }
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-link",
    actor_id: "agent:probe-roundtrip-link",
    session_id: "probe-roundtrip-link-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-link" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    if (result.isError === true) {
      return { passed: false, details: `resource_link result.isError=true` }
    }
    const block = result.content[0]
    if (!block || block.type !== "resource_link") {
      return {
        passed: false,
        details:
          `expected content[0].type='resource_link'; got '${block?.type ?? "(none)"}'. ` +
          `Pre-fix this block fell through to "unknown" and was downgraded to a text placeholder.`,
      }
    }
    if (block.uri !== LINK_URI || block.name !== LINK_NAME) {
      return {
        passed: false,
        details: `resource_link uri/name did not round-trip (${block.uri} / ${block.name})`,
      }
    }
    if (block.description !== LINK_DESCRIPTION) {
      return { passed: false, details: `description did not round-trip` }
    }
    if (block.mimeType !== LINK_MIME) {
      return { passed: false, details: `mimeType did not round-trip` }
    }
    if (block.size !== LINK_SIZE) {
      return { passed: false, details: `size did not round-trip` }
    }
  } finally {
    await proxy.stop()
  }
  return {
    passed: true,
    details:
      "resource_link block round-tripped with uri + name + description + mimeType + size intact",
  }
}

/**
 * Sub-case H: structuredContent on CallToolResult round-trips.
 */
async function subcaseStructuredContentRoundtrip(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "typedsrv"
  const toolName = "query_weather"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const STRUCTURED = {
    location: "New York",
    temperature_f: 72,
    conditions: "partly cloudy",
    forecast_days: [
      { day: "Monday", high: 75, low: 60 },
      { day: "Tuesday", high: 78, low: 62 },
    ],
  }
  const tool: MCPTool = {
    name: toolName,
    description: "Query the weather",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [tool]
    }
    override async callTool(): Promise<CallToolResult> {
      return {
        content: [{ type: "text", text: "Weather in New York: 72°F, partly cloudy" }],
        isError: false,
        structuredContent: STRUCTURED,
      } as CallToolResult
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-structured",
    actor_id: "agent:probe-roundtrip-structured",
    session_id: "probe-roundtrip-structured-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-structured" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    if (result.isError === true) {
      return { passed: false, details: `structuredContent result.isError=true` }
    }
    if (result.structuredContent === undefined) {
      return {
        passed: false,
        details:
          `result.structuredContent was undefined; expected the typed payload to round-trip. ` +
          `Pre-fix the proxy dropped this field entirely.`,
      }
    }
    if (JSON.stringify(result.structuredContent) !== JSON.stringify(STRUCTURED)) {
      return {
        passed: false,
        details: `structuredContent did not round-trip exactly: ${JSON.stringify(result.structuredContent)}`,
      }
    }
  } finally {
    await proxy.stop()
  }
  return {
    passed: true,
    details:
      "structuredContent round-tripped intact alongside the text content blocks",
  }
}

/**
 * Sub-case E: a resource block with binary `blob` payload round-trips
 * unchanged.
 */
async function subcaseResourceBlobRoundtrip(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "blobsrv"
  const toolName = "fetch_pdf"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const PDF_BYTES_B64 = "JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFI+PgpzdHJlYW0KQlQKRVQKZW5kc3RyZWFtCmVuZG9iago="
  const PDF_MIME = "application/pdf"
  const PDF_URI = "file:///tmp/example.pdf"
  const tool: MCPTool = {
    name: toolName,
    description: "Fetch a binary resource",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [tool]
    }
    override async callTool(): Promise<CallToolResult> {
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: PDF_URI,
              mimeType: PDF_MIME,
              blob: PDF_BYTES_B64,
            },
          },
        ],
        isError: false,
      }
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-blob",
    actor_id: "agent:probe-roundtrip-blob",
    session_id: "probe-roundtrip-blob-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-blob" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    if (result.isError === true) {
      return { passed: false, details: `blob-roundtrip result.isError=true` }
    }
    const block = result.content[0]
    if (!block || block.type !== "resource") {
      return {
        passed: false,
        details:
          `expected the content block to round-trip as type='resource'; got ` +
          `type='${block?.type ?? "(none)"}'`,
      }
    }
    if (block.resource.uri !== PDF_URI) {
      return {
        passed: false,
        details: `resource.uri did not round-trip ('${block.resource.uri}' vs '${PDF_URI}')`,
      }
    }
    if (block.resource.mimeType !== PDF_MIME) {
      return {
        passed: false,
        details: `resource.mimeType did not round-trip`,
      }
    }
    if (block.resource.blob !== PDF_BYTES_B64) {
      return {
        passed: false,
        details:
          `resource.blob did not round-trip. Got: ${block.resource.blob ?? "(undefined)"}. ` +
          `Pre-fix this dropped the binary payload entirely — PDFs, images-as-resource, ` +
          `anything not text would lose its bytes on the way through the proxy.`,
      }
    }
    if (block.resource.text !== undefined) {
      return {
        passed: false,
        details:
          `resource.text was '${block.resource.text}', expected undefined ` +
          `(downstream sent blob only)`,
      }
    }
  } finally {
    await proxy.stop()
  }
  return {
    passed: true,
    details:
      "resource block with binary blob (uri + mimeType + base64 blob) round-tripped unchanged",
  }
}

/**
 * Sub-case F: when the tool-registration helper throws partway
 * through a downstream's tool list, the helper rolls back its own
 * earlier registrations from the same call so a retry sees a clean
 * registry.
 */
async function subcaseHelperRollback(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "rollback"
  const okToolName = "ok_tool"
  const collidingToolName = "colliding_tool"
  const okLodestarName = `mcp.${downstreamName}.${okToolName}`
  const collidingLodestarName = `mcp.${downstreamName}.${collidingToolName}`
  const okTool: MCPTool = {
    name: okToolName,
    description: "OK",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const collidingTool: MCPTool = {
    name: collidingToolName,
    description: "Will collide",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const downstreamBuilder = (): DownstreamConnection =>
    new (class extends DownstreamConnection {
      constructor() {
        super(
          { name: downstreamName, command: "not-spawned", args: [] },
          { name: "probe", version: "0.0.0" },
        )
      }
      override async start(): Promise<void> {}
      override getTools(): readonly MCPTool[] {
        return [okTool, collidingTool]
      }
      override async callTool(): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "ok" }], isError: false }
      }
      override async stop(): Promise<void> {}
    })()

  const cfg: ProxyConfig = {
    project_id: "probe-roundtrip-rollback",
    actor_id: "agent:probe-roundtrip-rollback",
    session_id: "probe-roundtrip-rollback-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-rollback" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [okLodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
      [collidingLodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }

  // Prime the kernel registry with a pre-existing tool that has the
  // same name as the SECOND tool the downstream advertises. This
  // forces the helper to throw on its second iteration, after it has
  // already registered the FIRST tool. Pre-fix the first
  // registration stayed in the registry.
  const {
    _resetToolsForTests: _reset,
    registerTool: registerToolFn,
  } = await import("@qmilab/lodestar-action-kernel")
  void _reset
  registerToolFn({
    name: collidingLodestarName,
    inputs: (await import("zod")).z.record((await import("zod")).z.unknown()),
    output_schema_key: "fs.read@1", // doesn't matter; never executed
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: () => [],
    execute: async () => {
      throw new Error("squatter — never called")
    },
  })

  const proxy = new MCPProxy(cfg, {
    downstreamFactory: () => [downstreamBuilder()],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  let threw = false
  try {
    await proxy.start()
  } catch (err) {
    threw = true
    void err
  }
  if (!threw) {
    await proxy.stop()
    return {
      passed: false,
      details: `proxy.start() did not throw despite a pre-existing colliding tool registration`,
    }
  }

  // The squatter is still registered (we didn't deregister it), but
  // crucially the helper's partial work (the `ok_tool` registration)
  // must have been rolled back. lookupTool of the OK name should
  // return undefined now.
  const { lookupTool } = await import("@qmilab/lodestar-action-kernel")
  if (lookupTool(okLodestarName) !== undefined) {
    return {
      passed: false,
      details:
        `${okLodestarName} is still registered after the helper threw. ` +
        `The transactional rollback failed; earlier registrations were ` +
        `stranded in the process-wide registry.`,
    }
  }
  return {
    passed: true,
    details:
      "helper threw on the second tool's name collision and rolled back the first tool's registration cleanly",
  }
}

/**
 * Sub-case B: image content blocks round-trip unchanged.
 */
async function subcaseImageRoundtrip(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "imgsrv"
  const toolName = "fetch_image"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const imageTool: MCPTool = {
    name: toolName,
    description: "Fetch an image",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const IMG_BYTES = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
  const IMG_MIME = "image/png"
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [imageTool]
    }
    override async callTool(): Promise<CallToolResult> {
      return {
        content: [{ type: "image", data: IMG_BYTES, mimeType: IMG_MIME }],
        isError: false,
      }
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-image",
    actor_id: "agent:probe-roundtrip-image",
    session_id: "probe-roundtrip-image-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-image" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    if (result.isError === true) {
      return { passed: false, details: `image-roundtrip result.isError=true; meta=${JSON.stringify(result._meta)}` }
    }
    if (result.content.length !== 1) {
      return {
        passed: false,
        details: `expected exactly one content block, got ${result.content.length}`,
      }
    }
    const block = result.content[0]
    if (!block || block.type !== "image") {
      return {
        passed: false,
        details:
          `expected the content block to round-trip as type='image'; got ` +
          `type='${block?.type ?? "(none)"}'. Likely the pre-fix text-placeholder ` +
          `downgrade regressed.`,
      }
    }
    if (block.data !== IMG_BYTES) {
      return {
        passed: false,
        details: `image bytes did not round-trip unchanged (data mismatch)`,
      }
    }
    if (block.mimeType !== IMG_MIME) {
      return {
        passed: false,
        details: `image mimeType did not round-trip ('${block.mimeType}' vs '${IMG_MIME}')`,
      }
    }
  } finally {
    await proxy.stop()
  }
  return { passed: true, details: "image block round-tripped unchanged (data + mimeType)" }
}

/**
 * Sub-case C: two concurrent tools/call invocations do not race on
 * the proxy's per-invocation capture.
 */
async function subcaseConcurrentCalls(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "concsrv"
  const toolName = "slow_echo"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const echoTool: MCPTool = {
    name: toolName,
    description: "Echo with an internal delay so calls interleave",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
    },
  }
  // Each call defers slightly so the second proposal/arbitration
  // overlaps with the first. Without per-invocation keying, the
  // capture slot races.
  const callTool = async (
    _name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const tag = String(args.tag)
    await new Promise((r) => setTimeout(r, tag === "first" ? 60 : 5))
    return {
      content: [{ type: "text", text: `echo:${tag}` }],
      isError: false,
    }
  }
  const downstream = new (class extends DownstreamConnection {
    constructor() {
      super(
        { name: downstreamName, command: "not-spawned", args: [] },
        { name: "probe", version: "0.0.0" },
      )
    }
    override async start(): Promise<void> {}
    override getTools(): readonly MCPTool[] {
      return [echoTool]
    }
    override async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> {
      return callTool(name, args)
    }
    override async stop(): Promise<void> {}
  })()

  const config: ProxyConfig = {
    project_id: "probe-roundtrip-concurrent",
    actor_id: "agent:probe-roundtrip-concurrent",
    session_id: "probe-roundtrip-concurrent-session",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-concurrent" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: () => [downstream],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  try {
    await proxy.start()
    const [resultFirst, resultSecond] = await Promise.all([
      proxy.handleCallTool({ name: lodestarName, arguments: { tag: "first" } }),
      proxy.handleCallTool({ name: lodestarName, arguments: { tag: "second" } }),
    ])
    const textFirst =
      resultFirst.content[0]?.type === "text" ? resultFirst.content[0].text : undefined
    const textSecond =
      resultSecond.content[0]?.type === "text" ? resultSecond.content[0].text : undefined
    if (textFirst !== "echo:first") {
      return {
        passed: false,
        details:
          `first call (tag=first, slow) round-tripped '${textFirst ?? "(undef)"}' ` +
          `instead of 'echo:first'. Captures raced — the proxy returned a ` +
          `different invocation's observation.`,
      }
    }
    if (textSecond !== "echo:second") {
      return {
        passed: false,
        details:
          `second call (tag=second, fast) round-tripped '${textSecond ?? "(undef)"}' ` +
          `instead of 'echo:second'. Captures raced.`,
      }
    }
  } finally {
    await proxy.stop()
  }
  return {
    passed: true,
    details:
      "two concurrent handleCallTool invocations each received their own observation",
  }
}

/**
 * Sub-case D: a second MCPProxy starts cleanly after the first stops.
 */
async function subcaseStopThenRestart(logDir: string): Promise<ProbeResult> {
  registry._resetForTests()
  const downstreamName = "lifecycle"
  const toolName = "noop"
  const lodestarName = `mcp.${downstreamName}.${toolName}`
  const noopTool: MCPTool = {
    name: toolName,
    description: "No-op",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
  const fakeCall = async (): Promise<CallToolResult> => ({
    content: [{ type: "text", text: "ok" }],
    isError: false,
  })
  const buildDownstream = (): DownstreamConnection =>
    new (class extends DownstreamConnection {
      constructor() {
        super(
          { name: downstreamName, command: "not-spawned", args: [] },
          { name: "probe", version: "0.0.0" },
        )
      }
      override async start(): Promise<void> {}
      override getTools(): readonly MCPTool[] {
        return [noopTool]
      }
      override async callTool(): Promise<CallToolResult> {
        return fakeCall()
      }
      override async stop(): Promise<void> {}
    })()

  const baseConfig: ProxyConfig = {
    project_id: "probe-roundtrip-lifecycle",
    actor_id: "agent:probe-roundtrip-lifecycle",
    session_id: "probe-roundtrip-lifecycle-1",
    log_root: logDir,
    default_scope: { level: "project", identifier: "probe-roundtrip-lifecycle" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [{ name: downstreamName, command: "not-spawned", args: [] }],
    tool_defaults: {
      [lodestarName]: {
        reversibility: "reversible",
        permissions: [],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }

  const first = new MCPProxy(baseConfig, {
    downstreamFactory: () => [buildDownstream()],
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  await first.start()
  await first.handleCallTool({ name: lodestarName, arguments: {} })
  await first.stop()

  // The second proxy must register the same lodestarName without
  // tripping the "already registered" guard in tool-adapter.
  const second = new MCPProxy(
    { ...baseConfig, session_id: "probe-roundtrip-lifecycle-2" },
    {
      downstreamFactory: () => [buildDownstream()],
      upstreamFactory: (tools, handler) =>
        new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
    },
  )
  try {
    await second.start()
  } catch (err) {
    return {
      passed: false,
      details:
        `second MCPProxy.start() threw after a clean stop of the first: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Pre-fix this happened because the tool-adapter silently skipped ` +
        `re-registration, leaving the kernel pointing at the dead closure.`,
    }
  }
  try {
    const result = await second.handleCallTool({
      name: lodestarName,
      arguments: {},
    })
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : undefined
    if (text !== "ok") {
      return {
        passed: false,
        details:
          `second proxy executed but the tool returned '${text ?? "(undef)"}'; ` +
          `expected 'ok'. The kernel may still be routing to the first proxy's ` +
          `closure (Codex P2.2).`,
      }
    }
  } finally {
    await second.stop()
  }
  return {
    passed: true,
    details:
      "second MCPProxy started and executed cleanly after the first stopped — registrations cycled",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: mcp_proxy_roundtrip")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
