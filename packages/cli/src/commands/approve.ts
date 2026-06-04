import { resolve } from "node:path"
import {
  ApprovalDeniedPayloadSchema,
  ApprovalExpiredPayloadSchema,
  ApprovalGrantedPayloadSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type EventEnvelope,
} from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"
import {
  type ApprovalResolution,
  readApprovalResolution,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"

/**
 * `lodestar approve` — the reference approval resolver.
 *
 * The minimal, local, open-core writer that keeps the solo workflow ungated: a
 * single developer can author a policy, hit a held L4 over `lodestar guard
 * mcp-proxy`, and resolve it from their own terminal — no account, no team UI.
 *
 *   lodestar approve list  --project <id> [--log-root <path>]
 *   lodestar approve grant <request-id> --approver <id> [--reason <text>] --project <id> [--log-root <path>]
 *   lodestar approve deny  <request-id> --approver <id> [--reason <text>] --project <id> [--log-root <path>]
 *
 * It runs as a *separate process* from the proxy, so it never writes the event
 * log directly (the writer's seq/logical_clock counters are process-local — a
 * second writer would collide). Instead it drops a resolution into the proxy's
 * side-channel (`<log_root>/.approvals/<project>/<request-id>.json`); the proxy,
 * the sole writer of its log, picks it up while polling, emits the canonical
 * `approval.granted@1` / `approval.denied@1`, and runs (or rejects) the held
 * action. See `@qmilab/lodestar-guard-mcp`'s `approvals-channel`.
 *
 * `list` reads the log read-only to show what is waiting; it never writes.
 *
 * Exit codes:
 *   0  — success (resolution written, or list rendered)
 *   1  — runtime error (unreadable log, write failed)
 *   2  — usage error (bad/missing flags or subcommand)
 *   3  — the named request is not a pending approval in this log
 */
export async function approveCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    writeUsage(sub === undefined ? process.stderr : process.stdout)
    return sub === undefined ? 2 : 0
  }
  if (sub !== "list" && sub !== "grant" && sub !== "deny") {
    process.stderr.write(`unknown subcommand: ${sub}\n`)
    writeUsage(process.stderr)
    return 2
  }

  // ── Flag parsing, shared across subcommands ────────────────────────────────
  let projectId: string | undefined
  let logRoot = ".lodestar/events"
  let approver: string | undefined
  let reason: string | undefined
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--project" || arg === "-p") projectId = rest[++i]
    else if (arg === "--log-root") logRoot = rest[++i] ?? logRoot
    else if (arg === "--approver" || arg === "-a") approver = rest[++i]
    else if (arg === "--reason" || arg === "-r") reason = rest[++i]
    else if (arg === "--help" || arg === "-h") {
      writeUsage(process.stdout)
      return 0
    } else if (arg?.startsWith("-")) {
      process.stderr.write(`unknown flag: ${arg}\n`)
      writeUsage(process.stderr)
      return 2
    } else if (arg !== undefined) {
      positionals.push(arg)
    }
  }

  if (projectId === undefined || projectId === "") {
    process.stderr.write("missing required --project <id>\n")
    writeUsage(process.stderr)
    return 2
  }

  const root = resolve(process.cwd(), logRoot)

  if (sub === "list") {
    return listPending(root, projectId)
  }

  // grant | deny
  const requestId = positionals[0]
  if (requestId === undefined) {
    process.stderr.write(`missing <request-id> for '${sub}'\n`)
    writeUsage(process.stderr)
    return 2
  }
  if (approver === undefined || approver === "") {
    process.stderr.write(`missing required --approver <id> for '${sub}'\n`)
    writeUsage(process.stderr)
    return 2
  }
  return resolveRequest({
    root,
    projectId,
    requestId,
    kind: sub === "grant" ? "granted" : "denied",
    approver,
    reason,
  })
}

// ── list ─────────────────────────────────────────────────────────────────────

async function listPending(root: string, projectId: string): Promise<number> {
  let events: EventEnvelope[]
  try {
    events = await readLogTolerant(root, projectId)
  } catch (err) {
    process.stderr.write(`[approve] could not read the event log: ${errMessage(err)}\n`)
    return 1
  }

  const requests = collectRequests(events)
  const resolvedIds = collectResolvedRequestIds(events)

  const pending: ApprovalRequest[] = []
  for (const req of requests.values()) {
    if (resolvedIds.has(req.request_id)) continue
    // Also skip requests an approver has already resolved via the side-channel
    // but the proxy has not yet promoted to a log event (the file still exists).
    const queued = await readApprovalResolution(root, projectId, req.request_id)
    if (queued !== undefined) continue
    pending.push(req)
  }

  if (pending.length === 0) {
    process.stdout.write(`No pending approvals for project '${projectId}'.\n`)
    return 0
  }

  // Oldest first — the order an approver should work them.
  pending.sort((a, b) => a.requested_at.localeCompare(b.requested_at))
  process.stdout.write(
    `${pending.length} pending approval${pending.length === 1 ? "" : "s"} for project '${projectId}':\n\n`,
  )
  for (const req of pending) {
    process.stdout.write(`  request: ${req.request_id}\n`)
    process.stdout.write(`   action: ${req.action_id}\n`)
    process.stdout.write(`   reason: ${req.reason}\n`)
    process.stdout.write(`requested: ${req.requested_at}\n`)
    if (req.deadline !== undefined) {
      const overdue = Date.parse(req.deadline) < Date.now()
      process.stdout.write(
        ` deadline: ${req.deadline}${overdue ? "  (PASSED — proxy will time out)" : ""}\n`,
      )
    }
    const authority = describeAuthority(req)
    if (authority !== undefined) process.stdout.write(`authority: ${authority}\n`)
    process.stdout.write(
      `  resolve: lodestar approve grant ${req.request_id} --approver <id> --project ${projectId}\n\n`,
    )
  }
  return 0
}

// ── grant | deny ───────────────────────────────────────────────────────────

async function resolveRequest(input: {
  root: string
  projectId: string
  requestId: string
  kind: "granted" | "denied"
  approver: string
  reason: string | undefined
}): Promise<number> {
  const { root, projectId, requestId, kind, approver, reason } = input

  let events: EventEnvelope[]
  try {
    events = await readLogTolerant(root, projectId)
  } catch (err) {
    process.stderr.write(`[approve] could not read the event log: ${errMessage(err)}\n`)
    return 1
  }

  const request = collectRequests(events).get(requestId)
  if (request === undefined) {
    process.stderr.write(
      `[approve] no pending approval with request id '${requestId}' in project '${projectId}'.\n         Run 'lodestar approve list --project <id>' to see open requests.\n`,
    )
    return 3
  }

  // Already resolved in the log — the proxy (or an in-process resolver) settled
  // it. Report the existing verdict and exit cleanly; the desired end-state holds.
  const existing = existingResolution(events, requestId)
  if (existing !== undefined) {
    process.stdout.write(
      `[approve] request '${requestId}' is already ${existing.verdict}${existing.approver ? ` by '${existing.approver}'` : ""}. No change made.\n`,
    )
    return 0
  }

  // A resolution is already queued in the side-channel (the proxy has not yet
  // promoted it). Overwriting is a legitimate change-of-mind, but be explicit.
  const queued = await readApprovalResolution(root, projectId, requestId)
  if (queued !== undefined && queued.kind !== kind) {
    process.stdout.write(
      `[approve] a '${queued.kind}' resolution by '${queued.approver_id}' is already queued for '${requestId}'; overwriting with '${kind}'.\n`,
    )
  }

  if (request.deadline !== undefined && Date.parse(request.deadline) < Date.now()) {
    process.stderr.write(
      `[approve] warning: the hold deadline (${request.deadline}) has already passed; the proxy will treat this as a timeout, not a resolution.\n`,
    )
  }

  const resolution: ApprovalResolution = {
    request_id: requestId,
    action_id: request.action_id,
    kind,
    approver_id: approver,
    at: new Date().toISOString(),
  }
  if (reason !== undefined && reason !== "") resolution.reason = reason

  let path: string
  try {
    path = await writeApprovalResolution(root, projectId, resolution)
  } catch (err) {
    process.stderr.write(`[approve] failed to write the resolution: ${errMessage(err)}\n`)
    return 1
  }

  process.stdout.write(
    `[approve] ${kind} request '${requestId}' (action '${request.action_id}') as '${approver}'.\n          Queued at ${path}\n          The proxy will pick it up on its next poll and emit the canonical approval.${kind === "granted" ? "granted" : "denied"}@1 event.\n`,
  )
  return 0
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the whole project log, tolerating a torn trailing line from a concurrent
 * proxy append. `EventLogReader.readAll` is strict (it `parse`s every line), so a
 * half-written tail throws; we retry a few times with a short backoff before
 * giving up. The proxy serialises its own appends, so any torn state is
 * momentary.
 */
async function readLogTolerant(root: string, projectId: string): Promise<EventEnvelope[]> {
  const reader = new EventLogReader(root)
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await reader.readAll(projectId)
    } catch (err) {
      lastErr = err
      await delay(20)
    }
  }
  throw lastErr
}

/** request_id → the latest `approval.requested@1` request payload in the log. */
function collectRequests(events: EventEnvelope[]): Map<string, ApprovalRequest> {
  const out = new Map<string, ApprovalRequest>()
  for (const e of events) {
    if (e.type !== "approval.requested") continue
    const parsed = ApprovalRequestSchema.safeParse(e.payload)
    if (parsed.success) out.set(parsed.data.request_id, parsed.data)
  }
  return out
}

/** request_ids that already carry a granted / denied / expired event. */
function collectResolvedRequestIds(events: EventEnvelope[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) {
    if (e.type === "approval.granted" || e.type === "approval.denied") {
      const p = (
        e.type === "approval.granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
      ).safeParse(e.payload)
      if (p.success) out.add(p.data.request_id)
    } else if (e.type === "approval.expired") {
      const p = ApprovalExpiredPayloadSchema.safeParse(e.payload)
      if (p.success) out.add(p.data.request_id)
    }
  }
  return out
}

/** The existing log verdict for a request, if any. */
function existingResolution(
  events: EventEnvelope[],
  requestId: string,
): { verdict: "granted" | "denied" | "expired"; approver?: string } | undefined {
  for (const e of events) {
    if (e.type === "approval.granted" || e.type === "approval.denied") {
      const p = (
        e.type === "approval.granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
      ).safeParse(e.payload)
      if (p.success && p.data.request_id === requestId) {
        return {
          verdict: e.type === "approval.granted" ? "granted" : "denied",
          approver: p.data.approver_id,
        }
      }
    } else if (e.type === "approval.expired") {
      const p = ApprovalExpiredPayloadSchema.safeParse(e.payload)
      if (p.success && p.data.request_id === requestId) return { verdict: "expired" }
    }
  }
  return undefined
}

/** Human-readable summary of what an approver must clear, if anything. */
function describeAuthority(req: ApprovalRequest): string | undefined {
  const parts: string[] = []
  const ra = req.required_authority
  if (ra.min_trust_baseline !== undefined) parts.push(`trust ≥ ${ra.min_trust_baseline}`)
  if (ra.sensitivity_clearance !== undefined) parts.push(`clearance ≥ ${ra.sensitivity_clearance}`)
  if (ra.scope !== undefined) parts.push(`scope ${ra.scope.level}:${ra.scope.identifier}`)
  return parts.length > 0 ? parts.join(", ") : undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    "usage: lodestar approve list  --project <id> [--log-root <path>]\n" +
      "       lodestar approve grant <request-id> --approver <id> [--reason <text>] --project <id> [--log-root <path>]\n" +
      "       lodestar approve deny  <request-id> --approver <id> [--reason <text>] --project <id> [--log-root <path>]\n" +
      "\n" +
      "  Resolve an action a running `lodestar guard mcp-proxy` is holding for approval.\n" +
      "  --log-root defaults to .lodestar/events (match the proxy's config).\n",
  )
}
