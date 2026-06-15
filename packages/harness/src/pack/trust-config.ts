import { readFile } from "node:fs/promises"
import { type PackTrustConfig, PackTrustConfigSchema } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"

/**
 * Consumer trust config IO (#90, ADR-0019). The config names the author keys
 * `lodestar pack add` verifies a pack against; its shape (and fail-closed default)
 * mirror the proxy's `approvals.authorized_keys` (ADR-0010). Core owns the schema;
 * this is the harness's filesystem read.
 */

/** Default location an operator pins author keys, relative to the cwd. */
export const DEFAULT_PACK_TRUST_PATH = ".lodestar/pack-trust.json"

/** An empty trust config: no pinned keys, so a signed pack is rejected unless an author is pinned elsewhere (e.g. a `--author-key` flag). */
function emptyTrustConfig(): PackTrustConfig {
  return { author_keys: [] }
}

/**
 * Read and validate the trust config at `path`. When `required` is false (the
 * default-path case) an absent file resolves to an empty config — secure by
 * default: no keys pinned means a signed pack is rejected unless its author is
 * pinned another way. When `required` is true (the operator passed an explicit
 * `--trust-config`) an absent file is an error rather than a silent empty, so a
 * mistyped path does not quietly drop every pinned key.
 */
export async function readPackTrustConfig(
  path: string,
  options: { required?: boolean } = {},
): Promise<PackTrustConfig> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if (!options.required && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyTrustConfig()
    }
    throw new ProbePackError(`Could not read pack trust config: ${path}`, { cause: err })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ProbePackError(`Pack trust config is not valid JSON: ${path}`, { cause })
  }

  const result = PackTrustConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Pack trust config failed validation: ${path}\n${issues}`)
  }
  return result.data
}
