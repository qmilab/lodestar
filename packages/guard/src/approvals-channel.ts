import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"
import { SignatureSchema, TimestampSchema } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * The approval *side-channel* — the seam a separate-process resolver (the
 * `lodestar approve` CLI) uses to resolve a held action without ever writing the
 * event log itself.
 *
 * ## Why this lives in `@qmilab/lodestar-guard`
 *
 * The `.approvals/` side-channel is the cross-process transport for a *signed*
 * approval resolution (ADR-0010 / ADR-0015), paired with the Ed25519
 * sign/verify primitives that already live in `@qmilab/lodestar-policy-kernel`
 * (re-exported here as `signApprovalResolution` / `verifyApprovalSignature`).
 * Two governance hosts now consume that one format: the MCP proxy
 * (`@qmilab/lodestar-guard-mcp`) and the runtime-adapter gate
 * (`@qmilab/lodestar-runtime-core`, ADR-0024). A security-critical signed-format
 * reader must have exactly one implementation — duplicating it across consumers
 * is precisely the drift that creates a forgery hole — so it lives in the shared
 * governance meta-package alongside the primitives it transports.
 * `@qmilab/lodestar-guard-mcp` re-exports these names unchanged for source
 * compatibility.
 *
 * ## Why a side-channel rather than a direct event-log write
 *
 * A host parks a held L4 action at `pending_approval` and polls for an
 * out-of-band resolution. The obvious design — have the resolver append
 * `approval.granted@1` straight to the NDJSON log — is unsafe across processes:
 * `EventLogWriter` keeps its `seq` / `logical_clock` counters in *process-local*
 * module state, so a second OS process hydrates its own counters from disk and
 * then collides with the host's own post-resolution appends (duplicate /
 * non-monotonic `seq`, breaking the reader's ordering invariant — and the
 * `event_log_single_writer` probe that pins it).
 *
 * So the resolver instead drops a small JSON file here, keyed by `request_id`,
 * and the host — which *is* the sole writer of its session's log — reads it,
 * emits the canonical `approval.granted@1` / `approval.denied@1` into its own
 * log, and consumes the file. The event-log writer is untouched; the
 * single-writer invariant holds verbatim; no file-lock dependency or
 * orphan-lockfile failure mode is introduced.
 *
 * In-process resolution (a second `EventLogWriter` in the host's own process,
 * which shares the single-writer mutex and counters) stays a valid path — a
 * waiter still accepts an `approval.granted@1` it finds in the log. The
 * side-channel is specifically the *separate-process* path.
 *
 * ## Layout
 *
 * `<log_root>/.approvals/<project_id>/<request_id>.json`. The `.approvals`
 * directory is deliberately a *sibling* of the per-project event-log dirs
 * (`<log_root>/<project_id>/`), never nested under one, so `EventLogReader`
 * (which only ever reads `<log_root>/<project_id>/*.ndjson`) cannot see it. The
 * leading dot keeps it out of the way of any project literally named
 * `approvals`.
 */

/**
 * One resolution written by the resolver and consumed by the host. `at` is the
 * approver's *decision* time (not when the host noticed the file): the host
 * gates acceptance on `at` ≤ the request's deadline, so a file written after the
 * deadline is a timeout, exactly as a late `approval.granted@1` would be. `reason`
 * is omitted entirely when unset (never serialised as `undefined`) so the
 * canonical-hash discipline the `approval.*` event payloads hold carries through
 * to the event the host emits from this file.
 */
export const ApprovalResolutionSchema = z
  .object({
    request_id: z.string().min(1),
    action_id: z.string().min(1).describe("the parked action, at phase pending_approval"),
    kind: z.enum(["granted", "denied"]).describe("the verdict; expired is never written here"),
    approver_id: z.string().min(1).describe("actor_id of the resolver"),
    reason: z.string().min(1).optional().describe("approver's note; omitted entirely when unset"),
    at: TimestampSchema.describe("approver's decision time; the host gates this ≤ the deadline"),
    signature: SignatureSchema.optional().describe(
      "Ed25519 signature over the canonical resolution; the host verifies it against the pinned approver keys before promoting. Omitted only on the explicit allow_unsigned path.",
    ),
  })
  .strict()
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>

/** The per-project side-channel directory: `<log_root>/.approvals/<project_id>`. */
export function approvalsChannelDir(logRoot: string, projectId: string): string {
  return join(logRoot, ".approvals", projectId)
}

/** The resolution file path for one request. */
export function approvalResolutionPath(
  logRoot: string,
  projectId: string,
  requestId: string,
): string {
  return join(approvalsChannelDir(logRoot, projectId), `${requestId}.json`)
}

/**
 * Write a resolution to the side-channel, atomically.
 *
 * The host reads `<request_id>.json` concurrently; a half-written file would
 * either fail to parse (tolerated — `readApprovalResolution` returns undefined)
 * or, worse, parse partially. We avoid the question entirely: write to a unique
 * temp file in the same directory, then `rename` it into place. `rename` within
 * a directory is atomic on POSIX, so the host only ever observes the file
 * absent or fully present.
 *
 * Returns the final path. Validates `resolution` first; a malformed resolution
 * throws rather than landing a file the host would skip.
 */
export async function writeApprovalResolution(
  logRoot: string,
  projectId: string,
  resolution: ApprovalResolution,
): Promise<string> {
  const validated = ApprovalResolutionSchema.parse(resolution)
  const dir = approvalsChannelDir(logRoot, projectId)
  await mkdir(dir, { recursive: true })
  const finalPath = join(dir, `${validated.request_id}.json`)
  const tmpPath = join(dir, `.${validated.request_id}.${randomUUID()}.tmp`)
  // `JSON.stringify` drops undefined keys, matching the schema's "omit when
  // unset" discipline — the on-disk shape is exactly what the host re-parses.
  await writeFile(tmpPath, `${JSON.stringify(validated)}\n`, "utf8")
  try {
    await rename(tmpPath, finalPath)
  } catch (err) {
    // Best-effort cleanup of the temp file so a failed rename (e.g. a
    // cross-device move on an exotic setup) doesn't leak it.
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
  return finalPath
}

/**
 * Read and validate the resolution for one request, if present.
 *
 * Tolerant by construction — this runs on the host's hot poll loop:
 *   - file absent (the common case, every poll before the approver acts) → undefined;
 *   - torn / not-yet-renamed / invalid JSON → undefined (keep polling);
 *   - present but fails the schema → undefined (never trust a malformed file).
 * The atomic-rename write path means a present-but-torn file should not occur,
 * but the JSON-parse and schema guards make the reader robust regardless.
 */
export async function readApprovalResolution(
  logRoot: string,
  projectId: string,
  requestId: string,
): Promise<ApprovalResolution | undefined> {
  let raw: string
  try {
    raw = await readFile(approvalResolutionPath(logRoot, projectId, requestId), "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = ApprovalResolutionSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * Best-effort removal of a consumed resolution file. The host calls this after
 * promoting the resolution to a canonical `approval.granted@1` / `approval.denied@1`
 * event — the log event is the durable record; the side-channel file is spent
 * transport. Swallows all errors: the file may already be gone, the directory
 * read-only, etc., and none of that should disturb the resolved action.
 */
export async function deleteApprovalResolution(
  logRoot: string,
  projectId: string,
  requestId: string,
): Promise<void> {
  await rm(approvalResolutionPath(logRoot, projectId, requestId), { force: true }).catch(() => {})
}

/**
 * Build the kernel-bound {@link ApprovalOutcome} a side-channel resolution
 * carries. Bound to the request's `action_id` / `request_id` so
 * `ActionKernel.resolve()` refuses to apply it to any other parked action — the
 * same binding `authorizeResolution()` produces for an in-process resolver.
 */
export function resolutionToOutcome(resolution: ApprovalResolution): ApprovalOutcome {
  return {
    kind: resolution.kind,
    action_id: resolution.action_id,
    request_id: resolution.request_id,
    approver_id: resolution.approver_id,
    reason: resolution.reason,
    at: resolution.at,
  }
}
