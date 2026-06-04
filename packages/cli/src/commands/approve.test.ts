import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequiredAuthority } from "@qmilab/lodestar-core"
import {
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import { readApprovalResolution } from "@qmilab/lodestar-guard-mcp"
import { approveCommand } from "./approve.js"

/**
 * The CLI-side half of the side-channel resolver's authorisation contract
 * (Policy Kernel slice 3c). The proxy promotes whatever resolution it finds —
 * it is deliberately not a trust boundary — so the *resolver* owns authorisation
 * (design lock: policy-kernel.md). `lodestar approve` builds the approver's
 * Actor from its flags and runs `authorizeResolution` against the request's
 * `required_authority` BEFORE writing anything: an under-authorised approver is
 * refused (exit 4) and no side-channel file is written, so a grant cannot
 * unblock an action the policy held for a trusted / cleared / scoped approver.
 */

const PROJECT = "cli-approve-test-project"
const SESSION = "cli-approve-test-session"

async function seedRequest(
  logRoot: string,
  requiredAuthority: RequiredAuthority,
): Promise<{ requestId: string; actionId: string }> {
  const requestId = randomUUID()
  const actionId = randomUUID()
  const payload = {
    request_id: requestId,
    action_id: actionId,
    reason: "L4 (external/shared) always requires approval",
    required_authority: requiredAuthority,
    requested_at: new Date().toISOString(),
  }
  await new EventLogWriter(logRoot).append({
    id: randomUUID(),
    type: "approval.requested",
    schema_version: "0.1.0",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: "agent:test",
    timestamp: new Date().toISOString(),
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: { schema_registry_version: "0.1.0" },
  })
  return { requestId, actionId }
}

/** Run the command with stdout/stderr captured so test output stays clean. */
async function runApprove(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ""
  let err = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const code = await approveCommand(argv)
    return { code, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

describe("lodestar approve — authority enforcement", () => {
  test("refuses a grant that does not clear sensitivity_clearance, writes no side-channel", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-clearance-"))
    try {
      const { requestId } = await seedRequest(logRoot, { sensitivity_clearance: "confidential" })
      // default clearance = public, which does not clear confidential
      const { code, err } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "weak",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(4)
      expect(err).toContain("does not clear")
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeUndefined()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("writes a grant when the approver clears the required clearance", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-clearance-ok-"))
    try {
      const { requestId, actionId } = await seedRequest(logRoot, {
        sensitivity_clearance: "confidential",
      })
      const { code } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "boss",
        "--clearance",
        "confidential",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      const queued = await readApprovalResolution(logRoot, PROJECT, requestId)
      expect(queued?.kind).toBe("granted")
      expect(queued?.approver_id).toBe("boss")
      expect(queued?.action_id).toBe(actionId)
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("refuses on trust-baseline shortfall and accepts when raised", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-trust-"))
    try {
      const { requestId } = await seedRequest(logRoot, { min_trust_baseline: 0.8 })
      const weak = await runApprove([
        "grant",
        requestId,
        "--approver",
        "weak",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(weak.code).toBe(4)
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeUndefined()
      const strong = await runApprove([
        "grant",
        requestId,
        "--approver",
        "lead",
        "--trust-baseline",
        "0.9",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(strong.code).toBe(0)
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeDefined()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("refuses on scope shortfall and accepts with the matching scope", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-scope-"))
    try {
      const { requestId } = await seedRequest(logRoot, {
        scope: { level: "repo", identifier: "prod" },
      })
      const noScope = await runApprove([
        "grant",
        requestId,
        "--approver",
        "dev",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(noScope.code).toBe(4)
      const scoped = await runApprove([
        "grant",
        requestId,
        "--approver",
        "dev",
        "--scope",
        "repo:prod",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(scoped.code).toBe(0)
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeDefined()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("a request with empty required_authority accepts a bare approver", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-empty-"))
    try {
      const { requestId } = await seedRequest(logRoot, {})
      const { code } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "me",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeDefined()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("a global-scope approver clears a specific required scope", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-global-"))
    try {
      const { requestId } = await seedRequest(logRoot, {
        scope: { level: "repo", identifier: "prod" },
      })
      const { code } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "admin",
        "--scope",
        "global",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      expect(await readApprovalResolution(logRoot, PROJECT, requestId)).toBeDefined()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })
})
