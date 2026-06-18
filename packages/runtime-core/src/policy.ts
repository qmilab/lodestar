import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type Policy, PolicySchema } from "@qmilab/lodestar-core"
import {
  type CompileWithSentinelsOptions,
  type CompiledPolicy,
  type SentinelArbiter,
  compile,
  compileWithSentinels,
} from "@qmilab/lodestar-guard"
import type { RuntimePolicyConfig } from "./config.js"

/**
 * Compile the declarative `Policy` document a `RuntimeGateConfig.policy` points
 * at into the gate the sidecar uses. The mirror of `@qmilab/lodestar-guard-mcp`'s
 * `compileProxyPolicy` — the file I/O + signature verification live in the host
 * (the CLI), never in the gate, the same separation `persistence` uses. The
 * document's signer becomes the gate's `decider_id`.
 */
async function loadPolicyDocument(
  policyConfig: RuntimePolicyConfig,
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

/** Load + `compile()` a signed policy document into the gate's `CompiledPolicy`. */
export async function compileRuntimePolicy(
  policyConfig: RuntimePolicyConfig,
  baseDir: string,
): Promise<CompiledPolicy> {
  const { document, decider_id } = await loadPolicyDocument(policyConfig, baseDir)
  return compile(document, { decider_id, allow_unsigned: policyConfig.allow_unsigned })
}

/**
 * Like {@link compileRuntimePolicy}, but compiles the document *with* a
 * `SentinelArbiter` wired into the gate's arbitrate hook (ADR-0001 / ADR-0003),
 * returning the matched `{ gate, arbiter }` pair. `sentinels` are already-resolved
 * `Sentinel` instances (the CLI resolves the config's ids against the harness
 * `FIRST_PARTY_SENTINELS` registry, keeping this package free of a harness
 * dependency).
 */
export async function compileRuntimePolicyWithSentinels(
  policyConfig: RuntimePolicyConfig,
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
