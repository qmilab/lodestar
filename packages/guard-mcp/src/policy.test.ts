import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Action, Policy } from "@qmilab/lodestar-core"
import { PolicyCompileError } from "@qmilab/lodestar-guard"
import { SuspiciousMemoryOriginSentinel } from "@qmilab/lodestar-harness"
import { compileProxyPolicy, compileProxyPolicyWithSentinels } from "./policy.js"

const TOOL = "mcp.test.push"

/** An unsigned draft whose one rule demands a trusted, project-scoped approver. */
function draftPolicy(): Policy {
  return {
    id: "test-policy",
    version: "v1",
    rules: [
      {
        match: { tool: TOOL },
        effect: "require_approval",
        approval: {
          required_authority: {
            min_trust_baseline: 0.7,
            scope: { level: "project", identifier: "proj" },
          },
        },
        reason: "needs a trusted approver",
      },
    ],
  }
}

/** A minimal L4 action the gate evaluates — only `tool` + `contract` are read. */
function l4Action(): Action {
  return {
    tool: TOOL,
    contract: {
      required_level: 4,
      blast_radius: "external",
      reversibility: "irreversible",
      data_sensitivity: "private",
      scope: { level: "project", identifier: "proj" },
      preconditions: [],
    },
  } as unknown as Action
}

async function writePolicyFile(dir: string, name: string, policy: Policy): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(policy), "utf8")
}

describe("compileProxyPolicy", () => {
  it("compiles an unsigned draft under allow_unsigned and recovers the rule's authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-proxy-policy-"))
    try {
      await writePolicyFile(dir, "policy.json", draftPolicy())
      const compiled = await compileProxyPolicy({ file: "policy.json", allow_unsigned: true }, dir)
      const ev = compiled.evaluate(l4Action())
      expect(ev.verdict).toBe("hold")
      expect(ev.required_authority?.min_trust_baseline).toBe(0.7)
      expect(ev.required_authority?.scope).toEqual({ level: "project", identifier: "proj" })
      // An unsigned draft has no signer, so decider_id falls back to policy:<id>@<version>.
      expect(ev.decider_id).toBe("policy:test-policy@v1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects an unsigned policy when allow_unsigned is false (the production default)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-proxy-policy-"))
    try {
      await writePolicyFile(dir, "policy.json", draftPolicy())
      await expect(
        compileProxyPolicy({ file: "policy.json", allow_unsigned: false }, dir),
      ).rejects.toThrow(PolicyCompileError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("resolves the file path relative to baseDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-proxy-policy-"))
    try {
      await mkdir(join(dir, "policies"))
      await writePolicyFile(join(dir, "policies"), "p.json", draftPolicy())
      const compiled = await compileProxyPolicy(
        { file: "policies/p.json", allow_unsigned: true },
        dir,
      )
      expect(compiled.policy.id).toBe("test-policy")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("throws on a missing policy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-proxy-policy-"))
    try {
      await expect(
        compileProxyPolicy({ file: "nope.json", allow_unsigned: true }, dir),
      ).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("compileProxyPolicyWithSentinels", () => {
  it("compiles the same document and returns a matched gate + arbiter pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-proxy-policy-sentinels-"))
    try {
      await writePolicyFile(dir, "policy.json", draftPolicy())
      const { gate, arbiter } = await compileProxyPolicyWithSentinels(
        { file: "policy.json", allow_unsigned: true },
        dir,
        [new SuspiciousMemoryOriginSentinel()],
      )
      // The gate still recovers the rule's authority (the arbitrate hook only
      // *strengthens* a verdict; the base contract+rule evaluation is unchanged).
      const ev = gate.evaluate(l4Action())
      expect(ev.verdict).toBe("hold")
      expect(ev.required_authority?.min_trust_baseline).toBe(0.7)
      // The arbiter is real and single-session (it exposes the sentinel actor).
      expect(arbiter.actorId).toBe("lodestar-sentinel")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
