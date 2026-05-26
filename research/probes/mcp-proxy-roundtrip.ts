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

    return {
      passed: true,
      details:
        `MCP proxy round-trip clean: ${envelopes.length} envelopes carried real ` +
        `session/project IDs (no stub leak); chain proposed→approved→completed ` +
        `present; observation.recorded carried schema='${MCP_TOOL_RESULT_SCHEMA_KEY}'; ` +
        `${claims.length} claims extracted with at least one ${MCP_TOOL_INVOCATION_RELATION}; ` +
        `${beliefs.length} beliefs adopted (at least one supported); fake downstream ` +
        `was called exactly once and the text content round-tripped unchanged.`,
    }
  } finally {
    await rm(logDir, { recursive: true, force: true })
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
