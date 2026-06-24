import type { EvidenceItem, EvidenceSet, Observation } from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import { EvidenceLinker, type LinkForClaimInput } from "./evidence-linker.js"

/** An observation is "documentation" if its schema is in this namespace. */
function isDocumentationObservation(obs: Observation): boolean {
  return obs.schema.startsWith("documentation.")
}

function documentPath(obs: Observation): string | undefined {
  const payload = obs.payload as { path?: unknown }
  return typeof payload?.path === "string" ? payload.path : undefined
}

/**
 * Evidence linker that treats the *contents* of a documentation file as
 * `external_document` evidence — the same stance the MCP proxy takes for
 * file/web content surfaced through a tool result.
 *
 * Two things follow from that quality downgrade:
 *
 *  1. The Round 5 auto-observation gate in {@link CognitiveCore} keeps the
 *     resulting belief at `truth_status: unverified`. A documentation
 *     agent's claims ("this function takes parameter X") are recorded
 *     honestly as *read, not independently verified* — exactly what a
 *     reviewer needs to know before trusting an auto-generated docstring.
 *  2. Each evidence item is stamped with the **source file** it came from
 *     (`independence_group: "doc:<path>"`, `notes: "from <path>"`,
 *     `source_id: <observation id>`), so `lodestar report` shows which
 *     source backed each documentation claim.
 *
 * Non-documentation claims (e.g. a `git.status` observation that happens
 * to share a session with this linker) fall through to the base
 * {@link EvidenceLinker} behaviour unchanged.
 *
 * This linker is the reference consumer of the `evidenceLinkerFactory`
 * seam on `guard.wrap()`: inject it and any documentation observation
 * gains source-attributed, gate-respecting evidence.
 */
export class DocAwareEvidenceLinker extends EvidenceLinker {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    beliefs: BeliefStore,
    claims: ClaimStore,
  ) {
    super(evidenceStore, beliefs, claims)
  }

  override async linkForClaim(input: LinkForClaimInput): Promise<EvidenceSet> {
    // No documentation observation in the source set → defer to the base
    // linker so mixed-source sessions keep working.
    if (!input.source_observations.some(isDocumentationObservation)) {
      return super.linkForClaim(input)
    }

    // Re-implement the body here (rather than calling super and patching
    // the persisted set) because EvidenceStore.put is a strict insert and
    // would throw on a second write — the same reason MCPAwareEvidenceLinker
    // re-implements it.
    const items: EvidenceItem[] = input.source_observations.map((obs) => {
      const isDoc = isDocumentationObservation(obs)
      const path = isDoc ? documentPath(obs) : undefined
      const quality: EvidenceItem["quality"] =
        obs.trust === "synthetic"
          ? "synthetic_probe"
          : isDoc
            ? "external_document"
            : "direct_observation"
      return {
        source_id: obs.id,
        relation: "supports",
        quality,
        independence_group: isDoc && path ? `doc:${path}` : `obs:${obs.source.tool}`,
        freshness: "fresh",
        notes: isDoc && path ? `from ${path}` : `from ${obs.schema}`,
      }
    })

    // Same cross-belief join the base linker runs (#157): corroboration /
    // contradiction from prior beliefs sharing this claim's (subject, relation).
    items.push(...(await this.crossBeliefItems(input.claim)))

    const evidenceSet: EvidenceSet = {
      id: crypto.randomUUID(),
      claim_id: input.claim.id,
      items,
      assessed_by: input.assessor_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidenceStore.put(evidenceSet)
    return evidenceSet
  }
}
