import type { z } from "zod"

/**
 * Registry of observation schemas.
 *
 * Every tool that emits observations registers its output schema here.
 * The Action Kernel validates tool outputs against the registry before
 * they become `validated` observations and enter the cognitive core.
 *
 * Schema keys follow the pattern `<namespace>.<name>@<version>`,
 * e.g. `git.status@1`, `github.pr@2`.
 *
 * Schemas may not be replaced after registration; bump the version
 * suffix and register the new schema alongside the old one. This
 * preserves replay compatibility for events that referenced the old key.
 */
const registry = new Map<string, z.ZodTypeAny>()

export function register(key: string, schema: z.ZodTypeAny): void {
  if (registry.has(key)) {
    throw new Error(
      `schema registry: key '${key}' is already registered; bump the version and register a new key`,
    )
  }
  // Validate key shape
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*@\d+$/.test(key)) {
    throw new Error(
      `schema registry: key '${key}' must match <namespace>.<name>@<version>, e.g. 'git.status@1'`,
    )
  }
  registry.set(key, schema)
}

export function lookup(key: string): z.ZodTypeAny | undefined {
  return registry.get(key)
}

export function has(key: string): boolean {
  return registry.has(key)
}

export function keys(): string[] {
  return Array.from(registry.keys()).sort()
}

/**
 * For replay safety: returns a content hash of the registry state.
 * Replays can compare this against the value stored in EventVersions.
 *
 * Uses Node's built-in crypto so the registry can be used in Bun and
 * Node alike. Bun's web-standard crypto is also available, but Node's
 * createHash is the most portable.
 */
export function fingerprint(): string {
  const sorted = keys().join(",")
  // sha-256 hex digest of the sorted keys
  // node:crypto is available in both Bun and Node
  const crypto = require("node:crypto") as typeof import("node:crypto")
  return crypto.createHash("sha256").update(sorted).digest("hex")
}

/**
 * For tests only. Resets the registry between test cases.
 * Do NOT call this from production code.
 */
export function _resetForTests(): void {
  registry.clear()
}
