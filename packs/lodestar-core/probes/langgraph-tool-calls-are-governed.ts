/**
 * Probe: langgraph-tool-calls-are-governed  (runtime-gated, end-to-end)
 *
 * The real-runtime lock for the LangGraph adapter (ADR-0024 §8). It drives a REAL
 * Python LangGraph loop through the `lodestar-langgraph` hook and the TypeScript
 * governance-gate sidecar, adding the cases the always-on in-TS
 * `runtime-gate-enforces-two-phase` probe cannot exercise: the prebuilt
 * `ToolNode`, a custom node via `governed_call`, async (`ainvoke`), batch /
 * parallel calls, an L4 hold across the boundary (the body never runs), and a
 * dynamically-registered/unregistered tool rejected fail-closed.
 *
 * The TS side is a thin orchestrator: it detects Python + LangGraph and runs the
 * `runtimes/langgraph/tests/e2e_langgraph.py` driver, keying on its exit code. It
 * **skips loudly** (exit 0, banner) when Python or LangGraph is absent — mirroring
 * the DB-gated `tool-poisoning-cross-session` and the sandbox-gated
 * `runner-sandboxes-probe-filesystem-and-network`. CI installs the runtime so the
 * real path is exercised there.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const NAME = "langgraph_tool_calls_are_governed"
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const E2E = join(REPO_ROOT, "runtimes", "langgraph", "tests", "e2e_langgraph.py")
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
    "This probe drives a real Python LangGraph loop through the hook + sidecar.",
    "Install Python 3.10+ and `pip install langgraph langchain-core` to run it.",
    "CI installs the runtime, so the real path is exercised there.",
  ])
  process.exit(0)
}

// 1. The e2e driver must be present.
if (!existsSync(E2E)) skip(`e2e driver not found at ${E2E}`)

// 2. Python + LangGraph + LangChain must be importable.
const probe = spawnSync(PYTHON, ["-c", "import langgraph, langchain_core"], { stdio: "ignore" })
if (probe.error !== undefined || probe.status !== 0) {
  skip(
    probe.error !== undefined
      ? `${PYTHON} not available`
      : "langgraph / langchain_core not importable",
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
    "real LangGraph tool calls were governed end-to-end through the hook + sidecar",
  ])
  process.exit(0)
}
banner("FAIL ✗", [`the LangGraph e2e driver exited ${run.status}`])
process.exit(1)
