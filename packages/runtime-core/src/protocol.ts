import { z } from "zod"

/**
 * The runtime-adapter RPC protocol (ADR-0024 §6).
 *
 * A native runtime hook (the Python `lodestar-langgraph` package, or the in-TS
 * stand-in the `runtime-gate-enforces-two-phase` probe drives) and the TS
 * governance-gate sidecar speak newline-delimited JSON-RPC over a bidirectional
 * channel — zero new dependencies, the same framing MCP itself uses. The channel
 * is bidirectional because the remoted execute (§4) needs the gate to call
 * *back* into the hook to run the real tool body.
 *
 * Two id spaces, never conflated:
 *   - **request id** (`id` on hook→gate `register_tool` / `govern` / `resume`):
 *     assigned by the hook; the gate echoes it on the matching `*_result`.
 *   - **correlation id** (`id` on gate→hook `run_tool`): assigned by the gate;
 *     the hook echoes it on `tool_result` / `tool_error`.
 * Both are matched independent of arrival order — the channel is multiplexed by
 * id, with no positional assumption, so parallel in-flight calls are correlated
 * correctly (§6).
 *
 * Inbound messages (hook→gate) are validated through Zod here: the hook is
 * potentially untrusted. Outbound messages (gate→hook) are gate-authored, so
 * they are plain typed objects.
 */

// ── Inbound: hook → gate ─────────────────────────────────────────────────────

/** Untrusted document content the hook flags inside a tool result — the
 *  external-document evidence the auto-observation gate must not auto-promote. */
export const ToolResultDocumentSchema = z
  .object({
    text: z.string(),
    source: z.string().optional().describe("optional provenance hint, e.g. a file path or URL"),
  })
  .strict()
export type ToolResultDocument = z.infer<typeof ToolResultDocumentSchema>

/**
 * Register a governed tool with the gate. The hook declares only the *name*; the
 * action contract is the **operator's** (`RuntimeGateConfig.tool_defaults`, or
 * the conservative default), never the untrusted hook's — so a hook cannot widen
 * its own authority by claiming a low trust level. A call for a tool that was
 * never registered is denied (fail closed, §3).
 */
export const RegisterToolMessageSchema = z
  .object({
    type: z.literal("register_tool"),
    id: z.number().int(),
    name: z.string().min(1),
  })
  .strict()

/** Propose a tool call: the gate runs `propose → arbitrate` and either executes
 *  (remoting the body back to the hook) or holds at `pending_approval`. */
export const GovernMessageSchema = z
  .object({
    type: z.literal("govern"),
    id: z.number().int(),
    tool: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    /** Optional caller-supplied label echoed back for tracing; ignored by gating. */
    correlation_id: z.string().optional(),
  })
  .strict()

/** Re-present a held action (the LangGraph `Command(resume=…)` path). The gate
 *  reconstructs the parked action from the durable log + signed side-channel and
 *  applies the exactly-once execute rule (§4/§5). */
export const ResumeMessageSchema = z
  .object({
    type: z.literal("resume"),
    id: z.number().int(),
    action_id: z.string().min(1),
    request_id: z.string().min(1),
    /** When set, block-poll up to this many ms (bounded by the deadline) for a
     *  resolution before replying. Absent → a single check, then reply with the
     *  current state (`pending_approval` if still unresolved). */
    wait_ms: z.number().int().min(0).optional(),
  })
  .strict()

/** The hook's response to a `run_tool` callback: the real tool body ran. */
export const ToolResultMessageSchema = z
  .object({
    type: z.literal("tool_result"),
    id: z.number().int(),
    /** Structured tool output — recorded as `tool_result`-quality evidence. */
    output: z.unknown(),
    /** Any untrusted document content the tool surfaced — `external_document`. */
    documents: z.array(ToolResultDocumentSchema).default([]),
  })
  .strict()

/** The hook's response to a `run_tool` callback when the body threw. */
export const ToolErrorMessageSchema = z
  .object({
    type: z.literal("tool_error"),
    id: z.number().int(),
    message: z.string(),
  })
  .strict()

export const ShutdownMessageSchema = z.object({ type: z.literal("shutdown") }).strict()

export const InboundMessageSchema = z.discriminatedUnion("type", [
  RegisterToolMessageSchema,
  GovernMessageSchema,
  ResumeMessageSchema,
  ToolResultMessageSchema,
  ToolErrorMessageSchema,
  ShutdownMessageSchema,
])
export type InboundMessage = z.infer<typeof InboundMessageSchema>

// ── Outbound: gate → hook (gate-authored, plain typed) ───────────────────────

/** The gate is up and the engine is wired. */
export interface ReadyMessage {
  type: "ready"
  session_id: string
  project_id: string
  log_root: string
}

/** A tool's contract was compiled and registered; the resolved trust level is
 *  returned so the hook can surface it (it cannot change it). */
export interface RegisteredMessage {
  type: "registered"
  id: number
  name: string
  required_level: number
}

/** The terminal (or held) outcome of a `govern` / `resume`. `phase` mirrors the
 *  kernel's action phases plus the held wait state. */
export type GovernResultPhase = "completed" | "pending_approval" | "rejected" | "failed"

export interface GovernResultMessage {
  type: "govern_result"
  id: number
  phase: GovernResultPhase
  action_id: string
  /** Present when held (`pending_approval`): the approval request to resolve. */
  request_id?: string
  /** Present when held and a deadline is configured (ISO 8601). */
  deadline?: string
  /** Present when `completed`: the raw tool output the hook returned. */
  output?: unknown
  /** Present when `rejected` / `failed`: why. */
  reason?: string
  /** A short machine tag for the rejection class (`policy_denied`,
   *  `approval_denied`, `approval_timeout`, `unregistered_tool`,
   *  `precondition_failed`). */
  kind?: string
}

/** Ask the hook to run a real tool body (the re-entrant remoted execute, §4). */
export interface RunToolMessage {
  type: "run_tool"
  id: number
  tool: string
  args: Record<string, unknown>
  action_id: string
}

/** A protocol-level error not tied to a specific request (or with a known id). */
export interface ErrorMessage {
  type: "error"
  id?: number
  message: string
}

export type OutboundMessage =
  | ReadyMessage
  | RegisteredMessage
  | GovernResultMessage
  | RunToolMessage
  | ErrorMessage
