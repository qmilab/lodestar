import { resolve } from "node:path"
import { spawn } from "node:child_process"

/**
 * `orrery probe <name>`
 *
 * Convenience for the research probes in `research/probes/`. The
 * probes ship as standalone TypeScript scripts and are this batch's
 * source of truth for firewall invariants — the CLI does not embed
 * them, it shells out to `bun run`.
 *
 * Probe names follow the file names (without the `.ts` extension).
 */
const PROBE_DIR_REL = "research/probes"

/** Short-name → file mapping. Kept in sync with `research/probes/`. */
const PROBE_ALIASES: Record<string, string> = {
  poison: "memory-poisoning-basic",
  chain: "epistemic-chain-smoke",
  external: "external-document-not-normal",
  quarantine: "quarantined-not-retrievable",
  sensitivity: "sensitivity-ceiling",
  autoobs: "auto-observation-gate",
  "guard-import": "guard-import-no-self-promote",
  "guard-precond": "guard-precondition-revalidation",
}

export async function probeCommand(argv: string[]): Promise<number> {
  const name = argv[0]
  if (!name) {
    process.stderr.write(
      `usage: orrery probe <name>\nknown: ${Object.keys(PROBE_ALIASES).sort().join(", ")}\n`,
    )
    return 2
  }
  const file = PROBE_ALIASES[name] ?? name
  const path = resolve(process.cwd(), PROBE_DIR_REL, `${file}.ts`)

  return new Promise<number>((resolveExit) => {
    const proc = spawn("bun", ["run", path], { stdio: "inherit" })
    proc.on("exit", (code) => resolveExit(code ?? 0))
    proc.on("error", (err) => {
      process.stderr.write(`failed to spawn probe: ${err.message}\n`)
      resolveExit(1)
    })
  })
}
