import { readFile } from "node:fs/promises"
import { ResourceScopeSchema } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * `RuntimeGateConfig` — the operator-pinned configuration for a governance-gate
 * sidecar. A deliberate near-twin of `@qmilab/lodestar-guard-mcp`'s `ProxyConfig`
 * (ADR-0024 §2): it carries the signed policy document, approver keys, sentinel
 * ids, persistence, and durable log root — everything the gate needs to wire the
 * *same* engine the MCP proxy runs. It drops the MCP-specific
 * `downstream_servers` (the gate's tools are registered at runtime over RPC, not
 * spawned), and `tool_defaults` becomes load-bearing: it is the **operator's**
 * action contract for each tool the hook registers, so an untrusted hook cannot
 * widen its own authority.
 */

/**
 * Per-tool action-contract overrides. Operator-controlled — the source of truth
 * for a governed tool's contract. The runtime hook declares only a tool's
 * *name*; everything that decides whether/how it may run comes from here (or the
 * conservative default below). This is the runtime analogue of the MCP proxy
 * ignoring untrusted downstream tool annotations: governance must survive a
 * hostile hook just as it must survive a hostile downstream server.
 */
export const ToolContractDefaultsSchema = z.object({
  reversibility: z.enum(["reversible", "compensable", "irreversible"]),
  permissions: z
    .array(z.enum(["fs.read", "fs.write", "shell.exec", "network.egress", "secret.sign"]))
    .default([]),
  sandbox: z.enum([
    "read",
    "write-isolated",
    "write-local",
    "controlled-shell",
    "controlled-network",
  ]),
  required_trust_level: z.number().int().min(0).max(5),
  blast_radius: z.enum(["self", "session", "project", "external"]).default("self"),
})
export type ToolContractDefaults = z.infer<typeof ToolContractDefaultsSchema>

/**
 * The conservative contract for a registered tool with no `tool_defaults` entry:
 * irreversible, external blast radius, all permissions, controlled-shell sandbox,
 * L3 trust — so an unconfigured tool biases toward "refuse unless approved"
 * rather than "approve unless caught" (and an L4 declaration always holds).
 * Operators opt a tool *down* to a lower trust level explicitly.
 */
export const CONSERVATIVE_TOOL_DEFAULTS: ToolContractDefaults = {
  reversibility: "irreversible",
  permissions: ["fs.read", "fs.write", "shell.exec", "network.egress"],
  sandbox: "controlled-shell",
  required_trust_level: 3,
  blast_radius: "external",
}

/** See `@qmilab/lodestar-guard-mcp`'s `PersistenceConfigSchema` — identical shape. */
export const PersistenceConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("memory") }),
  z.object({
    backend: z.literal("postgres"),
    connection_string_env: z.string().min(1),
  }),
])
export type PersistenceConfig = z.infer<typeof PersistenceConfigSchema>

/** Points the gate at a signed declarative `Policy` document instead of the
 *  `auto_approve_ceiling` preset. Same shape + discipline as the proxy's. */
export const RuntimePolicyConfigSchema = z.object({
  file: z.string().min(1),
  allow_unsigned: z.boolean().default(false),
})
export type RuntimePolicyConfig = z.infer<typeof RuntimePolicyConfigSchema>

/** One operator-pinned approver — the trust root for the signed approval path. */
export const AuthorizedApproverSchema = z.object({
  actor_id: z.string().min(1),
  public_key: z.string().min(1),
})
export type AuthorizedApprover = z.infer<typeof AuthorizedApproverSchema>

/** Signed-approval policy for resolving holds out-of-band (ADR-0010). */
export const ApprovalsConfigSchema = z.object({
  authorized_keys: z.array(AuthorizedApproverSchema).default([]),
  allow_unsigned: z.boolean().default(false),
})
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>

/**
 * True when a config would resolve an UNAUTHENTICATED out-of-band approval: it
 * enables out-of-band resolution (`approval_timeout_ms > 0`, so a hold parks and
 * can be un-parked by a signed resolution found in the durable log / `.approvals/`
 * side-channel) but pins no approver key and has not set `allow_unsigned`. Shared
 * by the schema superRefine and the `RuntimeGate` constructor so the parse-time
 * and construct-time checks can never drift — mirrors the proxy's predicate of
 * the same name.
 */
export function hasUnauthenticatedApprovalGap(config: {
  approval_timeout_ms?: number
  approvals?: { authorized_keys?: ReadonlyArray<unknown>; allow_unsigned?: boolean }
}): boolean {
  const timeoutMs = config.approval_timeout_ms ?? 0
  if (timeoutMs <= 0) return false
  const hasPinnedKey = (config.approvals?.authorized_keys?.length ?? 0) > 0
  const allowsUnsigned = config.approvals?.allow_unsigned === true
  return !hasPinnedKey && !allowsUnsigned
}

export const RuntimeGateConfigSchema = z
  .object({
    project_id: z
      .string()
      .min(1)
      .refine((v) => v !== "project-stub", {
        message: "project_id 'project-stub' is reserved for test fixtures",
      }),
    actor_id: z.string().min(1),
    session_id: z.union([
      z.literal("auto"),
      z
        .string()
        .min(1)
        .refine((v) => v !== "session-stub", {
          message: "session_id 'session-stub' is reserved for test fixtures",
        }),
    ]),
    log_root: z.string().default(".lodestar/events"),
    default_scope: ResourceScopeSchema,
    default_sensitivity: z
      .enum(["public", "internal", "confidential", "secret"])
      .default("internal"),
    auto_approve_ceiling: z.number().int().min(0).max(3).default(2),
    policy: RuntimePolicyConfigSchema.optional(),
    sentinels: z.array(z.string()).optional(),
    /**
     * The hold deadline window, in milliseconds.
     *
     *   - **0** (default): a held action is a terminal soft denial — the gate
     *     emits `approval.requested@1` then immediately returns `rejected`
     *     (`kind: approval_required`). No out-of-band resolution, no `.approvals/`
     *     read, no forgery surface. The hook re-proposes if it wants.
     *   - **> 0**: a held action parks at `pending_approval` with a deadline of
     *     `requested_at + approval_timeout_ms`. `govern` returns immediately (the
     *     LangGraph `interrupt()` idiom); the hook resolves it later with
     *     `resume`, which reads a *signed* resolution from the durable log / the
     *     `.approvals/` side-channel, deadline-gated and fail-closed. A
     *     headless hook can `resume` with `wait_ms` to block-poll instead.
     *
     * When > 0 the gate can promote an out-of-band approval, whose `approver_id`
     * is unauthenticated — so a pinned approver key (or an explicit
     * `allow_unsigned`) is required (see {@link hasUnauthenticatedApprovalGap}).
     */
    approval_timeout_ms: z.number().int().min(0).default(0),
    approvals: ApprovalsConfigSchema.optional(),
    tool_defaults: z.record(ToolContractDefaultsSchema).default({}),
    persistence: PersistenceConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if ((config.sentinels?.length ?? 0) > 0 && config.policy === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sentinels"],
        message:
          "`sentinels` requires `policy`: a declarative policy document is needed to compile the gate with arbitration — the auto_approve_ceiling preset cannot be armed with sentinels. Declare a `policy`, or remove `sentinels`.",
      })
    }
    if (hasUnauthenticatedApprovalGap(config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals"],
        message:
          "`approval_timeout_ms > 0` lets the gate promote an out-of-band approval whose `approver_id` is unauthenticated. Pin at least one `approvals.authorized_keys` entry so resolutions are Ed25519-verified, or set `approvals.allow_unsigned: true` to explicitly accept unsigned resolutions (a trusted local / development setup only).",
      })
    }
  })
export type RuntimeGateConfig = z.infer<typeof RuntimeGateConfigSchema>

/** Load and validate a gate config from a JSON file on disk. */
export async function loadRuntimeGateConfig(path: string): Promise<RuntimeGateConfig> {
  const raw = await readFile(path, "utf8")
  const parsed: unknown = JSON.parse(raw)
  return RuntimeGateConfigSchema.parse(parsed)
}
