import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type Policy, PolicySchema } from "@qmilab/lodestar-core"
import { compile, compileWithSentinels } from "@qmilab/lodestar-guard"
import type {
  CompileWithSentinelsOptions,
  CompiledPolicy,
  SentinelArbiter,
} from "@qmilab/lodestar-guard"
import type { ProxyPolicyConfig } from "./config.js"

/**
 * Load and `PolicySchema`-parse the declarative document a `ProxyConfig.policy`
 * points at, and derive the gate's `decider_id` from its signer. Shared by both
 * compile paths (plain and sentinel-armed) so the file I/O and decider
 * derivation live in exactly one place.
 */
async function loadPolicyDocument(
  policyConfig: ProxyPolicyConfig,
  baseDir: string,
): Promise<{ document: Policy; decider_id: string }> {
  const path = resolve(baseDir, policyConfig.file)
  const raw: unknown = JSON.parse(await readFile(path, "utf8"))
  const document: Policy = PolicySchema.parse(raw)
  const decider_id =
    document.signed_by ??
    document.signature?.signer_id ??
    `policy:${document.id}@${document.version}`
  return { document, decider_id }
}

/**
 * Load and compile the declarative `Policy` document a `ProxyConfig.policy`
 * field points at, into the `CompiledPolicy` the CLI injects as the proxy's
 * gate (via `MCPProxyOverrides.policyGate`).
 *
 * The file I/O and signature verification live here, in the host (the CLI),
 * never in the proxy — the same separation `persistence` uses: the proxy
 * receives a constructed dependency, the host owns reading it off disk. That
 * keeps the proxy a pure function of its injected gate.
 *
 * `baseDir` is the directory the `file` path resolves against; the CLI passes
 * the proxy config file's own directory, so a config and its policy document
 * can ship side by side.
 *
 * The document's signer (`signed_by` / `signature.signer_id`) becomes the
 * gate's `decider_id` — the actor stamped onto every decision the gate emits;
 * an unsigned draft (only valid under `allow_unsigned`) falls back to
 * `policy:<id>@<version>`.
 *
 * Throws on a missing or malformed file (the JSON does not parse, or fails
 * `PolicySchema`) and — via `compile()` — on an unsigned active policy (unless
 * `allow_unsigned`) or a tampered signature (`payload_hash` mismatch). The CLI
 * surfaces any of these as a config error.
 */
export async function compileProxyPolicy(
  policyConfig: ProxyPolicyConfig,
  baseDir: string,
): Promise<CompiledPolicy> {
  const { document, decider_id } = await loadPolicyDocument(policyConfig, baseDir)
  return compile(document, { decider_id, allow_unsigned: policyConfig.allow_unsigned })
}

/**
 * Like {@link compileProxyPolicy}, but compiles the document *with* a
 * `SentinelArbiter` wired into the gate's arbitrate hook (ADR-0001 / ADR-0003),
 * returning the matched `{ gate, arbiter }` pair the CLI injects via
 * `MCPProxyOverrides.policyGate` + `MCPProxyOverrides.arbiter`.
 *
 * `sentinels` are the already-resolved `Sentinel` instances (the CLI resolves
 * the config's sentinel ids against the harness `FIRST_PARTY_SENTINELS` registry
 * — keeping this package free of a harness dependency). The gate and arbiter are
 * a matched pair: the proxy feeds events to the arbiter and the arbiter's
 * `resolveContext` is what the gate consults, so they must be compiled together,
 * which is exactly what `compileWithSentinels` guarantees.
 */
export async function compileProxyPolicyWithSentinels(
  policyConfig: ProxyPolicyConfig,
  baseDir: string,
  sentinels: CompileWithSentinelsOptions["sentinels"],
): Promise<{ gate: CompiledPolicy; arbiter: SentinelArbiter }> {
  const { document, decider_id } = await loadPolicyDocument(policyConfig, baseDir)
  return compileWithSentinels(document, {
    decider_id,
    allow_unsigned: policyConfig.allow_unsigned,
    sentinels,
  })
}
