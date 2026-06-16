import { readFileSync } from "node:fs"

/**
 * The harness package version, read lazily from its own `package.json`. Used as the
 * `harness_version` provenance field on a `probe_results` badge (ADR-0020) so a
 * consumer can see which harness produced the run. `../package.json` resolves the
 * package root from both `src/version.ts` (dev) and `dist/version.js` (published),
 * since each sits one level under the root.
 */
let cached: string | undefined

export function harnessVersion(): string {
  if (cached === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version?: string
      }
      cached = pkg.version ?? "0.0.0"
    } catch {
      cached = "0.0.0"
    }
  }
  return cached
}
