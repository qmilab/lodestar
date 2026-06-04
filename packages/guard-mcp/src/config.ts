import { readFile } from "node:fs/promises"
import { ResourceScopeSchema } from "@qmilab/lodestar-core"
import { z } from "zod"

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
 * Belief/claim/evidence persistence backend for the proxy session.
 *
 * `memory` (the default) keeps the firewall stores in-process: state
 * lives and dies with the proxy, which is all a single-session audit
 * needs. `postgres` points the three firewall stores at a shared
 * database so two proxy sessions see each other's beliefs — the
 * substrate the `tool-poisoning-cross-session` probe exercises and the
 * only backend under which cross-session provenance checks are
 * meaningful.
 *
 * The connection string is taken from an environment variable named by
 * `connection_string_env`, never embedded in the config file. A DB DSN
 * usually carries a password; keeping it in the environment (not on
 * disk, not in VCS) mirrors the package-wide rule that secrets stay out
 * of declared config. The CLI reads the named variable at startup and
 * fails loudly if it is unset.
 *
 * The `MCPProxy` itself never opens a connection: persistence is wired
 * by injecting already-constructed stores (`MCPProxyOverrides.stores`).
 * The CLI is what reads this field, builds the Postgres stores from the
 * env var, and owns their lifecycle. A `postgres` config that reaches a
 * proxy with no injected stores is a wiring error and the proxy throws
 * rather than silently falling back to in-memory.
 */
export const PersistenceConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("memory") }),
  z.object({
    backend: z.literal("postgres"),
    /**
     * Name of the environment variable holding the Postgres
     * connection string (e.g. `LODESTAR_DATABASE_URL`). The value is
     * resolved by the CLI at startup, never stored here.
     */
    connection_string_env: z.string().min(1),
  }),
])
export type PersistenceConfig = z.infer<typeof PersistenceConfigSchema>

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
  /** Where the event log NDJSON files are written. */
  log_root: z.string().default(".lodestar/events"),
  /**
   * Scope tagged on every Claim, Belief, and ActionContract this
   * proxy session emits. Mirrors `@qmilab/lodestar-core`'s
   * `ResourceScope`: `{ level, identifier }`.
   */
  default_scope: ResourceScopeSchema,
  default_sensitivity: z.enum(["public", "internal", "confidential", "secret"]).default("internal"),
  /**
   * Trust ceiling for the auto-approve policy. Tools with
   * `required_trust_level` ≤ this ceiling are auto-approved; higher
   * requires explicit approval.
   *
   * Range is 0..3. With the Policy Kernel's graduated `autoApprovePolicy`,
   * the trust-ladder floor makes L4 (external/shared) *always* require
   * approval and L5 prohibited — neither is an expressible auto-approve
   * ceiling, and `autoApprovePolicy()` throws on a ceiling of 4 or 5. We
   * mirror that bound here to fail at config-load time instead. An L4 tool
   * is held regardless of this ceiling (see `approval_timeout_ms`).
   */
  auto_approve_ceiling: z.number().int().min(0).max(3).default(2),
  /**
   * How long (milliseconds) the proxy waits on a held action for an
   * out-of-band resolution before timing out.
   *
   * A `tools/call` is request/response, so the proxy cannot hold one open
   * indefinitely without tripping the wrapped agent's client timeout. When an
   * action is held (an L4 tool the trust-ladder floor parks at
   * `pending_approval`), the proxy emits `approval.requested@1` and then polls
   * the event log up to this deadline for an `approval.granted@1` /
   * `approval.denied@1` written out-of-band (the `lodestar approve` CLI, the
   * approval UI). On a grant it un-parks and runs the tool; on a deny or a
   * deadline pass it returns a synthetic result the agent re-plans around
   * (`_lodestar.kind` = `approval_denied` / `approval_timeout`). A timed-out
   * hold is a soft denial the agent re-proposes — durable resume is deferred.
   *
   * Defaults to **0** = do not wait: surface the hold immediately as
   * `approval_required` (the conservative, backward-compatible default — set
   * a positive value below the client's timeout to enable out-of-band
   * approval). Keep it comfortably under the wrapped agent's `tools/call`
   * timeout.
   *
   * Caveat: an *in-process* resolver is fully safe; a *separate process*
   * writing the resolution is not yet seq-safe (the event-log writer's counters
   * are process-local — see `EventLogWriter`). The separate-process
   * `lodestar approve` CLI needs the writer's cross-process locking first.
   */
  approval_timeout_ms: z.number().int().min(0).default(0),
  downstream_servers: z
    .array(DownstreamServerConfigSchema)
    .min(1)
    .refine((servers) => new Set(servers.map((s) => s.name)).size === servers.length, {
      message:
        "downstream_servers[*].name must be unique; two entries with the same " +
        "name would map their tools to the same `mcp.<name>.<tool>` namespace " +
        "and make tool_defaults ownership + audit trail ambiguous",
    }),
  tool_defaults: z.record(ToolContractDefaultsSchema).default({}),
  /**
   * Where the firewall's belief/claim/evidence stores live. Omitted (or
   * `{ backend: "memory" }`) means in-memory, single-session — the
   * default. Set `{ backend: "postgres", connection_string_env: "..." }`
   * for a session that shares durable state with other sessions. See
   * {@link PersistenceConfigSchema}.
   */
  persistence: PersistenceConfigSchema.optional(),
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
