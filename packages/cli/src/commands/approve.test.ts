import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequiredAuthority } from "@qmilab/lodestar-core"
import {
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import { verifyApprovalSignature } from "@qmilab/lodestar-guard"
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
// Computed-member access (not `delete process.env.LITERAL`) so the biome
// noDelete perf rule doesn't fire — env vars must be *unset*, not set to the
// string "undefined". Same form as adapter-git's test env reset.
const APPROVER_KEY_ENV = "LODESTAR_APPROVER_KEY"

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

describe("lodestar approve — signing (P3)", () => {
  /** Mint a keypair to files via `approve keygen --out`, returning the paths + public PEM. */
  async function keygenToFiles(
    dir: string,
    approver: string,
  ): Promise<{ privPath: string; pubPath: string; publicKeyPem: string }> {
    const prefix = join(dir, "approver")
    const { code } = await runApprove(["keygen", "--approver", approver, "--out", prefix])
    expect(code).toBe(0)
    return {
      privPath: `${prefix}.key`,
      pubPath: `${prefix}.pub`,
      publicKeyPem: await readFile(`${prefix}.pub`, "utf8"),
    }
  }

  test("keygen refuses without --approver (no placeholder pin)", async () => {
    const { code, err } = await runApprove(["keygen"])
    expect(code).toBe(2)
    expect(err).toContain("missing required --approver")
  })

  test("keygen --out writes a 0600 private key + a public key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-approve-keygen-"))
    try {
      const { privPath, pubPath } = await keygenToFiles(dir, "human:operator")
      expect((await stat(privPath)).mode & 0o777).toBe(0o600)
      expect(await readFile(privPath, "utf8")).toContain("-----BEGIN PRIVATE KEY-----")
      expect(await readFile(pubPath, "utf8")).toContain("-----BEGIN PUBLIC KEY-----")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a grant with --key writes a resolution whose signature verifies against the public key", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-sign-"))
    try {
      const { privPath, publicKeyPem } = await keygenToFiles(logRoot, "human:operator")
      const { requestId, actionId } = await seedRequest(logRoot, {})
      const { code, out } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "human:operator",
        "--key",
        privPath,
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      expect(out).toContain("(signed)")
      const queued = await readApprovalResolution(logRoot, PROJECT, requestId)
      expect(queued?.signature).toBeDefined()
      expect(queued?.signature?.signer_id).toBe("human:operator")
      // The signature verifies against the pinned key for the real resolution doc.
      expect(() =>
        verifyApprovalSignature(
          {
            request_id: requestId,
            action_id: actionId,
            kind: "granted",
            approver_id: "human:operator",
            at: queued?.at ?? "",
          },
          queued?.signature,
          { authorizedKeys: [{ actor_id: "human:operator", public_key: publicKeyPem }] },
        ),
      ).not.toThrow()
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("a grant via LODESTAR_APPROVER_KEY env also signs", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-env-"))
    const prev = process.env[APPROVER_KEY_ENV]
    try {
      const { privPath } = await keygenToFiles(logRoot, "human:operator")
      process.env[APPROVER_KEY_ENV] = await readFile(privPath, "utf8")
      const { requestId } = await seedRequest(logRoot, {})
      const { code } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "human:operator",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      expect((await readApprovalResolution(logRoot, PROJECT, requestId))?.signature).toBeDefined()
    } finally {
      if (prev === undefined) delete process.env[APPROVER_KEY_ENV]
      else process.env[APPROVER_KEY_ENV] = prev
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("a grant with no key writes an UNSIGNED resolution and warns", async () => {
    _resetEventLogStateForTests()
    const logRoot = await mkdtemp(join(tmpdir(), "cli-approve-nosign-"))
    const prev = process.env[APPROVER_KEY_ENV]
    try {
      // Ensure the env fallback is not set, so this is genuinely unsigned.
      delete process.env[APPROVER_KEY_ENV]
      const { requestId } = await seedRequest(logRoot, {})
      const { code, out, err } = await runApprove([
        "grant",
        requestId,
        "--approver",
        "human:operator",
        "--project",
        PROJECT,
        "--log-root",
        logRoot,
      ])
      expect(code).toBe(0)
      expect(err).toContain("WITHOUT a signature")
      expect(out).toContain("(UNSIGNED)")
      expect((await readApprovalResolution(logRoot, PROJECT, requestId))?.signature).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env[APPROVER_KEY_ENV] = prev
      await rm(logRoot, { recursive: true, force: true })
    }
  })
})
