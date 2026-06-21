import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type Actor,
  ApprovalDeniedPayloadSchema,
  ApprovalExpiredPayloadSchema,
  ApprovalGrantedPayloadSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type EventEnvelope,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
  type ResourceScope,
  ResourceScopeSchema,
  type Sensitivity,
  SensitivitySchema,
} from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"
import {
  authorizeResolution,
  generateApproverKeyPair,
  signApprovalResolution,
} from "@qmilab/lodestar-guard"
import {
  type ApprovalResolution,
  readApprovalResolution,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"

/** Env var holding the approver's PKCS#8 PEM private key (off argv; never logged). */
const APPROVER_KEY_ENV = "LODESTAR_APPROVER_KEY"

/**
 * `lodestar approve` — the reference approval resolver.
 *
 * The minimal, local, open-core writer that keeps the solo workflow ungated: a
 * single developer can author a policy, hit a held L4 over `lodestar guard
 * mcp-proxy`, and resolve it from their own terminal — no account, no team UI.
 *
 *   lodestar approve list  --project <id> [--log-root <path>]
 *   lodestar approve grant <request-id> --approver <id> [auth flags] [--reason <text>] --project <id> [--log-root <path>]
 *   lodestar approve deny  <request-id> --approver <id> [auth flags] [--reason <text>] --project <id> [--log-root <path>]
 *
 * It runs as a *separate process* from the proxy, so it never writes the event
 * log directly (the writer's seq/logical_clock counters are process-local — a
 * second writer would collide). Instead it drops a resolution into the proxy's
 * side-channel (`<log_root>/.approvals/<project>/<request-id>.json`); the proxy,
 * the sole writer of its log, picks it up while polling, emits the canonical
 * `approval.granted@1` / `approval.denied@1`, and runs (or rejects) the held
 * action. See `@qmilab/lodestar-guard-mcp`'s `approvals-channel`.
 *
 * **Authorisation.** The resolver owns authorisation (design lock:
 * `policy-kernel.md` — the same contract the in-process `guard.wrap()` resolver
 * honours). Before writing anything, this CLI builds the approver's `Actor` from
 * `--approver` + the auth flags (`--clearance`, `--trust-baseline`, `--scope`,
 * repeatable) and runs `authorizeResolution` against the request's
 * `required_authority`: an approver who does not clear the required trust /
 * clearance / scope is **refused** (exit 4) and no resolution is written, so a
 * side-channel grant cannot unblock an action the policy held for a more
 * authorised approver. The approver's authority is *self-declared* — this is
 * honest-mistake protection at parity with the in-process path, not a
 * cryptographic boundary (a hard boundary needs signed actors / a trusted actor
 * registry, deliberately deferred). Auth flags default conservatively
 * (clearance `public`, trust `0`, no scope), so a request carrying a non-empty
 * `required_authority` makes you assert the authority you hold rather than
 * silently clearing it.
 *
 * `list` reads the log read-only to show what is waiting (including each
 * request's `required_authority`); it never writes.
 *
 * Exit codes:
 *   0  — success (resolution written, or list rendered)
 *   1  — runtime error (unreadable log, write failed)
 *   2  — usage error (bad/missing flags or subcommand)
 *   3  — the named request is not a pending approval in this log
 *   4  — the approver does not clear the request's required_authority
 */
export async function approveCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    writeUsage(sub === undefined ? process.stderr : process.stdout)
    return sub === undefined ? 2 : 0
  }
  if (sub !== "list" && sub !== "grant" && sub !== "deny" && sub !== "keygen") {
    process.stderr.write(`unknown subcommand: ${sub}\n`)
    writeUsage(process.stderr)
    return 2
  }

  // ── Flag parsing, shared across subcommands ────────────────────────────────
  let projectId: string | undefined
  let logRoot = ".lodestar/events"
  let approver: string | undefined
  let reason: string | undefined
  // Path to the approver's PKCS#8 PEM private key for signing the resolution
  // (grant/deny), or the output path prefix for `keygen`. The key material itself
  // is never an argv value — only a file path or the LODESTAR_APPROVER_KEY env.
  let keyPath: string | undefined
  let outPath: string | undefined
  // Approver authority — conservative defaults (no silent clearance). The
  // approver asserts what they hold; `authorizeResolution` checks it against the
  // request's `required_authority` before grant/deny is written.
  let clearance: Sensitivity = "public"
  let trustBaseline = 0
  const scopes: ResourceScope[] = []
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--project" || arg === "-p") projectId = rest[++i]
    else if (arg === "--log-root") logRoot = rest[++i] ?? logRoot
    else if (arg === "--approver" || arg === "-a") approver = rest[++i]
    else if (arg === "--reason" || arg === "-r") reason = rest[++i]
    else if (arg === "--key" || arg === "-k") keyPath = rest[++i]
    else if (arg === "--out" || arg === "-o") outPath = rest[++i]
    else if (arg === "--clearance") {
      const v = rest[++i]
      const parsed = SensitivitySchema.safeParse(v)
      if (!parsed.success) {
        process.stderr.write(
          `invalid --clearance '${v ?? ""}' (expected public|internal|confidential|secret)\n`,
        )
        return 2
      }
      clearance = parsed.data
    } else if (arg === "--trust-baseline") {
      const v = rest[++i]
      const n = Number(v)
      if (v === undefined || v === "" || Number.isNaN(n) || n < 0 || n > 1) {
        process.stderr.write(`invalid --trust-baseline '${v ?? ""}' (expected a number in [0,1])\n`)
        return 2
      }
      trustBaseline = n
    } else if (arg === "--scope") {
      const v = rest[++i]
      const scope = parseScope(v)
      if (scope === undefined) {
        process.stderr.write(
          `invalid --scope '${v ?? ""}' (expected '<level>:<identifier>' or 'global')\n`,
        )
        return 2
      }
      scopes.push(scope)
    } else if (arg === "--help" || arg === "-h") {
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

  // keygen mints an approver keypair; it needs neither a project nor a log.
  if (sub === "keygen") {
    return keygen({ approver, outPath })
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
    clearance,
    trustBaseline,
    scopes,
    keyPath,
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
  clearance: Sensitivity
  trustBaseline: number
  scopes: ResourceScope[]
  keyPath: string | undefined
}): Promise<number> {
  const {
    root,
    projectId,
    requestId,
    kind,
    approver,
    reason,
    clearance,
    trustBaseline,
    scopes,
    keyPath,
  } = input

  // Load the approver's signing key, if one is supplied. A signed resolution is
  // what the proxy verifies against its pinned approver keys; an unsigned one is
  // rejected unless the proxy runs `approvals.allow_unsigned`. The key material
  // is read from a file (`--key`) or the LODESTAR_APPROVER_KEY env — never argv.
  let privateKeyPem: string | undefined
  try {
    privateKeyPem = await loadApproverKey(keyPath)
  } catch (err) {
    process.stderr.write(`[approve] could not read the signing key: ${errMessage(err)}\n`)
    return 1
  }
  if (privateKeyPem === undefined) {
    process.stderr.write(
      `[approve] note: resolving WITHOUT a signature (no --key and no ${APPROVER_KEY_ENV}).\n          The proxy will reject this unless it runs approvals.allow_unsigned.\n          Run 'lodestar approve keygen --approver ${approver}' to mint a key.\n`,
    )
  }

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

  // Authorisation — the resolver's job (design lock: policy-kernel.md). Build the
  // approver's (self-asserted) Actor and match it against the request's
  // required_authority. A shortfall refuses BEFORE any side-channel write, so an
  // under-authorised approver cannot unblock an action the policy held for a
  // trusted / cleared / scoped approver. Parity with the in-process resolver
  // contract; not a cryptographic boundary (authority is self-declared).
  const at = new Date().toISOString()
  const approverActor: Actor = {
    id: approver,
    kind: "human",
    display_name: approver,
    authority_scope: scopes,
    trust_baseline: trustBaseline,
    sensitivity_clearance: clearance,
    created_at: at,
  }
  const auth = authorizeResolution(
    request,
    approverActor,
    kind,
    reason !== undefined && reason !== "" ? { reason, at } : { at },
  )
  if (!auth.authorized) {
    process.stderr.write(
      `[approve] refused: ${auth.reason}\n          this request requires: ${describeAuthority(request) ?? "(no specific authority)"}\n          re-run asserting the authority you hold, e.g. --clearance <level> --trust-baseline <0..1> --scope <level:id>.\n`,
    )
    return 4
  }

  const resolution: ApprovalResolution = {
    request_id: requestId,
    action_id: request.action_id,
    kind,
    approver_id: approver,
    at,
  }
  if (reason !== undefined && reason !== "") resolution.reason = reason

  // Sign over the canonical resolution document. The signature's signer_id is
  // bound to approver_id, so the proxy rejects a signature lifted onto a
  // different approver's resolution. A bad key (wrong type, malformed PEM)
  // surfaces here, before any file is written.
  if (privateKeyPem !== undefined) {
    try {
      resolution.signature = signApprovalResolution(resolution, privateKeyPem)
    } catch (err) {
      process.stderr.write(`[approve] could not sign the resolution: ${errMessage(err)}\n`)
      return 1
    }
  }

  let path: string
  try {
    path = await writeApprovalResolution(root, projectId, resolution)
  } catch (err) {
    process.stderr.write(`[approve] failed to write the resolution: ${errMessage(err)}\n`)
    return 1
  }

  process.stdout.write(
    `[approve] ${kind} request '${requestId}' (action '${request.action_id}') as '${approver}'${privateKeyPem !== undefined ? " (signed)" : " (UNSIGNED)"}.\n          Queued at ${path}\n          The proxy will pick it up on its next poll and emit the canonical approval.${kind === "granted" ? "granted" : "denied"}@1 event.\n`,
  )
  return 0
}

// ── keygen ───────────────────────────────────────────────────────────────────

/**
 * Mint an Ed25519 approver keypair. The private key signs resolutions; the
 * public key is what the operator pins in the proxy's `approvals.authorized_keys`.
 *
 * With `--out <prefix>`, writes `<prefix>.key` (private PKCS#8 PEM, mode 0600)
 * and `<prefix>.pub` (public SPKI PEM), and prints the ready-to-paste pin. Without
 * `--out`, prints both PEMs to stdout (the private key included — for piping into
 * a file / secret store yourself). `--approver <id>` labels the printed pin's
 * `actor_id`; it must match the `--approver` you later grant/deny as.
 */
async function keygen(input: {
  approver: string | undefined
  outPath: string | undefined
}): Promise<number> {
  const { approver, outPath } = input
  // Require --approver: the printed authorized_keys pin and the .pub file are
  // keyed by actor_id, and that id MUST equal the --approver you later grant/deny
  // as, or every signature is rejected as an unpinned signer. A placeholder pin
  // would be a silent footgun, so refuse rather than emit one.
  if (approver === undefined || approver === "") {
    process.stderr.write(
      "missing required --approver <id> for 'keygen'\n          (the actor_id the key signs as; it must match your later grant/deny --approver)\n",
    )
    return 2
  }
  const actorId = approver
  const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()

  const pin = JSON.stringify({ actor_id: actorId, public_key: publicKeyPem }, null, 2)

  if (outPath !== undefined) {
    const privPath = `${outPath}.key`
    const pubPath = `${outPath}.pub`
    // The private key must never touch disk with loose permissions. `mode` on
    // `writeFile` applies only when the file is CREATED, so writing straight to a
    // pre-existing `privPath` with broader bits would expose the secret until a
    // follow-up chmod. Instead write to a FRESH 0600 temp (mode applies on
    // creation) and atomically `rename` it into place — the destination inherits
    // the temp's inode + 0600. Same temp+rename discipline as the side-channel.
    const tmpPath = `${privPath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, privateKeyPem, { mode: 0o600 })
      await rename(tmpPath, privPath)
      await writeFile(pubPath, publicKeyPem)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      process.stderr.write(`[approve] keygen: could not write key files: ${errMessage(err)}\n`)
      return 1
    }
    process.stdout.write(
      `[approve] wrote approver keypair:\n  private (keep secret, mode 0600): ${privPath}\n  public  (pin in the proxy):        ${pubPath}\n\n` +
        `Sign with it:   lodestar approve grant <request-id> --approver ${actorId} --key ${privPath} --project <id>\n` +
        `Pin it in the proxy config under approvals.authorized_keys:\n${pin}\n`,
    )
    return 0
  }

  process.stdout.write(
    `# Ed25519 approver keypair. Keep the PRIVATE key secret (a secret store / a 0600 file).
# Sign with:  lodestar approve grant <request-id> --approver ${actorId} --key <private-key-file> --project <id>
#       or:  ${APPROVER_KEY_ENV}="$(cat <private-key-file>)" lodestar approve grant ...

# --- PRIVATE KEY (PKCS#8) ---
${privateKeyPem}
# --- PUBLIC KEY (SPKI) — pin this in the proxy config ---
${publicKeyPem}
# proxy config approvals.authorized_keys entry:
${pin}
`,
  )
  return 0
}

/**
 * Resolve the approver's PKCS#8 PEM private key, or `undefined` when none is
 * supplied (the unsigned path). A `--key <path>` is read from disk; otherwise the
 * `LODESTAR_APPROVER_KEY` env carries the PEM contents directly. The key material
 * is never an argv value — a path is fine, the secret itself is not.
 */
async function loadApproverKey(keyPath: string | undefined): Promise<string | undefined> {
  if (keyPath !== undefined && keyPath !== "") {
    return await readFile(keyPath, "utf8")
  }
  const fromEnv = process.env[APPROVER_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv
  return undefined
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

/**
 * The exclusions to apply for grant/deny events the proxy refused to promote
 * (`guard.approval.signature_rejected` — a forgery whose signature did not verify
 * against the pinned approver keys, planted in the log or side-channel). Such a
 * `approval.granted@1` / `approval.denied@1` is NOT a real resolution and must not
 * make the CLI report the request as already settled, or a legitimate operator
 * could never submit a real signed grant after a forgery (the request would look
 * resolved and the proxy would time out). Mirrors the trace `pendingApprovals`
 * projection exactly (the canonical read side):
 *   - a `source: "log"` rejection names the forged event via `rejected_event_id`,
 *     so we exclude *that specific event* and still honour a genuine grant the
 *     operator submits afterwards;
 *   - a `source: "side_channel"` rejection promotes no log event → excludes nothing;
 *   - a legacy rejection (pre-`source`) names no event → conservative per-request
 *     exclusion (the ungameable fallback; no regression on old logs).
 */
interface ApprovalRejectionIndex {
  rejectedEventIds: Set<string>
  conservativelyTaintedRequestIds: Set<string>
}

function rejectionIndex(events: EventEnvelope[]): ApprovalRejectionIndex {
  const rejectedEventIds = new Set<string>()
  const conservativelyTaintedRequestIds = new Set<string>()
  for (const e of events) {
    if (e.type !== GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE) continue
    const p = e.payload as
      | { request_id?: unknown; source?: unknown; rejected_event_id?: unknown }
      | undefined
    const rejectedId = p?.rejected_event_id
    if (typeof rejectedId === "string" && rejectedId.length > 0) {
      rejectedEventIds.add(rejectedId)
    } else if (p?.source === "side_channel") {
      // promotes no log event — nothing to exclude
    } else {
      const rid = p?.request_id
      if (typeof rid === "string" && rid.length > 0) conservativelyTaintedRequestIds.add(rid)
    }
  }
  return { rejectedEventIds, conservativelyTaintedRequestIds }
}

/** Whether a grant/deny event is a genuine resolution (not a rejected forgery). */
function isGenuineResolution(
  event: EventEnvelope,
  requestId: string,
  index: ApprovalRejectionIndex,
): boolean {
  return (
    !index.rejectedEventIds.has(event.id) && !index.conservativelyTaintedRequestIds.has(requestId)
  )
}

/**
 * request_ids that already carry a *genuine* terminal event. A grant/deny only
 * counts when the guard did not reject that specific event (a forgery it refused);
 * `approval.expired@1` is proxy-authored and always definitive (a timed-out hold
 * the agent re-proposes). A request that was forged-then-rejected but not yet
 * resolved stays actionable so an operator can still grant it.
 */
function collectResolvedRequestIds(events: EventEnvelope[]): Set<string> {
  const index = rejectionIndex(events)
  const out = new Set<string>()
  for (const e of events) {
    if (e.type === "approval.granted" || e.type === "approval.denied") {
      const p = (
        e.type === "approval.granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
      ).safeParse(e.payload)
      if (p.success && isGenuineResolution(e, p.data.request_id, index)) out.add(p.data.request_id)
    } else if (e.type === "approval.expired") {
      const p = ApprovalExpiredPayloadSchema.safeParse(e.payload)
      if (p.success) out.add(p.data.request_id)
    }
  }
  return out
}

/**
 * The existing log verdict for a request, if any — ignoring a grant/deny the
 * proxy signature-rejected (see {@link collectResolvedRequestIds}), so a forged
 * resolution does not block a real one. `approval.expired@1` is always honoured.
 */
function existingResolution(
  events: EventEnvelope[],
  requestId: string,
): { verdict: "granted" | "denied" | "expired"; approver?: string } | undefined {
  const index = rejectionIndex(events)
  for (const e of events) {
    if (e.type === "approval.granted" || e.type === "approval.denied") {
      const p = (
        e.type === "approval.granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
      ).safeParse(e.payload)
      if (
        p.success &&
        p.data.request_id === requestId &&
        isGenuineResolution(e, requestId, index)
      ) {
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

/**
 * Parse a `--scope` value into a `ResourceScope`. Accepts `global` (shorthand
 * for the global level, identifier `*`) or `<level>:<identifier>`. Returns
 * `undefined` on anything the `ResourceScope` schema rejects (unknown level,
 * empty identifier, missing colon).
 */
function parseScope(value: string | undefined): ResourceScope | undefined {
  if (value === undefined || value === "") return undefined
  if (value === "global") return { level: "global", identifier: "*" }
  const idx = value.indexOf(":")
  if (idx <= 0) return undefined
  const candidate = { level: value.slice(0, idx), identifier: value.slice(idx + 1) }
  const parsed = ResourceScopeSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    "usage: lodestar approve list   --project <id> [--log-root <path>]\n" +
      "       lodestar approve grant  <request-id> --approver <id> --key <path> [auth] [--reason <text>] --project <id> [--log-root <path>]\n" +
      "       lodestar approve deny   <request-id> --approver <id> --key <path> [auth] [--reason <text>] --project <id> [--log-root <path>]\n" +
      "       lodestar approve keygen --approver <id> [--out <prefix>]\n" +
      "\n" +
      "  Resolve an action a running `lodestar guard mcp-proxy` is holding for approval.\n" +
      "  --log-root defaults to .lodestar/events (match the proxy's config).\n" +
      "\n" +
      "  Signing (the cross-process forgery boundary):\n" +
      "    --key, -k <path>   the approver's Ed25519 PKCS#8 PEM private key; signs the\n" +
      "                       resolution. Or set LODESTAR_APPROVER_KEY to the PEM contents.\n" +
      "                       The proxy rejects an unsigned resolution unless it runs\n" +
      "                       approvals.allow_unsigned. Mint a key with 'approve keygen'.\n" +
      "\n" +
      "  Approver authority (asserted; checked against the request's required_authority):\n" +
      "    --clearance <public|internal|confidential|secret>   (default public)\n" +
      "    --trust-baseline <0..1>                             (default 0)\n" +
      "    --scope <level:identifier> | global   (repeatable;  default none)\n" +
      "  An approver who does not clear the request's required_authority is refused (exit 4);\n" +
      "  'lodestar approve list' prints each request's authority requirement.\n",
  )
}
