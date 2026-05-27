import { readFile } from "node:fs/promises"
import { z } from "zod"
import { ResourceScopeSchema } from "@qmilab/lodestar-core"

/**
 * Configuration for one downstream MCP server the proxy should manage.
 *
 * v0 supports stdio-spawned downstream servers only (the proxy
 * launches the server as a child process and talks to it via stdin/
 * stdout). HTTP/SSE downstream support is deferred to a later batch
 * when the deployment story needs it.
 */
export const DownstreamServerConfigSchema = z.object({
  /**
   * Logical name. Used as the second segment in the namespaced tool
   * name (`mcp.<name>.<tool>`). Two downstream servers cannot share a
   * name — the proxy enforces uniqueness at startup.
   */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "downstream name must match [a-z][a-z0-9_]*"),
  /** Executable to spawn (npx, node, bun, /usr/local/bin/something). */
  command: z.string(),
  /** Arguments to pass to the executable. */
  args: z.array(z.string()).default([]),
  /**
   * Environment variables for the downstream process. Note the proxy
   * does NOT inherit the host process's env by default — the
   * downstream sees only what's listed here (plus the MCP SDK's
   * default-safe inheritance set: PATH, HOME, etc.). This is a
   * sandboxing affordance: secrets in the proxy's env stay in the
   * proxy.
   */
  env: z.record(z.string()).optional(),
  /** Working directory for the downstream process. Defaults to the proxy's cwd. */
  cwd: z.string().optional(),
})
export type DownstreamServerConfig = z.infer<typeof DownstreamServerConfigSchema>

/**
 * Per-tool action-contract overrides. Operator-controlled. MCP tool
 * annotations are explicitly NOT trusted as a source for these — the
 * MCP spec marks annotations as "untrusted unless from a trusted
 * server," and the proxy's job is to enforce a policy that survives
 * a hostile downstream. Operators who want to lower trust for a
 * specific tool must declare it here.
 *
 * Tools not mentioned in `tool_defaults` fall back to the
 * conservative defaults documented in `CLAUDE.md` (irreversible,
 * controlled-shell sandbox, L3 trust). That biases toward "refuse
 * unless approved" rather than "approve unless caught."
 */
export const ToolContractDefaultsSchema = z.object({
  reversibility: z.enum(["reversible", "compensable", "irreversible"]),
  /** Maps onto the Lodestar tool's effects + permissions surface. */
  permissions: z
    .array(z.enum(["fs.read", "fs.write", "shell.exec", "network.egress", "secret.sign"]))
    .default([]),
  sandbox: z.enum(["read", "write-isolated", "write-local", "controlled-shell"]),
  required_trust_level: z.number().int().min(0).max(5),
  /**
   * Blast radius for the ActionContract. Applied at every invocation
   * of the tool (the proxy can't make this per-call without a
   * heavier API). Mirrors `@qmilab/lodestar-core`'s `BlastRadius`
   * enum.
   */
  blast_radius: z.enum(["self", "session", "project", "external"]).default("self"),
})
export type ToolContractDefaults = z.infer<typeof ToolContractDefaultsSchema>

/**
 * Top-level proxy config. The CLI loads this from a path on disk.
 *
 * Round 5 invariant: the proxy MUST receive a real session_id and
 * project_id from the host. `session_id: "auto"` means "the proxy
 * generates a fresh UUID at startup and propagates it"; any other
 * value pins the session for reproducibility. Stub values like
 * `"session-stub"` are intentionally not accepted — the schema
 * rejects them.
 */
export const ProxyConfigSchema = z.object({
  project_id: z.string().min(1).refine((v) => v !== "project-stub", {
    message: "project_id 'project-stub' is reserved for test fixtures",
  }),
  actor_id: z.string().min(1),
  session_id: z.union([
    z.literal("auto"),
    z.string().min(1).refine((v) => v !== "session-stub", {
      message: "session_id 'session-stub' is reserved for test fixtures",
    }),
  ]),
  /** Where the event log NDJSON files are written. */
  log_root: z.string().default(".lodestar/events"),
  /**
   * Scope tagged on every Claim, Belief, and ActionContract this
   * proxy session emits. Mirrors `@qmilab/lodestar-core`'s
   * `ResourceScope`: `{ level, identifier }`.
   */
  default_scope: ResourceScopeSchema,
  default_sensitivity: z
    .enum(["public", "internal", "confidential", "secret"])
    .default("internal"),
  /**
   * Trust ceiling for the auto-approve policy. Tools with
   * `required_trust_level` ≤ this ceiling are auto-approved; higher
   * requires explicit approval (returns a synthetic policy_denied
   * result to the agent). v0 has no approval UI — the ceiling IS
   * the policy.
   *
   * Range is 0..4 because L5 is "prohibited" in the Lodestar trust
   * ladder and cannot serve as an auto-approve ceiling; `autoApprove
   * Policy()` itself throws on ceiling=5, so we mirror the bound
   * here to fail at config-load time instead.
   */
  auto_approve_ceiling: z.number().int().min(0).max(4).default(2),
  downstream_servers: z
    .array(DownstreamServerConfigSchema)
    .min(1)
    .refine(
      (servers) => new Set(servers.map((s) => s.name)).size === servers.length,
      {
        message:
          "downstream_servers[*].name must be unique; two entries with the same " +
          "name would map their tools to the same `mcp.<name>.<tool>` namespace " +
          "and make tool_defaults ownership + audit trail ambiguous",
      },
    ),
  tool_defaults: z.record(ToolContractDefaultsSchema).default({}),
})
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>

/**
 * Load and validate a proxy config from a JSON file on disk.
 *
 * Throws if the file is missing, malformed, or fails Zod validation.
 * Callers (the CLI) surface those errors to the operator; the proxy
 * itself never silently substitutes defaults for security-relevant
 * fields.
 */
export async function loadProxyConfig(path: string): Promise<ProxyConfig> {
  const raw = await readFile(path, "utf8")
  const parsed: unknown = JSON.parse(raw)
  return ProxyConfigSchema.parse(parsed)
}
