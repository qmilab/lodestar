import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `lodestar probe <name>`
 *
 * Convenience for the probes in `packs/lodestar-core/probes/`. The
 * probes ship as standalone TypeScript scripts and are the source of
 * truth for firewall invariants — the CLI does not embed them, it
 * shells out to `bun run`.
 *
 * Probe names follow the file names (without the `.ts` extension).
 */

/**
 * Locate `packs/lodestar-core/probes/` by walking up from this file's
 * location. Resolving against `process.cwd()` would only work when the
 * CLI is invoked from the repo root — `lodestar probe …` called from
 * any subdirectory (or from an installed CLI) needs to find the probes
 * relative to the package, not the caller.
 */
function findProbeDir(): string {
  const thisFile = fileURLToPath(import.meta.url)
  let dir = dirname(thisFile)
  // Walk up until we find the pack's probes directory.
  // Bounded by filesystem root.
  while (true) {
    const candidate = resolve(dir, "packs", "lodestar-core", "probes")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break // hit filesystem root
    dir = parent
  }
  // Fall back to a CWD-relative lookup so callers running from the
  // repo root still work even if the bin was relocated.
  return resolve(process.cwd(), "packs", "lodestar-core", "probes")
}

const PROBE_DIR = findProbeDir()

/** Short-name → file mapping. Kept in sync with `packs/lodestar-core/probes/`. */
const PROBE_ALIASES: Record<string, string> = {
  poison: "memory-poisoning-basic",
  chain: "epistemic-chain-smoke",
  external: "external-document-not-normal",
  quarantine: "quarantined-not-retrievable",
  sensitivity: "sensitivity-ceiling",
  autoobs: "auto-observation-gate",
  "guard-import": "guard-import-no-self-promote",
  "guard-precond": "guard-precondition-revalidation",
  "guard-contract": "guard-contract-invariants",
  "reflection-retrieval": "reflection-cannot-promote-to-normal-alone",
  "reflection-cascade": "contradicted-belief-flags-dependent-decisions",
  "canonical-hash": "event-log-canonical-hash",
}

export async function probeCommand(argv: string[]): Promise<number> {
  const name = argv[0]
  if (!name) {
    process.stderr.write(
      `usage: lodestar probe <name>\nknown: ${Object.keys(PROBE_ALIASES).sort().join(", ")}\n`,
    )
    return 2
  }
  const file = PROBE_ALIASES[name] ?? name
  const path = resolve(PROBE_DIR, `${file}.ts`)

  return new Promise<number>((resolveExit) => {
    const proc = spawn("bun", ["run", path], { stdio: "inherit" })
    proc.on("exit", (code) => resolveExit(code ?? 0))
    proc.on("error", (err) => {
      process.stderr.write(`failed to spawn probe: ${err.message}\n`)
      resolveExit(1)
    })
  })
}
