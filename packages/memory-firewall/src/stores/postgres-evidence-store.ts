import { type EvidenceItem, type EvidenceSet, EvidenceSetSchema } from "@qmilab/lodestar-core"
import type { SQL } from "bun"
import type { EvidenceStore } from "./evidence-store.js"
import { isUniqueViolation } from "./postgres-errors.js"

/**
 * Postgres-backed EvidenceStore (Bun's native `Bun.SQL`).
 *
 * Append-only on items, like {@link InMemoryEvidenceStore}: `appendItem` adds
 * to an existing set's items but never removes. The whole set is stored as
 * `data jsonb` keyed by id, with `claim_id` mirrored for `forClaim` lookups.
 */
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly sql: SQL) {}

  async put(evidence: EvidenceSet): Promise<void> {
    const parsed = EvidenceSetSchema.parse(evidence)
    try {
      await this.sql`
        insert into lodestar_evidence_sets (id, claim_id, data)
        values (${parsed.id}, ${parsed.claim_id}, ${JSON.stringify(parsed)}::jsonb)`
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`EvidenceStore: evidence ${evidence.id} already exists`)
      }
      throw err
    }
  }

  async get(id: string): Promise<EvidenceSet | undefined> {
    const rows = (await this
      .sql`select data from lodestar_evidence_sets where id = ${id}`) as Array<{ data: string }>
    const row = rows[0]
    if (!row) return undefined
    return parseEvidence(row.data)
  }

  async forClaim(claim_id: string): Promise<EvidenceSet[]> {
    const rows = (await this
      .sql`select data from lodestar_evidence_sets where claim_id = ${claim_id} order by id asc`) as Array<{
      data: string
    }>
    return rows.map((r) => parseEvidence(r.data))
  }

  async appendItem(evidence_id: string, item: EvidenceItem): Promise<EvidenceSet> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        select data from lodestar_evidence_sets where id = ${evidence_id} for update`) as Array<{
        data: string
      }>
      const row = rows[0]
      if (!row) throw new Error(`EvidenceStore: evidence ${evidence_id} not found`)
      const existing = parseEvidence(row.data)
      const updated: EvidenceSet = { ...existing, items: [...existing.items, item] }
      await tx`
        update lodestar_evidence_sets set data = ${JSON.stringify(updated)}::jsonb
        where id = ${evidence_id}`
      return updated
    })
  }
}

function parseEvidence(data: string): EvidenceSet {
  return EvidenceSetSchema.parse(typeof data === "string" ? JSON.parse(data) : data)
}
