import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import type { MessagingCredential } from "./credentials.js"
import {
  type ChannelPolicy,
  type RecipientPolicy,
  assertAllowedChannel,
  assertAllowedRecipients,
  compileChannelPolicy,
  compileRecipientPolicy,
} from "./destinations.js"
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  type SendResult,
  postJson,
} from "./transport.js"

/**
 * Native messaging *egress* tools — `slack.post` and `email.send`. P2 slice 5
 * (ADR-0005 / ADR-0009).
 *
 * The canonical irreversible-external **L4 human-approval** action — the cleanest
 * demonstration of the Policy Kernel approval gate wired in slices 3a/3b/3c. Both
 * tools are egress; the contrast between them shows the governance model
 * generalises across destination *and* credential shapes:
 *
 *   - **`slack.post`** — destination is a CHANNEL (operator-pinned); identity is
 *     fixed by the bot token; payload is `{channel, text}`.
 *   - **`email.send`** — destination is RECIPIENT(s) (operator-pinned, exact
 *     address or whole domain); the `from` is operator-fixed (anti-spoofing); the
 *     payload is provider-shaped (default Resend-style, operator-overridable).
 *
 * The teeth (mirroring the earlier egress slices, ADR-0006/0007/0008):
 *
 *   - **L4 hold.** Every send is proposed at `blast_radius: external` and parks at
 *     `pending_approval` until a human approves — AND lights the
 *     `anomalous-tool-sequence` sentinel's read → egress → write exfil pattern.
 *   - **Destination pinning (the exfil guard).** A Slack channel / email recipient
 *     the operator did not pin fails the action. The agent cannot send to an
 *     arbitrary destination. (`destinations.ts`.)
 *   - **Operator-fixed endpoint + sender.** The agent never supplies the provider
 *     host (no agent-driven SSRF) nor the email `from` (no sender spoofing).
 *   - **Credential scoping.** The bot token / API key is operator-supplied
 *     (resolver seam), never in the agent's inputs, and redacted from captured
 *     output. (`credentials.ts`.)
 *   - **Bounded capture, no redirect.** A wall-clock timeout, a response-body byte
 *     cap, and a refusal to follow any redirect from the provider. (`transport.ts`.)
 */

// -----------------------------------------------------------------------------
// Output schema (one shape for both tools; registered under each key).
// -----------------------------------------------------------------------------

export const MessageSendOutputSchema = z
  .object({
    transport: z.enum(["slack", "email"]),
    destination: z
      .string()
      .describe("the channel (Slack) or recipient list (email) the message was sent to"),
    delivered: z
      .boolean()
      .describe("the provider accepted the message (HTTP 2xx and, for Slack, ok:true)"),
    provider_status: z.number().int().describe("provider HTTP status code"),
    message_id: z.string().nullable().describe("provider-assigned message id, if returned"),
    response_excerpt: z
      .string()
      .describe("bounded, redacted provider response body — UNTRUSTED confirmation content"),
    response_truncated: z.boolean().describe("true if the provider response exceeded the cap"),
    authenticated: z
      .boolean()
      .describe("whether an operator credential header was injected on the request"),
    summary: z.string(),
  })
  .describe("messaging tool output: the result of an egress send")

export type MessageSendOutput = z.infer<typeof MessageSendOutputSchema>

if (!registry.has("slack.post@1")) registry.register("slack.post@1", MessageSendOutputSchema)
if (!registry.has("email.send@1")) registry.register("email.send@1", MessageSendOutputSchema)

const JSON_CONTENT_TYPE = "application/json"

/** The egress effects every send declares. The `publication` effect is the
 * standing signal a host uses to mark the `ActionContract` `blast_radius:
 * external`, exactly as `git.push` / `nostr.publish` / `http.request` do. */
const SEND_EFFECTS: Effect[] = [
  { kind: "external_call", description: "send a message to an external provider" },
  { kind: "publication", description: "transmit message content to an external recipient" },
]

/** Best-effort JSON parse of a (redacted) provider response — never throws. */
function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toOutput(
  transport: "slack" | "email",
  destination: string,
  result: SendResult,
  delivered: boolean,
  messageId: string | null,
): MessageSendOutput {
  return {
    transport,
    destination,
    delivered,
    provider_status: result.status,
    message_id: messageId,
    response_excerpt: result.body,
    response_truncated: result.body_truncated,
    authenticated: result.authenticated,
    summary:
      `${transport}: ${delivered ? "delivered" : "NOT delivered"} to ${destination} ` +
      `(status ${result.status}${messageId ? `, id ${messageId}` : ""})` +
      `${result.body_truncated ? ", response truncated" : ""}`,
  }
}

/** Parse and validate the operator's provider endpoint at compile time. HTTPS
 * only unless `allowHttp` — no silent insecure default. */
function compileEndpoint(raw: string, allowHttp: boolean, tool: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${tool}: provider endpoint '${raw}' is not a valid absolute URL`)
  }
  const allowed = allowHttp ? ["https:", "http:"] : ["https:"]
  if (!allowed.includes(url.protocol)) {
    throw new Error(
      `${tool}: provider endpoint scheme '${url.protocol}' is not allowed (allowed: ${allowed.join(", ")})`,
    )
  }
  return url
}

// -----------------------------------------------------------------------------
// slack.post — egress, L4
// -----------------------------------------------------------------------------

const SlackPostInputSchema = z.object({
  channel: z.string().min(1).describe("target channel; MUST be operator-allowlisted"),
  text: z.string().min(1).describe("message text"),
})

export interface SlackPostToolOptions {
  /** Operator bot-token credential, e.g. { header: "Authorization", value: "Bearer xoxb-…" }. */
  credential: MessagingCredential
  /** Operator-pinned channels — the exfil guard. The agent may post only to these. */
  allowedChannels: string[]
  /** Slack Web API base. Default https://slack.com (operator-overridable for an
   * enterprise grid, a forward proxy, or testing). */
  apiBaseUrl?: string
  /** Allow a plain http:// endpoint. Default false (HTTPS only). */
  allowHttp?: boolean
  /** Response-body byte cap. Default 64 KiB. */
  maxBytes?: number
  /** Wall-clock timeout. Default 15s. */
  timeoutMs?: number
  /** Trust floor. Default L4 — egress, held until approved. */
  trust?: TrustLevel
}

export function makeSlackPostTool(
  opts: SlackPostToolOptions,
): Tool<z.infer<typeof SlackPostInputSchema>, MessageSendOutput> {
  const channelPolicy: ChannelPolicy = compileChannelPolicy(opts.allowedChannels)
  const endpoint = compileEndpoint(
    `${(opts.apiBaseUrl ?? "https://slack.com").replace(/\/+$/, "")}/api/chat.postMessage`,
    opts.allowHttp ?? false,
    "slack.post",
  )
  const credential = opts.credential
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: "slack.post",
    inputs: SlackPostInputSchema,
    output_schema_key: "slack.post@1",
    effects: SEND_EFFECTS,
    reversibility: "irreversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 4,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      const channel = assertAllowedChannel(inputs.channel, channelPolicy, "slack.post")
      const result = await postJson({
        url: endpoint,
        body: JSON.stringify({ channel, text: inputs.text }),
        credential,
        extraHeaders: [{ name: "Content-Type", value: JSON_CONTENT_TYPE }],
        timeoutMs,
        maxBytes,
        tool: "slack.post",
      })
      // Slack signals logical failure with HTTP 200 + { ok: false, error }, so a
      // 2xx alone is NOT delivery — require a confirmed `ok: true`. An unparseable
      // body (non-JSON, or truncated at the cap) cannot confirm delivery, so it is
      // a FAILURE, not a silent success: a send tool must never report an
      // unconfirmed send as delivered.
      const parsed = parseJsonSafe(result.body)
      const delivered = result.ok && parsed?.ok === true
      if (!delivered) {
        const slackError = typeof parsed?.error === "string" ? `, error '${parsed.error}'` : ""
        throw new Error(`slack.post: delivery failed (status ${result.status}${slackError})`)
      }
      const ts = typeof parsed?.ts === "string" ? parsed.ts : null
      return toOutput("slack", channel, result, delivered, ts)
    },
  }
}

// -----------------------------------------------------------------------------
// email.send — egress, L4
// -----------------------------------------------------------------------------

const EmailSendInputSchema = z.object({
  to: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("recipient(s); each MUST be operator-allowlisted (address or domain)"),
  subject: z.string().describe("email subject"),
  body: z.string().describe("plain-text email body"),
  html: z.string().optional().describe("optional HTML body"),
})

/** The normalized message handed to a payload builder. */
export interface EmailMessage {
  from: string
  to: string[]
  subject: string
  text: string
  html?: string
}

/** Default provider payload: a Resend/Postmark-compatible JSON shape. An operator
 * on a provider with a different schema passes their own `buildPayload`. */
function defaultEmailPayload(msg: EmailMessage): unknown {
  return {
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    ...(msg.html !== undefined ? { html: msg.html } : {}),
  }
}

export interface EmailSendToolOptions {
  /** Operator API-key credential, e.g. { header: "Authorization", value: "Bearer re_…" }. */
  credential: MessagingCredential
  /** The HTTP email-API endpoint (operator-supplied; e.g. https://api.resend.com/emails).
   * No default — no silent default for where mail goes. */
  endpoint: string
  /** Operator-fixed sender. The agent cannot choose the From (anti-spoofing). */
  from: string
  /** Operator-pinned recipients — exact addresses and/or whole domains. The exfil guard. */
  allowedRecipients: string[]
  /** Build the provider payload from the message. Default: Resend-style JSON. */
  buildPayload?: (msg: EmailMessage) => unknown
  /** Allow a plain http:// endpoint. Default false (HTTPS only). */
  allowHttp?: boolean
  /** Response-body byte cap. Default 64 KiB. */
  maxBytes?: number
  /** Wall-clock timeout. Default 15s. */
  timeoutMs?: number
  /** Trust floor. Default L4 — egress, held until approved. */
  trust?: TrustLevel
}

export function makeEmailSendTool(
  opts: EmailSendToolOptions,
): Tool<z.infer<typeof EmailSendInputSchema>, MessageSendOutput> {
  const recipientPolicy: RecipientPolicy = compileRecipientPolicy(opts.allowedRecipients)
  const endpoint = compileEndpoint(opts.endpoint, opts.allowHttp ?? false, "email.send")
  const credential = opts.credential
  const from = opts.from
  const buildPayload = opts.buildPayload ?? defaultEmailPayload
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: "email.send",
    inputs: EmailSendInputSchema,
    output_schema_key: "email.send@1",
    effects: SEND_EFFECTS,
    reversibility: "irreversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 4,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      const requested = Array.isArray(inputs.to) ? inputs.to : [inputs.to]
      const recipients = assertAllowedRecipients(requested, recipientPolicy, "email.send")
      const msg: EmailMessage = {
        from,
        to: recipients,
        subject: inputs.subject,
        text: inputs.body,
        ...(inputs.html !== undefined ? { html: inputs.html } : {}),
      }
      const result = await postJson({
        url: endpoint,
        body: JSON.stringify(buildPayload(msg)),
        credential,
        extraHeaders: [{ name: "Content-Type", value: JSON_CONTENT_TYPE }],
        timeoutMs,
        maxBytes,
        tool: "email.send",
      })
      // Email APIs deliver on a 2xx; a non-2xx means the send did not happen.
      if (!result.ok) {
        throw new Error(`email.send: delivery failed (status ${result.status})`)
      }
      const parsed = parseJsonSafe(result.body)
      const messageId = typeof parsed?.id === "string" ? parsed.id : null
      return toOutput("email", recipients.join(", "), result, true, messageId)
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors defineHttpTools / defineNostrTools)
// -----------------------------------------------------------------------------

export interface MessagingToolsConfig {
  /** Enable slack.post (L4 egress). Requires pinned channels. */
  slack?: Omit<SlackPostToolOptions, "timeoutMs">
  /** Enable email.send (L4 egress). Requires pinned recipients. */
  email?: Omit<EmailSendToolOptions, "timeoutMs">
  /** Wall-clock timeout shared by both tools. Default 15s. */
  timeoutMs?: number
}

/** Build the configured subset of messaging tools. */
export function defineMessagingTools(config: MessagingToolsConfig): Tool[] {
  const tools: Tool[] = []
  if (config.slack) {
    tools.push(makeSlackPostTool({ ...config.slack, timeoutMs: config.timeoutMs }) as Tool)
  }
  if (config.email) {
    tools.push(makeEmailSendTool({ ...config.email, timeoutMs: config.timeoutMs }) as Tool)
  }
  return tools
}

/** Build and register the configured subset of messaging tools. Returns them. */
export function registerMessagingTools(config: MessagingToolsConfig): Tool[] {
  const tools = defineMessagingTools(config)
  for (const tool of tools) registerTool(tool)
  return tools
}
