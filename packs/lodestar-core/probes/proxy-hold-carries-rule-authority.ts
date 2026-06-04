#!/usr/bin/env bun
/**
 * Probe: proxy_hold_carries_rule_authority
 *
 * The MCP proxy's hold path used to open every `ApprovalRequest` from
 * `holdEvaluationForParkedAction()`, which hardcodes `required_authority: {}`.
 * So a matched `require_approval` rule's stricter authority — a
 * `min_trust_baseline` or a `scope` an approver must clear — never reached a
 * proxy hold; the request only ever carried the action's mapped
 * `sensitivity_clearance`. The fix wires a `CompiledPolicy` through the proxy
 * (default `autoApprovePolicyCompiled`, or an injected policy gate) and re-runs
 * its pure `evaluate()` on a hold to recover that authority. This probe is the
 * spec for that — it pins both halves:
 *
 * 1. RICH AUTHORITY — a proxy whose gate is a `CompiledPolicy` with a
 *    `require_approval` rule (carrying `min_trust_baseline` + `scope`) opens an
 *    `approval.requested@1` whose `required_authority` carries that
 *    `min_trust_baseline` and `scope`, AND the action's mapped
 *    `sensitivity_clearance` merged in. And the authority has teeth: an
 *    under-authorised approver `Actor` is refused by `authorizeResolution`,
 *    while one that clears trust + scope + clearance is authorised.
 *
 * 2. BARE-GATE CONTRAST — the same L4 tool under the default ceiling preset
 *    (no `require_approval` rule, so the hold is the L4 floor's) opens a request
 *    whose `required_authority` carries ONLY the mapped `sensitivity_clearance`:
 *    no `min_trust_baseline`, no `scope`. This is the pre-fix behaviour, and it
 *    proves case 1's richer authority came from the rule, not from the proxy
 *    fabricating it.
 *
 * Both cases set `approval_timeout_ms: 0` (don't wait): the proxy emits
 * `action.pending_approval` + `approval.requested@1` and returns
 * `approval_required` immediately, so the request is inspectable straight off
 * the log without driving a resolution.
 *
 * Why this matters: it is the seam that makes a declarative proxy policy's
 * authority constraints reach the `lodestar approve` authorisation check — the
 * difference between "any configured resolver may approve this external push"
 * and "only a project-scoped approver at trust ≥ 0.7 may".
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import {
  type Actor,
  type ApprovalRequest,
  type EventEnvelope,
  type Policy,
  registry,
} from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { authorizeResolution, compile } from "@qmilab/lodestar-guard"
import {
  DownstreamConnection,
  MCPProxy,
  type MCPProxyOverrides,
  type ProxyConfig,
  UpstreamServer,
} from "@qmilab/lodestar-guard-mcp"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-proxy-authority"
const ACTOR_ID = "agent:probe-proxy-authority"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "push"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`
const REQUIRED_TRUST = 0.7

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
  override async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.fakeCallTool(name, args)
  }
  override async stop(): Promise<void> {}
}

class NoOpUpstreamServer extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

const pushTool: MCPTool = {
  name: DOWNSTREAM_TOOL_NAME,
  description: "Push to a remote",
  inputSchema: { type: "object", properties: {}, required: [] },
}

/**
 * A declarative policy whose single `require_approval` rule matches the L4 push
 * tool and demands a trusted, project-scoped approver. Compiled (unsigned draft,
 * explicit dev opt-in) and injected as the proxy's gate.
 */
function authorityPolicy(): Policy {
  return {
    id: "probe-proxy-authority",
    version: "v1",
    rules: [
      {
        match: { tool: LODESTAR_TOOL_NAME },
        effect: "require_approval",
        approval: {
          required_authority: {
            min_trust_baseline: REQUIRED_TRUST,
            scope: { level: "project", identifier: PROJECT_ID },
          },
        },
        reason: "external push requires a trusted, project-scoped approver",
      },
    ],
  }
}

/**
 * Build a proxy whose single tool is L4 (always held). When `policy` is given,
 * the proxy's gate is that compiled policy; otherwise it falls back to the
 * default ceiling preset (the bare-gate contrast). `approval_timeout_ms: 0` so
 * the hold surfaces immediately as `approval_required` after the request emits.
 */
function makeProxy(logDir: string, sessionId: string, policy?: Policy) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const fakeCallTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    calls.push({ name, args })
    return { content: [{ type: "text", text: "pushed" }], isError: false }
  }
  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: ACTOR_ID,
    session_id: sessionId,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    approval_timeout_ms: 0,
    downstream_servers: [{ name: DOWNSTREAM_NAME, command: "not-spawned", args: [] }],
    tool_defaults: {
      [LODESTAR_TOOL_NAME]: {
        reversibility: "irreversible",
        permissions: [],
        sandbox: "controlled-shell",
        // L4: external/shared — the trust-ladder floor always holds it.
        required_trust_level: 4,
        blast_radius: "external",
      },
    },
  }
  const overrides: MCPProxyOverrides = {
    downstreamFactory: (cfg) =>
      cfg.downstream_servers.map(
        (entry) => new FakeDownstreamConnection(entry, [pushTool], fakeCallTool),
      ),
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  }
  if (policy !== undefined) {
    overrides.policyGate = compile(policy, { decider_id: "policy:probe", allow_unsigned: true })
  }
  const proxy = new MCPProxy(config, overrides)
  return { proxy, calls }
}

function resetState(): void {
  _resetToolsForTests()
  registry._resetForTests()
  _resetEventLogStateForTests()
}

async function requestFrom(
  logDir: string,
  sessionId: string,
): Promise<ApprovalRequest | undefined> {
  const events: EventEnvelope[] = await new EventLogReader(logDir).readSession(
    PROJECT_ID,
    sessionId,
  )
  const reqEvent = events.find((e) => e.type === "approval.requested")
  return reqEvent === undefined ? undefined : (reqEvent.payload as ApprovalRequest)
}

function approver(overrides: Partial<Actor>): Actor {
  return {
    id: "human:reviewer",
    kind: "human",
    display_name: "reviewer",
    authority_scope: [],
    trust_baseline: 0,
    sensitivity_clearance: "public",
    created_at: "2026-06-04T00:00:00.000Z",
    ...overrides,
  }
}

// ── Case 1: a require_approval rule's authority reaches the proxy hold ────────
async function caseRichAuthority(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-proxy-authority-rich-"))
  const sessionId = "probe-session-proxy-authority-rich"
  const { proxy, calls } = makeProxy(logDir, sessionId, authorityPolicy())
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    // The hold surfaces immediately (no wait), tool never runs.
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (result.isError !== true || kind !== "approval_required") {
      return `[rich] expected an 'approval_required' hold result; got isError=${String(result.isError)} kind='${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[rich] downstream tool ran ${calls.length}x; a held action must not execute.`
    }

    const request = await requestFrom(logDir, sessionId)
    if (request === undefined) return "[rich] approval.requested@1 never appeared in the log."
    const ra = request.required_authority

    // The matched rule's authority reached the request.
    if (ra.min_trust_baseline !== REQUIRED_TRUST) {
      return `[rich] required_authority.min_trust_baseline is ${String(ra.min_trust_baseline)}; expected ${REQUIRED_TRUST} (the rule's). This is the regression: the rule's authority did not reach the proxy hold.`
    }
    if (ra.scope?.level !== "project" || ra.scope?.identifier !== PROJECT_ID) {
      return `[rich] required_authority.scope is ${JSON.stringify(ra.scope)}; expected the rule's project scope.`
    }
    // openApprovalRequest also merges the action's mapped sensitivity (internal
    // → private → 'internal' via sensitivityForContract).
    if (ra.sensitivity_clearance !== "internal") {
      return `[rich] required_authority.sensitivity_clearance is '${String(ra.sensitivity_clearance)}'; expected 'internal' (the action's mapped sensitivity).`
    }

    // The authority has teeth. An under-authorised approver is refused…
    const weak = authorizeResolution(request, approver({ trust_baseline: 0.3 }), "granted")
    if (weak.authorized) {
      return "[rich] an approver below the min_trust_baseline was authorised; the authority has no teeth."
    }
    const noScope = authorizeResolution(
      request,
      approver({ trust_baseline: 0.9, sensitivity_clearance: "internal" }),
      "granted",
    )
    if (noScope.authorized) {
      return "[rich] an approver without the required scope was authorised; the scope constraint has no teeth."
    }
    // …and a fully-authorised approver clears every field.
    const ok = authorizeResolution(
      request,
      approver({
        trust_baseline: 0.9,
        sensitivity_clearance: "internal",
        authority_scope: [{ level: "project", identifier: PROJECT_ID }],
      }),
      "granted",
    )
    if (!ok.authorized) {
      return `[rich] an approver clearing trust+scope+clearance was refused: ${ok.authorized ? "" : ok.reason}`
    }

    await proxy.stop()
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 2: the bare ceiling preset carries only sensitivity_clearance ───────
async function caseBareContrast(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-proxy-authority-bare-"))
  const sessionId = "probe-session-proxy-authority-bare"
  const { proxy } = makeProxy(logDir, sessionId) // no policy → default ceiling preset
  try {
    await proxy.start()
    await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await requestFrom(logDir, sessionId)
    if (request === undefined) return "[bare] approval.requested@1 never appeared in the log."
    const ra = request.required_authority

    if (ra.sensitivity_clearance !== "internal") {
      return `[bare] required_authority.sensitivity_clearance is '${String(ra.sensitivity_clearance)}'; expected 'internal'.`
    }
    if (ra.min_trust_baseline !== undefined) {
      return `[bare] the floor-only hold carries a min_trust_baseline (${ra.min_trust_baseline}); expected none — there is no require_approval rule to source it.`
    }
    if (ra.scope !== undefined) {
      return `[bare] the floor-only hold carries a scope (${JSON.stringify(ra.scope)}); expected none.`
    }

    await proxy.stop()
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

async function run(): Promise<ProbeResult> {
  const richFail = await caseRichAuthority()
  if (richFail) return { passed: false, details: richFail }
  const bareFail = await caseBareContrast()
  if (bareFail) return { passed: false, details: bareFail }
  return {
    passed: true,
    details:
      "A proxy gated by a CompiledPolicy opened an approval.requested@1 carrying the matched require_approval rule's min_trust_baseline + scope (plus the action's mapped sensitivity_clearance), and that authority refused an under-authorised approver while clearing a trusted, project-scoped one. The same L4 tool under the default ceiling preset carried only sensitivity_clearance — no min_trust_baseline, no scope.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: proxy_hold_carries_rule_authority")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
