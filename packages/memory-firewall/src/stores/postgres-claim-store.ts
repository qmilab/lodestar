import { type Claim, ClaimSchema } from "@qmilab/lodestar-core"
import type { SQL } from "bun"
import type {
  ClaimFilter,
  ClaimStore,
  ClaimTransition,
  ClaimTransitionInput,
} from "./claim-store.js"

/**
 * Postgres-backed ClaimStore (Bun's native `Bun.SQL`).
 *
 * Append-only, like {@link InMemoryClaimStore}: claims are never overwritten;
 * status changes are recorded as transitions and mirrored onto the row. Same
 * duplicate-`put` rejection and `from_status` mismatch error so the in-memory
 * store stays the shared spec.
 */
export class PostgresClaimStore implements ClaimStore {
  constructor(private readonly sql: SQL) {}

  async put(claim: Claim): Promise<void> {
    const parsed = ClaimSchema.parse(claim)
    try {
      await this.sql`
        insert into lodestar_claims
          (id, status, scope_level, scope_identifier, extracted_by, created_at, data)
        values
          (${parsed.id}, ${parsed.status}, ${parsed.scope.level}, ${parsed.scope.identifier},
           ${parsed.extracted_by}, ${parsed.created_at}, ${JSON.stringify(parsed)}::jsonb)`
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(
          `ClaimStore: claim ${claim.id} already exists; use transition() for status changes`,
        )
      }
      throw err
    }
  }

  async get(id: string): Promise<Claim | undefined> {
    const rows = (await this.sql`select data from lodestar_claims where id = ${id}`) as Array<{
      data: string
    }>
    const row = rows[0]
    if (!row) return undefined
    return parseClaim(row.data)
  }

  async list(filter?: ClaimFilter): Promise<Claim[]> {
    const conds: SQL.Query<unknown>[] = []
    if (filter?.status) {
      conds.push(
        filter.status.length === 0
          ? this.sql`false`
          : this.sql`status in ${this.sql(filter.status)}`,
      )
    }
    if (filter?.extracted_by !== undefined)
      conds.push(this.sql`extracted_by = ${filter.extracted_by}`)
    if (filter?.scope) {
      conds.push(this.sql`scope_level = ${filter.scope.level}`)
      conds.push(this.sql`scope_identifier = ${filter.scope.identifier}`)
    }
    if (filter?.since !== undefined) conds.push(this.sql`created_at >= ${filter.since}`)

    let q = this.sql`select data from lodestar_claims`
    conds.forEach((c, i) => {
      q = i === 0 ? this.sql`${q} where ${c}` : this.sql`${q} and ${c}`
    })
    const rows = (await q) as Array<{ data: string }>
    return rows.map((r) => parseClaim(r.data))
  }

  async history(id: string): Promise<ClaimTransition[]> {
    const rows = (await this.sql`
      select id, claim_id, from_status, to_status, by_actor_id, rationale_id, at
      from lodestar_claim_transitions where claim_id = ${id} order by at asc`) as Array<{
      id: string
      claim_id: string
      from_status: string
      to_status: string
      by_actor_id: string
      rationale_id: string
      at: Date | string
    }>
    return rows.map((r) => ({
      id: r.id,
      claim_id: r.claim_id,
      from_status: r.from_status as ClaimTransition["from_status"],
      to_status: r.to_status as ClaimTransition["to_status"],
      by_actor_id: r.by_actor_id,
      rationale_id: r.rationale_id,
      at: r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString(),
    }))
  }

  async transition(input: ClaimTransitionInput): Promise<ClaimTransition> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        select data from lodestar_claims where id = ${input.claim_id} for update`) as Array<{
        data: string
      }>
      const row = rows[0]
      if (!row) throw new Error(`ClaimStore: claim ${input.claim_id} not found`)
      const claim = parseClaim(row.data)
      if (claim.status !== input.from_status) {
        throw new Error(
          `ClaimStore: transition expected from_status=${input.from_status} but claim is ${claim.status}`,
        )
      }
      const transition: ClaimTransition = {
        id: crypto.randomUUID(),
        ...input,
        at: new Date().toISOString(),
      }
      await tx`
        insert into lodestar_claim_transitions
          (id, claim_id, from_status, to_status, by_actor_id, rationale_id, at)
        values
          (${transition.id}, ${transition.claim_id}, ${transition.from_status},
           ${transition.to_status}, ${transition.by_actor_id}, ${transition.rationale_id},
           ${transition.at})`
      const updated: Claim = { ...claim, status: input.to_status }
      await tx`
        update lodestar_claims set status = ${updated.status}, data = ${JSON.stringify(updated)}::jsonb
        where id = ${updated.id}`
      return transition
    })
  }
}

function parseClaim(data: string): Claim {
  return ClaimSchema.parse(typeof data === "string" ? JSON.parse(data) : data)
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { errno?: string }).errno === "23505"
}
