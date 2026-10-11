import {
  type ActionRepresentation,
  ActionSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type EventEnvelope,
  actionRepresentationHash,
  canonicalActionRepresentation,
  canonicalHashHex,
} from "@qmilab/lodestar-core"

/**
 * What an approver is shown for a pending approval — the read-side half of
 * ADR-0042 (Loopjacking's *representation mismatch*).
 *
 * Pure projection over `EventEnvelope[]`, in the same family as
 * `pendingApprovals`: no I/O, no writes, no keys. It finds the log records of the
 * held action (`action.proposed` / `action.pending_approval`), reduces them to the
 * canonical `ActionRepresentation` — `{ action_id, tool, inputs, contract,
 * proposed_by }` — and checks that against the request's `action_type` /
 * `inputs_hash`. `lodestar approve list` prints the result verbatim, so a viewer
 * or a third-party approval UI built on this renders the identical thing.
 *
 * **Advisory, not a boundary.** The log is not authenticated per event, so a
 * local writer can plant records. What this projection can do is make a planted
 * record *visible*: an appending writer cannot remove the genuine record, so a
 * shadow always shows up as a second, disagreeing record, which is reported as a
 * `mismatch` rather than resolved by picking one. The boundary is the host, which
 * recomputes the hash from the action it is about to run before promoting any
 * resolution.
 */

/**
 * - `verified` — the request is bound (`inputs_hash` present), exactly one
 *   representation of the action is in the log, and it hashes to the request's
 *   `inputs_hash` with a matching tool. Safe to sign.
 * - `unbound` — a request written before ADR-0042 (no `inputs_hash`): rendered
 *   when a single record exists, but not verifiable. The legacy shape.
 * - `mismatch` — anything that means the approver cannot know which operation
 *   they would authorize: see `problems`. Never signed by `lodestar approve grant`.
 */
export type ApprovalBindingStatus = "verified" | "unbound" | "mismatch"

export interface ApprovalRepresentation {
  request_id: string
  action_id: string
  status: ApprovalBindingStatus
  /** Why the binding is not `verified`, one human-readable line each. Empty when verified. */
  problems: string[]
  /** The request's own `action_type`, verbatim, when present. */
  action_type?: string
  /** The request's own `inputs_hash`, verbatim, when present. */
  inputs_hash?: string
  /**
   * The canonical representation the approver is shown — present only when the
   * log holds exactly one representation of the action. Its `inputs` and
   * `contract` are canonical JSON (sorted keys), the exact value the hash covers.
   */
  representation?: ActionRepresentation
  /** `actionRepresentationHash` of {@link representation} — what an approver binds. */
  representation_hash?: string
}

/**
 * Resolve what `request` asks an approver to authorize, from the events in the
 * log. `events` may span sessions (a project-wide read); records are matched by
 * `action_id` and `request_id`, which are host-generated and unique.
 */
export function approvalRepresentation(
  events: EventEnvelope[],
  request: ApprovalRequest,
): ApprovalRepresentation {
  const result: ApprovalRepresentation = {
    request_id: request.request_id,
    action_id: request.action_id,
    status: "verified",
    problems: [],
  }
  if (request.action_type !== undefined) result.action_type = request.action_type
  if (request.inputs_hash !== undefined) result.inputs_hash = request.inputs_hash

  // Every approval request in the log for this request id OR this action. A host
  // writes exactly one per held action, so a second, different one is a planted
  // shadow — for example one that strips the quorum or the binding.
  const requestContents = new Set<string>()
  for (const event of events) {
    if (event.type !== "approval.requested") continue
    const parsed = ApprovalRequestSchema.safeParse(event.payload)
    if (!parsed.success) continue
    const r = parsed.data
    if (r.request_id !== request.request_id && r.action_id !== request.action_id) continue
    requestContents.add(canonicalHashHex(r))
  }
  if (requestContents.size > 1) {
    result.problems.push(
      `the log holds ${requestContents.size} different approval requests for this request or action — a planted record; the terms you would approve under are ambiguous`,
    )
  }

  // Every record of the held action, reduced to its representation.
  const representations = new Map<string, ActionRepresentation>()
  for (const event of events) {
    if (event.type !== "action.proposed" && event.type !== "action.pending_approval") continue
    const parsed = ActionSchema.safeParse(event.payload)
    if (!parsed.success || parsed.data.id !== request.action_id) continue
    representations.set(
      actionRepresentationHash(parsed.data),
      canonicalActionRepresentation(parsed.data),
    )
  }
  if (representations.size === 1) {
    const [[hash, representation]] = [...representations.entries()] as [
      [string, ActionRepresentation],
    ]
    result.representation = representation
    result.representation_hash = hash
  } else if (representations.size > 1) {
    result.problems.push(
      `the log holds ${representations.size} different records of action '${request.action_id}' — a planted record; the operation you would approve is ambiguous`,
    )
  }

  if (request.inputs_hash === undefined) {
    // Legacy request: render what can be rendered, but nothing binds it.
    if (representations.size === 0) {
      result.problems.push(
        `no record of action '${request.action_id}' in the log — the operation cannot be shown`,
      )
    }
    result.status = requestContents.size > 1 || representations.size > 1 ? "mismatch" : "unbound"
    return result
  }

  if (representations.size === 0) {
    result.problems.push(
      `no record of action '${request.action_id}' in the log — the operation the request is bound to cannot be shown`,
    )
  }
  if (result.representation !== undefined) {
    if (request.action_type !== undefined && request.action_type !== result.representation.tool) {
      result.problems.push(
        `the request names tool '${request.action_type}', but the action record runs '${result.representation.tool}'`,
      )
    }
    if (result.representation_hash !== request.inputs_hash) {
      result.problems.push(
        `the request is bound to ${request.inputs_hash}, but the action record hashes to ${result.representation_hash}`,
      )
    }
  }
  result.status = result.problems.length === 0 ? "verified" : "mismatch"
  return result
}

/**
 * Code points that can make a terminal display something other than the text,
 * as inclusive ranges: C0 / DEL / C1 controls (ANSI escapes start with ESC), soft
 * hyphen and other invisible formatting, bidi marks / embeddings / overrides /
 * isolates, zero-width characters, line and paragraph separators, Hangul fillers,
 * variation selectors, the BOM, interlinear annotation, and the tag block.
 * Numeric on purpose: the source stays ASCII, so no tool or editor can turn an
 * escape into the very character it names.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
]

function isUnsafeCodePoint(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

/**
 * Escape every unsafe code point as `\uXXXX` per UTF-16 unit — valid inside a
 * JSON string, unambiguous outside one. `keepC0` leaves C0 controls alone, for
 * pretty-printed JSON: `JSON.stringify` already escapes C0 inside strings, and the
 * only raw C0 left is the formatting's own newlines, which must survive.
 */
function escapeUnsafe(text: string, keepC0: boolean): string {
  let out = ""
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (!isUnsafeCodePoint(codePoint) || (keepC0 && codePoint <= 0x1f)) {
      out += ch
      continue
    }
    for (let i = 0; i < ch.length; i++) {
      out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`
    }
  }
  return out
}

function hasUnsafe(text: string): boolean {
  for (const ch of text) {
    if (isUnsafeCodePoint(ch.codePointAt(0) ?? 0)) return true
  }
  return false
}

/**
 * Render an untrusted, log-sourced string for a terminal.
 *
 * A plain string — no unsafe code point, no `"` and no `\` — is returned
 * unchanged, so ordinary ids and reasons read as before. Anything else is
 * rendered as a JSON string literal with every unsafe code point escaped as
 * `\uXXXX`. The quotes mark it as escaped, and because a plain rendering can never
 * contain a quote or a backslash, the two forms cannot be confused: a planted
 * value cannot pass itself off as an escape, or an escape as a plain value.
 */
export function escapeUntrustedText(text: string): string {
  if (!hasUnsafe(text) && !text.includes('"') && !text.includes("\\")) return text
  return escapeUnsafe(JSON.stringify(text), false)
}

/**
 * Render a value as canonical, pretty-printed JSON for an approver: keys sorted
 * at every depth, **never truncated** (a cut is itself a representation gap — the
 * payload can hide after it), and every code point that could deceive a terminal
 * escaped as `\uXXXX`. `JSON.parse` of the output is the canonical value, so the
 * rendering is a complete, faithful encoding of what the representation hash
 * covers.
 */
export function renderCanonicalJson(value: unknown): string {
  const text = JSON.stringify(sortKeysDeep(value), null, 2) ?? "undefined"
  return escapeUnsafe(text, true)
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
