import type { ResourceScope } from "@qmilab/lodestar-core"

/**
 * The world model is the agent's running picture of the environment.
 *
 * It is NOT the belief store. Beliefs are about world state; the world
 * model captures *current* observed state, which the planner consults
 * to decide what to do next.
 *
 * Key invariants:
 * - Every entry is scoped (global / org / user / project / repo / session).
 * - Every entry has a source observation_id, so its provenance is auditable.
 * - Versions are kept (last N) so a later contradiction can be diagnosed.
 * - Updates do not delete history; they append a new version.
 *
 * v0 ships an in-memory implementation; v0.2 adds Postgres.
 */

export interface WorldModel {
  set(input: WorldModelSetInput): Promise<WorldModelEntry>
  get(key: string, scope?: ResourceScope): Promise<WorldModelEntry | undefined>
  history(key: string, scope?: ResourceScope): Promise<WorldModelEntry[]>
  list(scope?: ResourceScope): Promise<WorldModelEntry[]>
}

export interface WorldModelSetInput {
  key: string
  value: unknown
  scope: ResourceScope
  source_observation_id: string
  confidence: number
  observed_at: string
}

export interface WorldModelEntry extends WorldModelSetInput {
  version: number
}

// -----------------------------------------------------------------------------
// In-memory implementation
// -----------------------------------------------------------------------------

function scopeKey(scope: ResourceScope): string {
  return `${scope.level}:${scope.identifier}`
}

function fullKey(scope: ResourceScope, key: string): string {
  return `${scopeKey(scope)}::${key}`
}

const HISTORY_LIMIT = 20

export class InMemoryWorldModel implements WorldModel {
  private entries = new Map<string, WorldModelEntry[]>()

  async set(input: WorldModelSetInput): Promise<WorldModelEntry> {
    if (input.confidence < 0 || input.confidence > 1) {
      throw new Error(`WorldModel: confidence ${input.confidence} out of [0, 1]`)
    }
    const k = fullKey(input.scope, input.key)
    const history = this.entries.get(k) ?? []
    const nextVersion = history.length === 0 ? 1 : history[history.length - 1]!.version + 1
    const entry: WorldModelEntry = { ...input, version: nextVersion }
    history.push(entry)
    // Cap history length
    while (history.length > HISTORY_LIMIT) history.shift()
    this.entries.set(k, history)
    return entry
  }

  async get(key: string, scope?: ResourceScope): Promise<WorldModelEntry | undefined> {
    if (scope) {
      const k = fullKey(scope, key)
      const history = this.entries.get(k)
      return history ? history[history.length - 1] : undefined
    }
    // No scope: search across all scopes, return the most recent match.
    let mostRecent: WorldModelEntry | undefined
    for (const history of this.entries.values()) {
      const last = history[history.length - 1]
      if (!last) continue
      if (last.key !== key) continue
      if (!mostRecent || last.observed_at > mostRecent.observed_at) {
        mostRecent = last
      }
    }
    return mostRecent
  }

  async history(key: string, scope?: ResourceScope): Promise<WorldModelEntry[]> {
    if (scope) {
      return this.entries.get(fullKey(scope, key)) ?? []
    }
    const collected: WorldModelEntry[] = []
    for (const history of this.entries.values()) {
      for (const entry of history) {
        if (entry.key === key) collected.push(entry)
      }
    }
    return collected.sort((a, b) => a.observed_at.localeCompare(b.observed_at))
  }

  async list(scope?: ResourceScope): Promise<WorldModelEntry[]> {
    const out: WorldModelEntry[] = []
    for (const [k, history] of this.entries.entries()) {
      const last = history[history.length - 1]
      if (!last) continue
      if (scope && !k.startsWith(`${scopeKey(scope)}::`)) continue
      out.push(last)
    }
    return out
  }
}
