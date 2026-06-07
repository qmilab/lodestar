import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import type { Policy } from "@qmilab/lodestar-core"
import {
  SentinelArbiter,
  compile,
  compileWithSentinels,
  generateApproverKeyPair,
} from "@qmilab/lodestar-guard"
import { SuspiciousMemoryOriginSentinel } from "@qmilab/lodestar-harness"
import { type ProxyConfig, ProxyConfigSchema } from "./config.js"
import { MCPProxy } from "./proxy.js"

const POLICY: Policy = {
  id: "allow-l3",
  version: "1",
  rules: [{ match: { required_level_lte: 3 }, effect: "allow", reason: "test" }],
}

/** A minimal otherwise-valid raw config; tests layer the sentinels/policy fields. */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: "p",
    actor_id: "a",
    session_id: "s",
    log_root: join(tmpdir(), "lodestar-cfg-test"),
    default_scope: { level: "project", identifier: "p" },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    approval_timeout_ms: 0,
    downstream_servers: [{ name: "d", command: "x", args: [] }],
    tool_defaults: {},
    ...overrides,
  }
}

describe("ProxyConfigSchema sentinels↔policy invariant", () => {
  it("rejects sentinels declared without a policy (a security-relevant setting must not be silently ignored)", () => {
    const parsed = ProxyConfigSchema.safeParse(
      rawConfig({ sentinels: ["suspicious-memory-origin"] }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("`sentinels` requires `policy`")
    }
  })

  it("accepts sentinels alongside a policy document", () => {
    const parsed = ProxyConfigSchema.safeParse(
      rawConfig({
        sentinels: ["suspicious-memory-origin"],
        policy: { file: "policy.json", allow_unsigned: true },
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a config with no sentinels (the default)", () => {
    expect(ProxyConfigSchema.safeParse(rawConfig()).success).toBe(true)
  })
})

describe("ProxyConfigSchema signed-approvals invariant", () => {
  // A proxy that waits for an out-of-band resolution (approval_timeout_ms > 0)
  // promotes whatever lands in the side-channel, whose approver_id is
  // unauthenticated. Require either a pinned approver key or an explicit
  // allow_unsigned opt-out — no silent default for a security setting.
  it("rejects approval_timeout_ms > 0 with neither a pinned key nor allow_unsigned", () => {
    const parsed = ProxyConfigSchema.safeParse(rawConfig({ approval_timeout_ms: 30_000 }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("approval_timeout_ms > 0")
    }
  })

  it("accepts approval_timeout_ms > 0 when an approver key is pinned", () => {
    const parsed = ProxyConfigSchema.safeParse(
      rawConfig({
        approval_timeout_ms: 30_000,
        approvals: {
          authorized_keys: [{ actor_id: "operator", public_key: "-----BEGIN PUBLIC KEY-----\n…" }],
        },
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts approval_timeout_ms > 0 under an explicit allow_unsigned opt-out", () => {
    const parsed = ProxyConfigSchema.safeParse(
      rawConfig({ approval_timeout_ms: 30_000, approvals: { allow_unsigned: true } }),
    )
    expect(parsed.success).toBe(true)
  })

  it("requires nothing when approval_timeout_ms is 0 (no side-channel promotion)", () => {
    // The default config never waits, so it has no forgery surface and no
    // approvals requirement.
    expect(ProxyConfigSchema.safeParse(rawConfig()).success).toBe(true)
  })
})

describe("MCPProxy constructor signed-approvals guard", () => {
  // A direct `new MCPProxy(literal)` bypasses the schema superRefine, so the
  // constructor re-enforces the signed-approvals requirement (same pattern as
  // the persistence / sentinel guards).
  it("throws on approval_timeout_ms > 0 with no pinned key and no allow_unsigned", () => {
    expect(
      () =>
        new MCPProxy(rawConfig({ approval_timeout_ms: 30_000 }) as unknown as ProxyConfig, {
          downstreamFactory: () => [],
        }),
    ).toThrow(/approval_timeout_ms > 0 lets the proxy promote/)
  })

  it("constructs when allow_unsigned is set explicitly", () => {
    expect(
      () =>
        new MCPProxy(
          rawConfig({
            approval_timeout_ms: 30_000,
            approvals: { authorized_keys: [], allow_unsigned: true },
          }) as unknown as ProxyConfig,
          { downstreamFactory: () => [] },
        ),
    ).not.toThrow()
  })

  it("constructs when a valid Ed25519 approver key is pinned", () => {
    const { publicKeyPem } = generateApproverKeyPair()
    expect(
      () =>
        new MCPProxy(
          rawConfig({
            approval_timeout_ms: 30_000,
            approvals: {
              authorized_keys: [{ actor_id: "operator", public_key: publicKeyPem }],
              allow_unsigned: false,
            },
          }) as unknown as ProxyConfig,
          { downstreamFactory: () => [] },
        ),
    ).not.toThrow()
  })

  it("throws on a pinned approver key that is not a valid Ed25519 PEM (operator misconfig fails loudly)", () => {
    expect(
      () =>
        new MCPProxy(
          rawConfig({
            approval_timeout_ms: 30_000,
            approvals: {
              authorized_keys: [
                {
                  actor_id: "operator",
                  public_key:
                    "-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----",
                },
              ],
              allow_unsigned: false,
            },
          }) as unknown as ProxyConfig,
          { downstreamFactory: () => [] },
        ),
    ).toThrow(/unparseable public key|expected ed25519/)
  })
})

describe("MCPProxy constructor sentinels guard", () => {
  // A direct `new MCPProxy(literal)` bypasses the schema superRefine; the
  // constructor must still refuse to run with declared-but-unenforceable
  // sentinels rather than silently ignore them (mirrors the policy / postgres
  // guards). Enforcement needs BOTH an arbiter AND a CompiledPolicy gate whose
  // arbitrate hook consults it.
  const withSentinels = { sentinels: ["suspicious-memory-origin"] }

  it("throws when config.sentinels is set but no arbiter is injected", () => {
    expect(
      () =>
        new MCPProxy(rawConfig(withSentinels) as unknown as ProxyConfig, {
          downstreamFactory: () => [],
        }),
    ).toThrow(/config\.sentinels is set but no arbiter/)
  })

  it("throws when an arbiter is injected but the gate is the preset (no arbitrate hook)", () => {
    // Arbiter present, but `policyGate` omitted → the default auto_approve_ceiling
    // preset, which has no arbitrate hook, so the sentinels could never gate.
    expect(
      () =>
        new MCPProxy(rawConfig(withSentinels) as unknown as ProxyConfig, {
          arbiter: new SentinelArbiter({ sentinels: [] }),
          downstreamFactory: () => [],
        }),
    ).toThrow(/no CompiledPolicy gate/)
  })

  it("throws when an arbiter is wired DIRECTLY (no config.sentinels) without a compiled gate", () => {
    // The library path: a host injects MCPProxyOverrides.arbiter directly and
    // never sets config.sentinels. The guard must key on the arbiter, not the
    // config field — otherwise the arbiter emits alerts the preset gate ignores.
    expect(
      () =>
        new MCPProxy(rawConfig() as unknown as ProxyConfig, {
          arbiter: new SentinelArbiter({ sentinels: [] }),
          downstreamFactory: () => [],
        }),
    ).toThrow(/no CompiledPolicy gate/)
  })

  it("throws when the gate was compiled without arbitration (F6 binding-token mismatch)", () => {
    // A CompiledPolicy from plain compile() has no bindingToken, so its (absent)
    // arbitrate hook never consults the arbiter — the alerts would be inert.
    const gate = compile(POLICY, { decider_id: "test", allow_unsigned: true })
    expect(
      () =>
        new MCPProxy(rawConfig() as unknown as ProxyConfig, {
          policyGate: gate,
          arbiter: new SentinelArbiter({ sentinels: [] }),
          downstreamFactory: () => [],
        }),
    ).toThrow(/bindingToken mismatch|not compiled from the injected arbiter/)
  })

  it("throws when the gate and arbiter come from different compileWithSentinels pairs (F6)", () => {
    const pairA = compileWithSentinels(POLICY, {
      decider_id: "test",
      allow_unsigned: true,
      sentinels: [new SuspiciousMemoryOriginSentinel()],
    })
    const pairB = compileWithSentinels(POLICY, {
      decider_id: "test",
      allow_unsigned: true,
      sentinels: [new SuspiciousMemoryOriginSentinel()],
    })
    // gate from A, arbiter from B → their bindingTokens differ.
    expect(
      () =>
        new MCPProxy(rawConfig() as unknown as ProxyConfig, {
          policyGate: pairA.gate,
          arbiter: pairB.arbiter,
          downstreamFactory: () => [],
        }),
    ).toThrow(/bindingToken mismatch|not compiled from the injected arbiter/)
  })

  it("throws when a sentinel-compiled gate is injected without its arbiter (B″ mirror)", () => {
    // The host used compileWithSentinels for the gate (so it carries a
    // bindingToken) but forgot to pass overrides.arbiter — the proxy would never
    // feed the gate's arbiter or synthesize decisions, so the sentinels are inert.
    const { gate } = compileWithSentinels(POLICY, {
      decider_id: "test",
      allow_unsigned: true,
      sentinels: [new SuspiciousMemoryOriginSentinel()],
    })
    expect(
      () =>
        new MCPProxy(rawConfig() as unknown as ProxyConfig, {
          policyGate: gate,
          downstreamFactory: () => [],
        }),
    ).toThrow(/sentinel-compiled CompiledPolicy gate .* but no arbiter/)
  })

  it("constructs with the matched { gate, arbiter } pair from compileWithSentinels", () => {
    const { gate, arbiter } = compileWithSentinels(POLICY, {
      decider_id: "test",
      allow_unsigned: true,
      sentinels: [new SuspiciousMemoryOriginSentinel()],
    })
    expect(
      () =>
        new MCPProxy(rawConfig(withSentinels) as unknown as ProxyConfig, {
          policyGate: gate,
          arbiter,
          downstreamFactory: () => [],
        }),
    ).not.toThrow()
  })
})

describe("MCPProxy.start rollback", () => {
  it("resets started when arbiter binding fails, so the proxy stays retryable", async () => {
    _resetToolsForTests()
    const { gate, arbiter } = compileWithSentinels(POLICY, {
      decider_id: "test",
      allow_unsigned: true,
      sentinels: [new SuspiciousMemoryOriginSentinel()],
    })
    // The arbiter is already bound to another live session, so `bindSession()` in
    // start() throws. That throw must route through the startup rollback (which
    // resets `started`), not escape with `started` left true (Codex review, r5).
    arbiter.bindSession("a-different-live-session")
    const logRoot = await mkdtemp(join(tmpdir(), "lodestar-start-rollback-"))
    try {
      const proxy = new MCPProxy(rawConfig({ log_root: logRoot }) as unknown as ProxyConfig, {
        policyGate: gate,
        arbiter,
        downstreamFactory: () => [],
      })
      await expect(proxy.start()).rejects.toThrow(/single-session/)
      // `started` was reset by the rollback: a retry reaches `bindSession` again
      // (same single-session error) rather than throwing "already started" —
      // which is what would happen if `started` had leaked true.
      await expect(proxy.start()).rejects.toThrow(/single-session/)
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })
})
