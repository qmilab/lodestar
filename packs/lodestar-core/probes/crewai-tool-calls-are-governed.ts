/**
 * Probe: crewai-tool-calls-are-governed  (runtime-gated, end-to-end)
 *
 * The real-runtime lock for the CrewAI adapter (ADR-0026 / ADR-0024 §8). It drives
 * REAL CrewAI tools through the `lodestar-crewai` hook and the TypeScript
 * governance-gate sidecar, adding the cases the always-on in-TS
 * `runtime-gate-enforces-two-phase` probe cannot exercise: CrewAI's own execution
 * path (`CrewStructuredTool.invoke`), a custom step via `governed_call`, an
 * async-only tool (`_arun`) run through the remoted execute, concurrent calls
 * correlated correctly, an L4 hold across the boundary (the body never runs), a
 * dynamically-unregistered tool rejected fail-closed, and the governed wrappers
 * attaching to a real `Agent`/`Task`/`Crew`.
 *
 * The TS side is a thin orchestrator: it detects Python + CrewAI and runs the
 * `runtimes/crewai/tests/e2e_crewai.py` driver, keying on its exit code. It
 * **skips loudly** (exit 0, banner) when Python or CrewAI is absent — mirroring
 * the DB-gated `tool-poisoning-cross-session` and the sandbox-gated
 * `runner-sandboxes-probe-filesystem-and-network`. CI installs the runtime so the
 * real path is exercised there.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const NAME = "crewai_tool_calls_are_governed"
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const E2E = join(REPO_ROOT, "runtimes", "crewai", "tests", "e2e_crewai.py")
const PYTHON = process.env.LODESTAR_PYTHON ?? "python3"

function banner(status: string, lines: string[]): void {
  console.log("─".repeat(72))
  console.log(`probe: ${NAME}`)
  console.log("─".repeat(72))
  console.log(`status: ${status}`)
  for (const line of lines) console.log(`  ${line}`)
  console.log("─".repeat(72))
}

function skip(reason: string): never {
  banner("SKIP ⊘", [
    `${reason} — skipping.`,
    "This probe drives real CrewAI tools through the hook + sidecar.",
    "Install Python 3.10+ and `pip install crewai` to run it.",
    "CI installs the runtime, so the real path is exercised there.",
  ])
  process.exit(0)
}

// 1. The e2e driver must be present.
if (!existsSync(E2E)) skip(`e2e driver not found at ${E2E}`)

// 2. Python + CrewAI must be importable.
const probe = spawnSync(PYTHON, ["-c", "import crewai"], { stdio: "ignore" })
if (probe.error !== undefined || probe.status !== 0) {
  skip(
    probe.error !== undefined
      ? `${PYTHON} not available`
      : "crewai not importable",
  )
}

// 3. Run the real end-to-end driver; its exit code is the verdict. Its own
//    detailed PASS/FAIL lines stream through (stdio: inherit).
const run = spawnSync(PYTHON, [E2E], { stdio: "inherit", cwd: REPO_ROOT })
if (run.error !== undefined) {
  banner("FAIL ✗", [`could not launch the e2e driver: ${run.error.message}`])
  process.exit(1)
}
if (run.status === 0) {
  banner("PASS ✓", [
    "real CrewAI tool calls were governed end-to-end through the hook + sidecar",
  ])
  process.exit(0)
}
banner("FAIL ✗", [`the CrewAI e2e driver exited ${run.status}`])
process.exit(1)
