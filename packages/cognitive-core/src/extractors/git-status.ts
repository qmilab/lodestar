import type { Claim } from "@qmilab/lodestar-core"
import type { ClaimExtractor, ExtractionInput } from "./base.js"

/**
 * Schema-bound extractor for git.status@1 observations.
 *
 * Produces three claims from a single git.status observation:
 * 1. Branch identity ("current branch is X")
 * 2. Working tree state ("N files are dirty" or "working tree is clean")
 * 3. Sync state ("branch is N ahead, M behind origin")
 *
 * These are emitted as separate claims rather than one composite claim
 * because they have different lifecycles: branch identity changes only
 * on checkout, dirty count changes on every edit, sync state changes
 * on push/pull.
 */
export const GitStatusExtractor: ClaimExtractor = {
  schema_key: "git.status@1",
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = obs.payload as {
      branch: string
      dirty: string[]
      ahead: number
      behind: number
      detached: boolean
    }

    const now = new Date().toISOString()
    const ctx = input.context
    const claims: Claim[] = []

    // Branch identity
    if (!payload.detached) {
      claims.push({
        id: crypto.randomUUID(),
        statement: `Current branch is '${payload.branch}'`,
        structured_predicate: {
          subject: "current_branch",
          relation: "is",
          object: payload.branch,
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      })
    } else {
      claims.push({
        id: crypto.randomUUID(),
        statement: "Repository HEAD is detached",
        structured_predicate: {
          subject: "head_state",
          relation: "is",
          object: "detached",
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      })
    }

    // Working tree state
    claims.push({
      id: crypto.randomUUID(),
      statement:
        payload.dirty.length === 0
          ? "Working tree is clean"
          : `Working tree has ${payload.dirty.length} dirty file(s): ${payload.dirty.slice(0, 5).join(", ")}${payload.dirty.length > 5 ? ", …" : ""}`,
      structured_predicate: {
        subject: "working_tree_dirty_count",
        relation: "equals",
        object: payload.dirty.length,
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })

    // Sync state
    if (!payload.detached) {
      claims.push({
        id: crypto.randomUUID(),
        statement: `Branch '${payload.branch}' is ${payload.ahead} ahead and ${payload.behind} behind origin`,
        structured_predicate: {
          subject: "branch_sync_state",
          relation: "equals",
          object: { ahead: payload.ahead, behind: payload.behind },
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      })
    }

    return claims
  },
}
