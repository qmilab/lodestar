/**
 * Documentation-agent example — Lodestar's second (low-cost) proving
 * ground.
 *
 * A small agent reads the project's own `README.md`, `package.json`, and a
 * sample source module, extracts *content* claims from what it read
 * ("renderWidget takes (props, options)", "package depends on X"), and
 * rewrites a stale docstring to match the code. Every claim is linked to
 * the source file it came from, recorded as `external_document` evidence —
 * so the Round 5 gate keeps the backing beliefs at `truth_status:
 * unverified`, and `lodestar report` shows which source supported each
 * documentation claim.
 *
 *   bun run examples/documentation-agent/index.ts
 *
 * It mutates only its own `workspace/widget.ts` (a gitignored working copy
 * reset from `widget.template.ts` on each run), through a governed
 * `doc.write` action — never the real repo.
 *
 * This wires up the headline `guard.wrap()` API and plugs a custom
 * `DocAwareEvidenceLinker` in through the `cognitive.evidenceLinkerFactory`
 * seam — the same seam any product can use to attach document-aware,
 * MCP-aware, or LLM-driven evidence linking.
 */

import { randomUUID } from "node:crypto"
import { copyFile } from "node:fs/promises"
import { resolve } from "node:path"
import { registerDocReadTool } from "@qmilab/lodestar-adapter-filesystem"
import {
  type Claim,
  DOCUMENTATION_SOURCE_SCHEMA_KEY,
  DocAwareEvidenceLinker,
  DocumentationExtractor,
  type DocumentationSourcePayload,
  type GuardContext,
  alwaysHoldsChecker,
  autoApprovePolicy,
  lookupExtractor,
  registerExtractor,
  wrap,
} from "@qmilab/lodestar-guard"
import {
  defaultLogRoot,
  loadSessionEvents,
  projectChain,
  renderReport,
} from "@qmilab/lodestar-trace"
import { registerDocWriteTool } from "./doc-write.js"

const PROJECT_ROOT = import.meta.dir
const WORKSPACE = resolve(PROJECT_ROOT, "workspace")
const PROJECT_ID = "documentation-agent"
const ACTOR_ID = "doc-agent"

interface DocWriteOutput {
  path: string
  bytes_written: number
}

interface DocAgentResult {
  read_paths: string[]
  updated: boolean
  decision_id?: string
  bytes_written?: number
  summary: string
}

// Fixture setup (not a governed action): reset the working copy to the
// stale template so the demo is repeatable and never dirties a tracked
// file. The agent's *own* write below goes through the kernel.
await copyFile(resolve(WORKSPACE, "widget.template.ts"), resolve(WORKSPACE, "widget.ts"))

// Register the tools the agent may call. `doc.read` is rooted at the
// example dir (it reads README.md, package.json, workspace/widget.ts);
// `doc.write` is hard-scoped to `workspace/` only.
registerDocReadTool(PROJECT_ROOT)
registerDocWriteTool(WORKSPACE)

// Opt the DocumentationExtractor into the cognitive-core registry (it is
// not a built-in). Guard against a duplicate registration if this module
// is imported more than once in a process.
if (
  lookupExtractor(DOCUMENTATION_SOURCE_SCHEMA_KEY)?.schema_key !== DOCUMENTATION_SOURCE_SCHEMA_KEY
) {
  registerExtractor(DocumentationExtractor)
}

const SIGNATURE_SUBJECT = "function:renderWidget"

async function agentLoop(ctx: GuardContext): Promise<DocAgentResult> {
  const sources = ["README.md", "package.json", "workspace/widget.ts"]
  const readPaths: string[] = []

  let signatureClaim: Claim | undefined
  let signatureBeliefId: string | undefined
  let signatureParams: string[] = []
  let widgetSource = ""

  // Step 1: read each source. Every read flows through the action kernel
  // and the cognitive core; the DocAwareEvidenceLinker tags the content
  // claims as external_document and stamps each with its source file.
  for (const path of sources) {
    const { output, ingest } = await ctx.callTool<DocumentationSourcePayload>(
      "doc.read",
      { path },
      { intent: `read ${path} for documentation claims` },
    )
    readPaths.push(path)

    if (path === "workspace/widget.ts") {
      widgetSource = output.contents
      signatureClaim = ingest.claims.find(
        (c) =>
          c.structured_predicate?.relation === "has_signature" &&
          c.structured_predicate?.subject === SIGNATURE_SUBJECT,
      )
      if (signatureClaim) {
        const obj = signatureClaim.structured_predicate?.object
        signatureParams = Array.isArray(obj) ? (obj as string[]) : []
        signatureBeliefId = ingest.beliefs.find((b) => b.claim_id === signatureClaim?.id)?.id
      }
    }
  }

  if (!signatureClaim || !signatureBeliefId) {
    await ctx.emit("agent.note", {
      kind: "no-signature-claim",
      detail: "could not extract renderWidget's signature from workspace/widget.ts",
    })
    return {
      read_paths: readPaths,
      updated: false,
      summary: "No signature claim extracted; nothing to update.",
    }
  }

  // Step 2: decide whether the docstring is stale — i.e. whether it
  // documents every parameter the observed signature declares.
  const currentDoc = currentDocstring(widgetSource) ?? ""
  const missing = signatureParams.filter((p) => !new RegExp(`@param\\s+${p}\\b`).test(currentDoc))
  const stale = missing.length > 0

  const decision_id = randomUUID()
  await ctx.emit("decision.made", {
    id: decision_id,
    project_id: ctx.project_id,
    session_id: ctx.session_id,
    intent: "bring renderWidget's docstring in line with its observed signature",
    chosen_option: {
      label: stale ? "rewrite-docstring" : "leave-as-is",
      rationale: stale
        ? `Docstring omits @param for ${missing.join(", ")}; observed signature is (${signatureParams.join(", ")}). ` +
          `Grounded in belief ${signatureBeliefId.slice(0, 8)} (unverified; source workspace/widget.ts).`
        : `Docstring already documents (${signatureParams.join(", ")}).`,
    },
    // The decision cites the belief it leaned on. Because that belief is
    // external_document/unverified, a reviewer can see the docstring rests
    // on read-not-verified evidence — and trace it to its source file.
    belief_dependencies: [signatureBeliefId],
    decided_by: ctx.actor_id,
    decided_at: new Date().toISOString(),
  })

  if (!stale) {
    return {
      read_paths: readPaths,
      updated: false,
      decision_id,
      summary: "Docstring already matches the observed signature; no write needed.",
    }
  }

  // Step 3: perform the correction as a governed write action.
  const updatedSource = rewriteDocstring(widgetSource, signatureParams, signatureBeliefId)
  const { output: writeOut } = await ctx.callTool<DocWriteOutput>(
    "doc.write",
    { path: "widget.ts", contents: updatedSource },
    { intent: "rewrite renderWidget docstring to match observed signature", decision_id },
  )

  return {
    read_paths: readPaths,
    updated: true,
    decision_id,
    bytes_written: writeOut.bytes_written,
    summary: `Rewrote workspace/widget.ts docstring (${writeOut.bytes_written} bytes) to document (${signatureParams.join(", ")}).`,
  }
}

/** Extract the JSDoc block immediately preceding `renderWidget`. */
function currentDocstring(source: string): string | undefined {
  const match = source.match(/(\/\*\*[\s\S]*?\*\/)\s*(?=export function renderWidget\b)/)
  return match?.[1]
}

/** Build a docstring documenting exactly the observed parameters. */
function buildDocstring(params: string[], beliefId: string): string {
  const lines = ["/**", " * Render a widget.", " *"]
  for (const p of params) lines.push(` * @param ${p} - documented from the observed signature`)
  lines.push(" * @returns the rendered widget as an HTML string")
  lines.push(" *")
  lines.push(" * Regenerated by the Lodestar documentation agent from the observed")
  lines.push(
    ` * signature of \`renderWidget\`. Backing belief ${beliefId.slice(0, 8)} (truth_status: unverified; source: workspace/widget.ts).`,
  )
  lines.push(" */")
  return lines.join("\n")
}

/** Replace `renderWidget`'s docstring (or insert one) with a fresh block. */
function rewriteDocstring(source: string, params: string[], beliefId: string): string {
  const doc = buildDocstring(params, beliefId)
  const existing = /\/\*\*[\s\S]*?\*\/\s*(?=export function renderWidget\b)/
  if (existing.test(source)) return source.replace(existing, `${doc}\n`)
  return source.replace(/(?=export function renderWidget\b)/, `${doc}\n`)
}

// ── Run the guarded session ──────────────────────────────────────────────────

const run = wrap(agentLoop)
const LOG_ROOT = defaultLogRoot()

const { result, session_id } = await run({
  project_id: PROJECT_ID,
  actor_id: ACTOR_ID,
  log_root: LOG_ROOT,
  default_scope: { level: "project", identifier: PROJECT_ID },
  default_sensitivity: "internal",
  policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "doc-agent-policy" }),
  precondition_checker: alwaysHoldsChecker,
  // The seam: attach document-aware evidence linking for this session.
  cognitive: {
    evidenceLinkerFactory: ({ evidence, beliefs, claims }) =>
      new DocAwareEvidenceLinker(evidence, beliefs, claims),
  },
})

process.stdout.write(`\n[doc-agent] session ${session_id}\n`)
process.stdout.write(`[doc-agent] ${result.summary}\n\n`)

const { events } = await loadSessionEvents({
  logRoot: LOG_ROOT,
  session_id,
  project_id: PROJECT_ID,
})
const projection = projectChain(events, { session_id, project_id: PROJECT_ID })
process.stdout.write(
  `${renderReport(projection, { title: "Trust report — documentation agent" })}\n`,
)

process.stdout.write(
  `\n[doc-agent] event log: ${resolve(LOG_ROOT, PROJECT_ID)}\n` +
    `[doc-agent] re-render later with: lodestar report ${session_id}\n`,
)
