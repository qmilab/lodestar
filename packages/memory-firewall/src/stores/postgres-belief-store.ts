import { type Belief, BeliefSchema, type Sensitivity } from "@qmilab/lodestar-core"
import type { SQL } from "bun"
import type {
  BeliefAxisTransition,
  BeliefAxisTransitionInput,
  BeliefFilter,
  BeliefStore,
} from "./belief-store.js"
import { isUniqueViolation } from "./postgres-errors.js"

const SENSITIVITY_ORDER: Sensitivity[] = ["public", "internal", "confidential", "secret"]

/**
 * Postgres-backed BeliefStore (Bun's native `Bun.SQL`).
 *
 * Semantics mirror {@link InMemoryBeliefStore} exactly — same duplicate-`put`
 * rejection, same `from_value` mismatch error on `transition`, same
 * append-only transition history — so the probes that treat the in-memory
 * store as spec hold against this backend too. The difference is durability:
 * two `MCPProxy` sessions pointed at the same database see each other's
 * beliefs, which is what cross-session provenance checks require.
 *
 * Each belief is stored as its full Zod-validated object in `data jsonb`
 * (re-parsed through {@link BeliefSchema} on read) plus mirrored scalar columns
 * for the {@link BeliefFilter} dimensions. The mirrored columns and `data` are
 * always written together.
 */
export class PostgresBeliefStore implements BeliefStore {
  constructor(private readonly sql: SQL) {}

  async put(belief: Belief): Promise<void> {
    const parsed = BeliefSchema.parse(belief)
    try {
      await this.sql`
        insert into lodestar_beliefs
          (id, claim_id, scope_level, scope_identifier, authority, truth_status,
           retrieval_status, security_status, freshness_status, sensitivity,
           calibration_class, superseded_by, data)
        values
          (${parsed.id}, ${parsed.claim_id}, ${parsed.scope.level}, ${parsed.scope.identifier},
           ${parsed.authority}, ${parsed.truth_status}, ${parsed.retrieval_status},
           ${parsed.security_status}, ${parsed.freshness_status}, ${parsed.sensitivity},
           ${parsed.calibration_class}, ${parsed.superseded_by ?? null},
           ${JSON.stringify(parsed)}::jsonb)`
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(
          `BeliefStore: belief ${belief.id} already exists; use transition() for axis changes`,
        )
      }
      throw err
    }
  }

  async get(id: string): Promise<Belief | undefined> {
    const rows = (await this.sql`select data from lodestar_beliefs where id = ${id}`) as Array<{
      data: string
    }>
    const row = rows[0]
    if (!row) return undefined
    return parseBelief(row.data)
  }

  async list(filter?: BeliefFilter): Promise<Belief[]> {
    const conds: SQL.Query<unknown>[] = []
    if (filter?.claim_id !== undefined) conds.push(this.sql`claim_id = ${filter.claim_id}`)
    if (filter?.scope) {
      conds.push(this.sql`scope_level = ${filter.scope.level}`)
      conds.push(this.sql`scope_identifier = ${filter.scope.identifier}`)
    }
    if (filter?.authority) conds.push(this.inClause("authority", filter.authority))
    if (filter?.truth_status) conds.push(this.inClause("truth_status", filter.truth_status))
    if (filter?.retrieval_status)
      conds.push(this.inClause("retrieval_status", filter.retrieval_status))
    if (filter?.security_status)
      conds.push(this.inClause("security_status", filter.security_status))
    if (filter?.freshness_status)
      conds.push(this.inClause("freshness_status", filter.freshness_status))
    if (filter?.calibration_class !== undefined)
      conds.push(this.sql`calibration_class = ${filter.calibration_class}`)
    if (filter?.max_sensitivity) {
      const ceiling = SENSITIVITY_ORDER.indexOf(filter.max_sensitivity)
      const allowed = SENSITIVITY_ORDER.slice(0, ceiling + 1)
      conds.push(this.inClause("sensitivity", allowed))
    }

    let q = this.sql`select data from lodestar_beliefs`
    conds.forEach((c, i) => {
      q = i === 0 ? this.sql`${q} where ${c}` : this.sql`${q} and ${c}`
    })
    const rows = (await q) as Array<{ data: string }>
    return rows.map((r) => parseBelief(r.data))
  }

  async history(id: string): Promise<BeliefAxisTransition[]> {
    const rows = (await this.sql`
      select id, belief_id, axis, from_value, to_value, by_actor_id, rationale_id, at
      from lodestar_belief_transitions where belief_id = ${id} order by at asc`) as Array<{
      id: string
      belief_id: string
      axis: string
      from_value: string
      to_value: string
      by_actor_id: string
      rationale_id: string
      at: Date | string
    }>
    return rows.map((r) => ({
      id: r.id,
      belief_id: r.belief_id,
      axis: r.axis as BeliefAxisTransition["axis"],
      from_value: r.from_value,
      to_value: r.to_value,
      by_actor_id: r.by_actor_id,
      rationale_id: r.rationale_id,
      at: toIso(r.at),
    }))
  }

  async setSupersededBy(belief_id: string, successor_id: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const belief = await loadForUpdate(tx, belief_id)
      await writeBeliefRow(tx, { ...belief, superseded_by: successor_id })
    })
  }

  async transition(input: BeliefAxisTransitionInput): Promise<BeliefAxisTransition> {
    return this.sql.begin(async (tx) => {
      const belief = await loadForUpdate(tx, input.belief_id)
      const current = belief[input.axis]
      if (current !== input.from_value) {
        throw new Error(
          `BeliefStore: transition on axis ${input.axis} expected from=${input.from_value} but belief has ${current}`,
        )
      }
      const transition: BeliefAxisTransition = {
        id: crypto.randomUUID(),
        ...input,
        at: new Date().toISOString(),
      }
      await tx`
        insert into lodestar_belief_transitions
          (id, belief_id, axis, from_value, to_value, by_actor_id, rationale_id, at)
        values
          (${transition.id}, ${transition.belief_id}, ${transition.axis}, ${transition.from_value},
           ${transition.to_value}, ${transition.by_actor_id}, ${transition.rationale_id},
           ${transition.at})`
      await writeBeliefRow(tx, { ...belief, [input.axis]: input.to_value })
      return transition
    })
  }

  /**
   * Build an `<column> in (...)` fragment, or `false` for an empty set (which
   * matches nothing — parity with the in-memory store's `[].includes()`).
   * The column is selected through a closed switch so the identifier is never
   * interpolated from a variable; values are always bound as parameters.
   */
  private inClause(column: string, values: string[]): SQL.Query<unknown> {
    if (values.length === 0) return this.sql`false`
    switch (column) {
      case "authority":
        return this.sql`authority in ${this.sql(values)}`
      case "truth_status":
        return this.sql`truth_status in ${this.sql(values)}`
      case "retrieval_status":
        return this.sql`retrieval_status in ${this.sql(values)}`
      case "security_status":
        return this.sql`security_status in ${this.sql(values)}`
      case "freshness_status":
        return this.sql`freshness_status in ${this.sql(values)}`
      case "sensitivity":
        return this.sql`sensitivity in ${this.sql(values)}`
      default:
        // Unreachable: callers pass only the closed set of column literals above.
        throw new Error(`BeliefStore: unsupported filter column ${column}`)
    }
  }
}

function parseBelief(data: string): Belief {
  return BeliefSchema.parse(typeof data === "string" ? JSON.parse(data) : data)
}

function toIso(at: Date | string): string {
  return at instanceof Date ? at.toISOString() : new Date(at).toISOString()
}

/** Load a belief row inside a transaction with a row lock. Throws if absent. */
async function loadForUpdate(tx: SQL, belief_id: string): Promise<Belief> {
  const rows = (await tx`
    select data from lodestar_beliefs where id = ${belief_id} for update`) as Array<{
    data: string
  }>
  const row = rows[0]
  if (!row) throw new Error(`BeliefStore: belief ${belief_id} not found`)
  return parseBelief(row.data)
}

/** Rewrite all mirrored columns and `data` from a belief object, inside a tx. */
async function writeBeliefRow(tx: SQL, belief: Belief): Promise<void> {
  const parsed = BeliefSchema.parse(belief)
  await tx`
    update lodestar_beliefs set
      claim_id = ${parsed.claim_id},
      scope_level = ${parsed.scope.level},
      scope_identifier = ${parsed.scope.identifier},
      authority = ${parsed.authority},
      truth_status = ${parsed.truth_status},
      retrieval_status = ${parsed.retrieval_status},
      security_status = ${parsed.security_status},
      freshness_status = ${parsed.freshness_status},
      sensitivity = ${parsed.sensitivity},
      calibration_class = ${parsed.calibration_class},
      superseded_by = ${parsed.superseded_by ?? null},
      data = ${JSON.stringify(parsed)}::jsonb
    where id = ${parsed.id}`
}
