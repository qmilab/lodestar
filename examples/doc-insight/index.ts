/**
 * Doc Insight — a tiny Lodestar demo.
 *
 * Reads a markdown file, extracts two kinds of claims:
 *
 *   1. Structural claims (heading count, code block count, link count)
 *      — these come from deterministic parsing of the document, so the
 *      evidence is `tool_result` quality and the firewall promotes them
 *      to `truth_status: supported`.
 *
 *   2. Semantic claims ("this doc is about X", "this doc has Y kind of
 *      instructions") — these would normally come from an LLM. To keep
 *      this demo offline and reproducible, we use a deterministic
 *      pattern-matcher that *acts like* an LLM extractor. The evidence
 *      is tagged `model_inference` quality, and the firewall's
 *      auto_observation gate refuses to promote them to `supported` —
 *      they stay at `truth_status: unverified` until reflection or a
 *      user blesses them.
 *
 * The end result: a trace report showing what the demo agent observed,
 * which claims became beliefs at what status, and why the firewall
 * blocked some promotions.
 *
 * Usage:
 *   bun run examples/doc-insight/index.ts examples/doc-insight/sample.md
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ExplanationGenerator, InMemoryWorldModel } from "@qmilab/lodestar-cognitive-core"
import type {
  Belief,
  Claim,
  Explanation,
  Observation,
  ResourceScope,
  Sensitivity,
} from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import type { EvidenceItem, EvidenceSet } from "@qmilab/lodestar-core"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { z } from "zod"

// -----------------------------------------------------------------------------
// Register the doc.parse@1 schema
// -----------------------------------------------------------------------------

const DOC_SCHEMA_KEY = "doc.parse@1"
if (!registry.has(DOC_SCHEMA_KEY)) {
  registry.register(
    DOC_SCHEMA_KEY,
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      content: z.string(),
      heading_count: z.number().int().nonnegative(),
      code_block_count: z.number().int().nonnegative(),
      link_count: z.number().int().nonnegative(),
      word_count: z.number().int().nonnegative(),
    }),
  )
}

// -----------------------------------------------------------------------------
// Structural extractor — produces tool_result quality claims
// -----------------------------------------------------------------------------

interface ParsedDoc {
  path: string
  bytes: number
  content: string
  heading_count: number
  code_block_count: number
  link_count: number
  word_count: number
}

function parseMarkdown(path: string, content: string): ParsedDoc {
  const headings = (content.match(/^#+ /gm) ?? []).length
  const codeBlocks = (content.match(/^```/gm) ?? []).length / 2
  const links = (content.match(/\[[^\]]+\]\([^\)]+\)/g) ?? []).length
  const words = content.split(/\s+/).filter((w) => w.length > 0).length
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    content,
    heading_count: headings,
    code_block_count: Math.floor(codeBlocks),
    link_count: links,
    word_count: words,
  }
}

function extractStructuralClaims(
  obs: Observation,
  payload: ParsedDoc,
  ctx: ExtractionContext,
): Claim[] {
  const now = new Date().toISOString()
  return [
    {
      id: randomUUID(),
      statement: `Document '${payload.path}' has ${payload.heading_count} heading(s)`,
      structured_predicate: {
        subject: `doc:${payload.path}`,
        relation: "heading_count",
        object: payload.heading_count,
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    },
    {
      id: randomUUID(),
      statement: `Document '${payload.path}' has ${payload.code_block_count} code block(s)`,
      structured_predicate: {
        subject: `doc:${payload.path}`,
        relation: "code_block_count",
        object: payload.code_block_count,
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    },
    {
      id: randomUUID(),
      statement: `Document '${payload.path}' has ${payload.word_count} words`,
      structured_predicate: {
        subject: `doc:${payload.path}`,
        relation: "word_count",
        object: payload.word_count,
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    },
  ]
}

// -----------------------------------------------------------------------------
// Semantic extractor — simulates an LLM, produces model_inference claims
// -----------------------------------------------------------------------------

function extractSemanticClaims(
  obs: Observation,
  payload: ParsedDoc,
  ctx: ExtractionContext,
): Claim[] {
  const now = new Date().toISOString()
  const claims: Claim[] = []
  const lower = payload.content.toLowerCase()

  // Topic detection: very rough pattern matching that stands in for an
  // LLM judgment. In a real demo this would be a Claude API call.
  let topic: string | null = null
  if (/release notes|changelog|merged pull requests/i.test(payload.content)) {
    topic = "release-management"
  } else if (/install|setup|getting started/i.test(payload.content)) {
    topic = "installation-guide"
  } else if (/api|endpoint|request|response/i.test(payload.content)) {
    topic = "api-reference"
  }

  if (topic) {
    claims.push({
      id: randomUUID(),
      statement: `Document '${payload.path}' is about '${topic}'`,
      structured_predicate: {
        subject: `doc:${payload.path}`,
        relation: "topic",
        object: topic,
      },
      source_observation_ids: [obs.id],
      extraction_method: "llm",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })
  }

  // Instruction detection: again, pretending to be an LLM.
  if (/recommend|best practice|should/i.test(lower)) {
    claims.push({
      id: randomUUID(),
      statement: `Document '${payload.path}' contains author recommendations`,
      structured_predicate: {
        subject: `doc:${payload.path}`,
        relation: "contains",
        object: "recommendations",
      },
      source_observation_ids: [obs.id],
      extraction_method: "llm",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })
  }

  return claims
}

// -----------------------------------------------------------------------------
// Evidence linker that distinguishes tool_result vs model_inference
// -----------------------------------------------------------------------------

function buildEvidence(claim: Claim, obs: Observation, assessorId: string): EvidenceSet {
  // The claim's extraction_method tells us which evidence quality to use.
  // "tool" extraction → tool_result evidence (deterministic parsing)
  // "llm" extraction → model_inference evidence (pattern-matched standin)
  const quality: EvidenceItem["quality"] =
    claim.extraction_method === "tool" ? "tool_result" : "model_inference"

  return {
    id: randomUUID(),
    claim_id: claim.id,
    items: [
      {
        source_id: obs.id,
        relation: "supports",
        quality,
        independence_group: `doc:${obs.source.tool}`,
        freshness: "fresh",
        notes: `from ${quality === "tool_result" ? "deterministic parser" : "simulated LLM extractor"}`,
      },
    ],
    assessed_by: assessorId,
    assessed_at: new Date().toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Auto_observation decision (mirrors cognitive-core logic)
// -----------------------------------------------------------------------------

function decideTransitionAuthority(evidence: EvidenceSet): "auto_observation" | "reflection" {
  // External_document and model_inference cannot auto-promote. Other
  // qualities can.
  const blocking = evidence.items.find(
    (i: EvidenceItem) =>
      i.relation === "supports" &&
      (i.quality === "external_document" || i.quality === "model_inference"),
  )
  return blocking ? "reflection" : "auto_observation"
}

function decideTruthStatus(
  authority: "auto_observation" | "reflection",
): "supported" | "unverified" {
  return authority === "auto_observation" ? "supported" : "unverified"
}

// -----------------------------------------------------------------------------
// Trace report rendering
// -----------------------------------------------------------------------------

interface ExtractionContext {
  actor_id: string
  default_scope: ResourceScope
  default_sensitivity: Sensitivity
}

function renderReport(
  doc: ParsedDoc,
  claims: Claim[],
  beliefs: Belief[],
  blockedClaims: Claim[],
): string {
  const lines: string[] = []
  lines.push("# Lodestar trust report — Doc Insight")
  lines.push("")
  lines.push(`**Document**: \`${doc.path}\``)
  lines.push(
    `**Observed**: ${doc.heading_count} heading(s), ${doc.code_block_count} code block(s), ` +
      `${doc.link_count} link(s), ${doc.word_count} words, ${doc.bytes} bytes`,
  )
  lines.push("")
  lines.push("## Claims extracted")
  lines.push("")
  for (const c of claims) {
    const method = c.extraction_method === "tool" ? "structural" : "semantic"
    lines.push(`- (${method}) ${c.statement}`)
  }
  lines.push("")

  lines.push("## Beliefs adopted")
  lines.push("")
  if (beliefs.length === 0) {
    lines.push("_No beliefs were adopted._")
  } else {
    for (const b of beliefs) {
      const matching = claims.find((c) => c.id === b.claim_id)
      lines.push(
        `- **[${b.truth_status}]** ${matching?.statement ?? b.claim_id} ` +
          `(confidence ${b.confidence.toFixed(2)})`,
      )
    }
  }
  lines.push("")

  if (blockedClaims.length > 0) {
    lines.push("## Why some claims did not auto-promote")
    lines.push("")
    lines.push(
      "These claims came from a simulated LLM extractor. The evidence is " +
        "`model_inference` quality, which the Memory Firewall's auto_observation " +
        "gate refuses to silently promote to `truth_status: supported`. They " +
        "remain at `unverified` until a reflection pass or a user explicitly " +
        "promotes them.",
    )
    lines.push("")
    for (const c of blockedClaims) {
      lines.push(`- ${c.statement} → stayed at \`truth_status: unverified\``)
    }
    lines.push("")
  }

  lines.push("## Why this matters")
  lines.push("")
  lines.push(
    "Structural claims are produced by deterministic tools and are safe to " +
      "promote: the parser produced the same output for the same input, and " +
      "evidence quality is `tool_result`. Semantic claims are model-judged: " +
      "the same document with adversarial framing could yield a different " +
      "judgment, so the firewall keeps them at `unverified` until something " +
      "stronger confirms them. This is the difference between *what the doc " +
      "objectively contains* and *what the agent thinks the doc means*.",
  )
  lines.push("")

  return lines.join("\n")
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const argPath = process.argv[2]
  if (!argPath) {
    console.error("usage: bun run examples/doc-insight/index.ts <markdown-file>")
    process.exit(2)
  }
  const fullPath = resolve(process.cwd(), argPath)
  const content = readFileSync(fullPath, "utf8")
  const parsed = parseMarkdown(argPath, content)

  // Build the observation directly (this demo doesn't go through the
  // Action Kernel — it's a focused illustration of the cognitive core
  // and memory firewall path).
  const observation: Observation = {
    id: randomUUID(),
    schema: DOC_SCHEMA_KEY,
    payload: parsed,
    source: {
      tool: "doc.parse",
      invocation_id: randomUUID(),
      captured_at: new Date().toISOString(),
    },
    context: {
      session_id: `doc-insight-${Date.now()}`,
      project_id: "doc-insight-demo",
      actor_id: "doc-insight-agent",
    },
    trust: "validated",
    sensitivity: "internal",
  }

  // Wire up stores and firewall
  const claimStore = new InMemoryClaimStore()
  const beliefStore = new InMemoryBeliefStore()
  const evidenceStore = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claimStore, beliefStore, evidenceStore, async () => {})
  const worldModel = new InMemoryWorldModel()
  const explanations = new ExplanationGenerator("doc-insight-agent")
  void worldModel

  const ctx: ExtractionContext = {
    actor_id: "doc-insight-agent",
    default_scope: { level: "project", identifier: "doc-insight-demo" },
    default_sensitivity: "internal",
  }

  // Extract both kinds of claims
  const structuralClaims = extractStructuralClaims(observation, parsed, ctx)
  const semanticClaims = extractSemanticClaims(observation, parsed, ctx)
  const allClaims = [...structuralClaims, ...semanticClaims]

  // Submit each claim and attempt adoption
  const adopted: Belief[] = []
  const blocked: Claim[] = []

  for (const claim of allClaims) {
    await firewall.acceptClaim(claim)
    const evidence = buildEvidence(claim, observation, ctx.actor_id)
    await evidenceStore.put(evidence)

    const authority = decideTransitionAuthority(evidence)
    const truth = decideTruthStatus(authority)
    const confidence = authority === "auto_observation" ? 0.9 : 0.4

    const explanation: Explanation = explanations.forBeliefAdoption({
      belief_id: "pending",
      claim_id: claim.id,
      evidence_id: evidence.id,
      confidence,
      rationale_text: `Adopted from doc.parse observation under transition authority '${authority}'.`,
    })

    try {
      const belief = await firewall.adoptBelief({
        candidate: {
          claim_id: claim.id,
          confidence,
          calibration_class: `doc.parse::${claim.structured_predicate?.relation ?? "unknown"}`,
          scope: ctx.default_scope,
          sensitivity: ctx.default_sensitivity,
          authority: "observed",
          truth_status: truth,
          retrieval_status: "restricted",
          security_status: "clean",
          freshness_status: "fresh",
          observed_at: observation.source.captured_at,
        },
        evidence_id: evidence.id,
        by_authority: authority,
        rationale: explanation,
      })
      adopted.push(belief)
      // Track which semantic claims got the "stayed unverified" treatment
      if (truth === "unverified") {
        blocked.push(claim)
      }
    } catch (err) {
      // Adoption rejected — record but continue
      blocked.push(claim)
      void err
    }
  }

  const report = renderReport(parsed, allClaims, adopted, blocked)
  console.log(report)
}

void main()
