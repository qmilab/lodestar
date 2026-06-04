import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type Policy, PolicySchema } from "@qmilab/lodestar-core"
import { compile } from "@qmilab/lodestar-guard"
import type { CompiledPolicy } from "@qmilab/lodestar-guard"
import type { ProxyPolicyConfig } from "./config.js"

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
  const path = resolve(baseDir, policyConfig.file)
  const raw: unknown = JSON.parse(await readFile(path, "utf8"))
  const document: Policy = PolicySchema.parse(raw)
  const decider_id =
    document.signed_by ??
    document.signature?.signer_id ??
    `policy:${document.id}@${document.version}`
  return compile(document, { decider_id, allow_unsigned: policyConfig.allow_unsigned })
}
