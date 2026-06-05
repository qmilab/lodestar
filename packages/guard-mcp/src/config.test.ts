import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SentinelArbiter } from "@qmilab/lodestar-guard"
import { type ProxyConfig, ProxyConfigSchema } from "./config.js"
import { MCPProxy } from "./proxy.js"

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

describe("MCPProxy constructor sentinels guard", () => {
  // A direct `new MCPProxy(literal)` bypasses the schema superRefine; the
  // constructor must still refuse to run with declared-but-unwired sentinels
  // rather than silently ignore them (mirrors the policy / postgres guards).
  const withSentinels = { sentinels: ["suspicious-memory-origin"] }

  it("throws when config.sentinels is set but no arbiter is injected", () => {
    expect(
      () =>
        new MCPProxy(rawConfig(withSentinels) as unknown as ProxyConfig, {
          downstreamFactory: () => [],
        }),
    ).toThrow(/config\.sentinels is set but no arbiter/)
  })

  it("constructs when an arbiter is injected alongside declared sentinels", () => {
    expect(
      () =>
        new MCPProxy(rawConfig(withSentinels) as unknown as ProxyConfig, {
          arbiter: new SentinelArbiter({ sentinels: [] }),
          downstreamFactory: () => [],
        }),
    ).not.toThrow()
  })
})
