#!/usr/bin/env bun
/**
 * Probe: documentation_evidence_provenance
 *
 * Locks the invariant the documentation-agent proving ground rests on:
 * a claim extracted from the *contents* of a documentation file is
 * `external_document` evidence, stamped with the source file it came
 * from, and the belief it backs stays at `truth_status: unverified`.
 *
 * The probe runs the SAME documentation observation through `guard.wrap()`
 * twice:
 *
 *   1. WITH the `cognitive.evidenceLinkerFactory` seam wired to
 *      `DocAwareEvidenceLinker`.
 *   2. WITHOUT it (the default `EvidenceLinker`).
 *
 * The contrast is the point. The default linker tags the observation
 * `direct_observation`, which clears the Round 5 auto-observation gate and
 * the content belief adopts at `supported`. The doc-aware linker tags it
 * `external_document`, the gate fires, and the same content belief stays
 * `unverified` — and carries its source file. If the seam ever stops being
 * honoured, the "with seam" run would also land at `supported` and this
 * probe fails.
 *
 * Assertions (WITH seam):
 *   1. A semantic content claim is extracted — the `renderWidget`
 *      signature, not an "exists with size N" envelope.
 *   2. Its evidence item is `quality: external_document`, with a
 *      source-identifying `independence_group` (`doc:<path>`), `notes`
 *      naming the file, and `source_id` equal to the observation id.
 *   3. The belief backing that claim is `truth_status: unverified`.
 *   4. No belief in the store adopts at `truth_status: supported`.
 *
 * Assertion (WITHOUT seam — control):
 *   5. The same content belief adopts at `truth_status: supported`,
 *      proving it is the seam, not the extractor, that keeps it unverified.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, EvidenceItem, Observation } from "@qmilab/lodestar-core"
import {
  DOCUMENTATION_SOURCE_SCHEMA_KEY,
  DocAwareEvidenceLinker,
  DocumentationExtractor,
  type IngestResult,
  alwaysHoldsChecker,
  autoApprovePolicy,
  lookupExtractor,
  registerExtractor,
  wrap,
} from "@qmilab/lodestar-guard"

interface ProbeResult {
  passed: boolean
  details: string
}

const FIXTURE_PATH = "fixture/widget.ts"
const FIXTURE_SRC =
  "export function renderWidget(props: WidgetProps, options?: RenderOptions): string {\n" +
  "  return `<div>${props.title}</div>`\n" +
  "}\n"

function ensureDocumentationExtractor(): void {
  if (
    lookupExtractor(DOCUMENTATION_SOURCE_SCHEMA_KEY)?.schema_key !== DOCUMENTATION_SOURCE_SCHEMA_KEY
  ) {
    registerExtractor(DocumentationExtractor)
  }
}

interface ScenarioResult {
  obsId: string
  ingest: IngestResult
  evidenceFor: (claimId: string) => Promise<EvidenceItem[]>
  allBeliefs: () => Promise<Belief[]>
}

async function runScenario(useSeam: boolean, logRoot: string): Promise<ScenarioResult> {
  const obsId = crypto.randomUUID()
  const observation: Observation = {
    id: obsId,
    schema: DOCUMENTATION_SOURCE_SCHEMA_KEY,
    payload: {
      path: FIXTURE_PATH,
      kind: "source",
      contents: FIXTURE_SRC,
      bytes: FIXTURE_SRC.length,
      truncated: false,
    },
    source: {
      tool: "doc.read",
      invocation_id: crypto.randomUUID(),
      captured_at: new Date().toISOString(),
    },
    // Rewritten by guard to the real session/project; placeholders here.
    context: { session_id: "pre", project_id: "pre", actor_id: "pre" },
    // NOT synthetic — a synthetic observation would be weighted out and no
    // real belief would adopt. We want the external_document path.
    trust: "validated",
    sensitivity: "internal",
  }

  const run = wrap<IngestResult>(async (ctx) => ctx.ingestObservation(observation))
  const { result, internals } = await run({
    project_id: "doc-probe",
    actor_id: "doc-probe-agent",
    log_root: logRoot,
    default_scope: { level: "project", identifier: "doc-probe" },
    default_sensitivity: "internal",
    policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "doc-probe-policy" }),
    precondition_checker: alwaysHoldsChecker,
    cognitive: useSeam
      ? {
          evidenceLinkerFactory: ({ evidence, beliefs }) =>
            new DocAwareEvidenceLinker(evidence, beliefs),
        }
      : undefined,
  })

  return {
    obsId,
    ingest: result,
    evidenceFor: async (claimId) => {
      const sets = await internals.evidence.forClaim(claimId)
      return sets.flatMap((s) => s.items)
    },
    allBeliefs: () => internals.beliefs.list(),
  }
}

async function run(): Promise<ProbeResult> {
  ensureDocumentationExtractor()
  const logRoot = mkdtempSync(join(tmpdir(), "lodestar-doc-probe-"))

  try {
    const withSeam = await runScenario(true, logRoot)
    const withoutSeam = await runScenario(false, logRoot)

    // Assertion 1: a semantic signature claim, not an envelope claim.
    const sigClaim = withSeam.ingest.claims.find(
      (c) => c.structured_predicate?.relation === "has_signature",
    )
    if (!sigClaim) {
      return {
        passed: false,
        details: "no `has_signature` claim extracted from the source observation",
      }
    }
    if (!/renderWidget/.test(sigClaim.statement) || !/props/.test(sigClaim.statement)) {
      return {
        passed: false,
        details: `signature claim is not the expected semantic content claim: "${sigClaim.statement}"`,
      }
    }
    if (/exists with size/i.test(sigClaim.statement)) {
      return {
        passed: false,
        details: "extractor produced an fs.read-style envelope claim, not content",
      }
    }

    // Assertion 2: external_document evidence stamped with the source file.
    const items = await withSeam.evidenceFor(sigClaim.id)
    const docItem = items.find((i) => i.relation === "supports")
    if (!docItem) {
      return {
        passed: false,
        details: `no supporting evidence item for claim ${sigClaim.id.slice(0, 8)}`,
      }
    }
    if (docItem.quality !== "external_document") {
      return {
        passed: false,
        details: `evidence quality is '${docItem.quality}', expected 'external_document'. The doc-aware linker seam was not honoured.`,
      }
    }
    if (docItem.source_id !== withSeam.obsId) {
      return {
        passed: false,
        details: `evidence source_id '${docItem.source_id}' does not point back to the observation '${withSeam.obsId}'`,
      }
    }
    if (
      !docItem.independence_group?.startsWith("doc:") ||
      !docItem.independence_group.includes(FIXTURE_PATH)
    ) {
      return {
        passed: false,
        details: `evidence independence_group '${docItem.independence_group}' does not identify the source file`,
      }
    }
    if (!docItem.notes?.includes(FIXTURE_PATH)) {
      return {
        passed: false,
        details: `evidence notes '${docItem.notes}' do not name the source file`,
      }
    }

    // Assertion 3: the backing belief stays unverified.
    const sigBelief = withSeam.ingest.beliefs.find((b) => b.claim_id === sigClaim.id)
    if (!sigBelief) {
      return { passed: false, details: "no belief adopted for the signature claim" }
    }
    if (sigBelief.truth_status !== "unverified") {
      return {
        passed: false,
        details: `signature belief adopted at truth_status='${sigBelief.truth_status}', expected 'unverified' (the gate must fire on external_document).`,
      }
    }

    // Assertion 4: nothing in the store reached `supported`.
    const seamBeliefs = await withSeam.allBeliefs()
    const supported = seamBeliefs.filter((b) => b.truth_status === "supported")
    if (supported.length > 0) {
      return {
        passed: false,
        details: `${supported.length} belief(s) adopted at 'supported' under the doc-aware linker; external_document content must not auto-promote.`,
      }
    }

    // Assertion 5 (control): without the seam, the SAME claim adopts at
    // 'supported' — proving the seam is what kept it unverified.
    const controlSig = withoutSeam.ingest.claims.find(
      (c) => c.structured_predicate?.relation === "has_signature",
    )
    const controlBelief = controlSig
      ? withoutSeam.ingest.beliefs.find((b) => b.claim_id === controlSig.id)
      : undefined
    if (!controlBelief) {
      return {
        passed: false,
        details: "control run did not adopt a belief for the signature claim",
      }
    }
    if (controlBelief.truth_status !== "supported") {
      return {
        passed: false,
        details: `control (no seam) adopted the signature belief at '${controlBelief.truth_status}', expected 'supported'. If the default linker no longer promotes here, the contrast this probe relies on is gone — investigate.`,
      }
    }

    return {
      passed: true,
      details: `Content claim "${sigClaim.statement}"\n  WITH seam:    evidence quality '${docItem.quality}', source '${docItem.independence_group}', belief truth_status '${sigBelief.truth_status}'.\n  WITHOUT seam: belief truth_status '${controlBelief.truth_status}'.\nThe DocAwareEvidenceLinker seam attributes the claim to its source file and keeps the belief unverified; the default linker would have promoted the same content to supported.`,
    }
  } finally {
    rmSync(logRoot, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: documentation_evidence_provenance")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
