/**
 * @qmilab/lodestar-adapter-messaging — governed messaging egress tools for the
 * Lodestar Action Kernel. P2 slice 5 (ADR-0009).
 *
 * - `slack.post` (L4) — post text to an operator-pinned Slack channel; held until
 *   approved.
 * - `email.send` (L4) — send an email to operator-pinned recipients via an HTTP
 *   email API; held until approved.
 *
 * The canonical irreversible-external L4 action — the cleanest demonstration of
 * the Policy Kernel human-approval gate. Governance: operator destination pinning
 * (channel / recipient — the exfil guard), an operator-fixed endpoint + sender,
 * scoped credentials (resolver seam, redacted), bounded capture, no redirect
 * following. A TS-level governance boundary, not network containment.
 */
export {
  makeSlackPostTool,
  makeEmailSendTool,
  defineMessagingTools,
  registerMessagingTools,
  MessageSendOutputSchema,
  type MessageSendOutput,
  type SlackPostToolOptions,
  type EmailSendToolOptions,
  type EmailMessage,
  type MessagingToolsConfig,
} from "./tools.js"
export {
  type MessagingCredential,
  type SecretValue,
  type ResolvedHeader,
  type ResolvedCredential,
  resolveCredential,
  applyRedactions,
  redactionVariants,
} from "./credentials.js"
export {
  type ChannelPolicy,
  type RecipientPolicy,
  compileChannelPolicy,
  compileRecipientPolicy,
  assertAllowedChannel,
  assertAllowedRecipients,
  normalizeChannel,
} from "./destinations.js"
export {
  type SendResult,
  type PostJsonOptions,
  postJson,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "./transport.js"
