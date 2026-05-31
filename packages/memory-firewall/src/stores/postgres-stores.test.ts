import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Belief, Claim, EvidenceSet } from "@qmilab/lodestar-core"
import { type PostgresStores, createPostgresStores, dropSchema, truncateAll } from "./postgres.js"

/**
 * Integration tests for the Postgres-backed stores.
 *
 * Gated on `LODESTAR_TEST_DATABASE_URL`: with no database configured the whole
 * suite is skipped, so a plain `bun test` (and any DB-less runner) stays green.
 * CI sets the env var against a `postgres:16` service; locally, point it at a
 * throwaway container:
 *
 *   docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=lodestar_test \
 *     -p 5432:5432 postgres:16
 *   LODESTAR_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/lodestar_test \
 *     bun test packages/memory-firewall
 */
const url = process.env.LODESTAR_TEST_DATABASE_URL

const TS = "2026-01-01T00:00:00.000Z"

function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: "claim-1",
    statement: "the current branch is main",
    source_observation_ids: ["obs-1"],
    extraction_method: "tool",
    extracted_by: "actor:extractor",
    status: "extracted",
    scope: { level: "session", identifier: "sess-A" },
    sensitivity: "internal",
    authors: ["actor:extractor"],
    created_at: TS,
    ...over,
  }
}

function makeBelief(over: Partial<Belief> = {}): Belief {
  return {
    id: "belief-1",
    claim_id: "claim-1",
    confidence: 0.9,
    calibration_class: "branch.current",
    scope: { level: "session", identifier: "sess-A" },
    sensitivity: "internal",
    authority: "observed",
    truth_status: "unverified",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: TS,
    ...over,
  }
}

function makeEvidence(over: Partial<EvidenceSet> = {}): EvidenceSet {
  return {
    id: "ev-1",
    claim_id: "claim-1",
    items: [
      {
        source_id: "obs-1",
        relation: "supports",
        quality: "external_document",
        freshness: "fresh",
      },
    ],
    assessed_by: "actor:assessor",
    assessed_at: TS,
    ...over,
  }
}

describe.skipIf(!url)("Postgres stores (integration)", () => {
  let stores: PostgresStores

  beforeAll(async () => {
    stores = createPostgresStores(url as string)
    await stores.ensureSchema()
  })

  beforeEach(async () => {
    await truncateAll(stores.sql)
  })

  afterAll(async () => {
    if (stores) {
      await dropSchema(stores.sql)
      await stores.close()
    }
  })

  // ---------------------------------------------------------------------------
  // ClaimStore
  // ---------------------------------------------------------------------------

  describe("ClaimStore", () => {
    test("put + get round-trips through Zod", async () => {
      const claim = makeClaim({
        structured_predicate: { subject: "branch", relation: "current", object: "main" },
      })
      await stores.claims.put(claim)
      expect(await stores.claims.get(claim.id)).toEqual(claim)
    })

    test("get returns undefined for an unknown id", async () => {
      expect(await stores.claims.get("nope")).toBeUndefined()
    })

    test("duplicate put rejects", async () => {
      await stores.claims.put(makeClaim())
      await expect(stores.claims.put(makeClaim())).rejects.toThrow(/already exists/)
    })

    test("list filters by status, scope, extracted_by, since", async () => {
      await stores.claims.put(makeClaim({ id: "c-extracted", status: "extracted" }))
      await stores.claims.put(makeClaim({ id: "c-accepted", status: "accepted" }))
      await stores.claims.put(
        makeClaim({ id: "c-other-scope", scope: { level: "session", identifier: "sess-B" } }),
      )
      await stores.claims.put(makeClaim({ id: "c-other-actor", extracted_by: "actor:two" }))
      await stores.claims.put(makeClaim({ id: "c-late", created_at: "2026-06-01T00:00:00.000Z" }))

      expect((await stores.claims.list({ status: ["accepted"] })).map((c) => c.id)).toEqual([
        "c-accepted",
      ])
      const scoped = await stores.claims.list({ scope: { level: "session", identifier: "sess-B" } })
      expect(scoped.map((c) => c.id)).toEqual(["c-other-scope"])
      expect((await stores.claims.list({ extracted_by: "actor:two" })).map((c) => c.id)).toEqual([
        "c-other-actor",
      ])
      expect(
        (await stores.claims.list({ since: "2026-03-01T00:00:00.000Z" })).map((c) => c.id),
      ).toEqual(["c-late"])
      // empty array filter matches nothing (parity with in-memory [].includes())
      expect(await stores.claims.list({ status: [] })).toEqual([])
    })

    test("transition records history and mirrors status; mismatch rejects", async () => {
      await stores.claims.put(makeClaim())
      const t = await stores.claims.transition({
        claim_id: "claim-1",
        from_status: "extracted",
        to_status: "accepted",
        by_actor_id: "actor:reviewer",
        rationale_id: "expl-1",
      })
      expect(t.id).toBeTruthy()
      expect((await stores.claims.get("claim-1"))?.status).toBe("accepted")
      const history = await stores.claims.history("claim-1")
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ from_status: "extracted", to_status: "accepted" })

      await expect(
        stores.claims.transition({
          claim_id: "claim-1",
          from_status: "extracted", // stale; current is now "accepted"
          to_status: "rejected",
          by_actor_id: "actor:reviewer",
          rationale_id: "expl-2",
        }),
      ).rejects.toThrow(/expected from_status=extracted but claim is accepted/)
    })
  })

  // ---------------------------------------------------------------------------
  // BeliefStore
  // ---------------------------------------------------------------------------

  describe("BeliefStore", () => {
    test("put + get round-trips, including optional fields", async () => {
      const belief = makeBelief({ last_verified_at: TS, expires_at: TS })
      await stores.beliefs.put(belief)
      expect(await stores.beliefs.get(belief.id)).toEqual(belief)
    })

    test("duplicate put rejects", async () => {
      await stores.beliefs.put(makeBelief())
      await expect(stores.beliefs.put(makeBelief())).rejects.toThrow(/already exists/)
    })

    test("list filters across every dimension", async () => {
      await stores.beliefs.put(makeBelief({ id: "b1" }))
      await stores.beliefs.put(makeBelief({ id: "b2", claim_id: "claim-2", authority: "imported" }))
      await stores.beliefs.put(
        makeBelief({ id: "b3", truth_status: "supported", security_status: "quarantined" }),
      )
      await stores.beliefs.put(makeBelief({ id: "b4", sensitivity: "secret" }))
      await stores.beliefs.put(
        makeBelief({
          id: "b5",
          scope: { level: "project", identifier: "proj-X" },
          calibration_class: "other",
        }),
      )

      expect((await stores.beliefs.list({ claim_id: "claim-2" })).map((b) => b.id)).toEqual(["b2"])
      expect((await stores.beliefs.list({ authority: ["imported"] })).map((b) => b.id)).toEqual([
        "b2",
      ])
      expect((await stores.beliefs.list({ truth_status: ["supported"] })).map((b) => b.id)).toEqual(
        ["b3"],
      )
      expect(
        (await stores.beliefs.list({ security_status: ["quarantined"] })).map((b) => b.id),
      ).toEqual(["b3"])
      expect(
        (await stores.beliefs.list({ scope: { level: "project", identifier: "proj-X" } })).map(
          (b) => b.id,
        ),
      ).toEqual(["b5"])
      expect((await stores.beliefs.list({ calibration_class: "other" })).map((b) => b.id)).toEqual([
        "b5",
      ])

      // max_sensitivity is a ceiling: "secret" belief is excluded under an "internal" ceiling.
      const underInternal = await stores.beliefs.list({ max_sensitivity: "internal" })
      expect(underInternal.map((b) => b.id).sort()).toEqual(["b1", "b2", "b3", "b5"])
      expect(underInternal.map((b) => b.id)).not.toContain("b4")
      // raising the ceiling to secret lets it through
      expect((await stores.beliefs.list({ max_sensitivity: "secret" })).map((b) => b.id)).toContain(
        "b4",
      )

      expect(await stores.beliefs.list({ truth_status: [] })).toEqual([])
    })

    test("transition mirrors the axis, records history, rejects stale from_value", async () => {
      await stores.beliefs.put(makeBelief())
      await stores.beliefs.transition({
        belief_id: "belief-1",
        axis: "truth_status",
        from_value: "unverified",
        to_value: "supported",
        by_actor_id: "actor:firewall",
        rationale_id: "expl-1",
      })
      const after = await stores.beliefs.get("belief-1")
      expect(after?.truth_status).toBe("supported")
      // other axes untouched
      expect(after?.retrieval_status).toBe("normal")
      expect(await stores.beliefs.history("belief-1")).toHaveLength(1)

      await expect(
        stores.beliefs.transition({
          belief_id: "belief-1",
          axis: "truth_status",
          from_value: "unverified", // stale
          to_value: "contradicted",
          by_actor_id: "actor:firewall",
          rationale_id: "expl-2",
        }),
      ).rejects.toThrow(/expected from=unverified but belief has supported/)
    })

    test("setSupersededBy stamps the successor pointer", async () => {
      await stores.beliefs.put(makeBelief())
      await stores.beliefs.setSupersededBy("belief-1", "belief-99")
      expect((await stores.beliefs.get("belief-1"))?.superseded_by).toBe("belief-99")
    })
  })

  // ---------------------------------------------------------------------------
  // EvidenceStore
  // ---------------------------------------------------------------------------

  describe("EvidenceStore", () => {
    test("put + get + forClaim", async () => {
      await stores.evidence.put(makeEvidence({ id: "ev-1", claim_id: "claim-1" }))
      await stores.evidence.put(makeEvidence({ id: "ev-2", claim_id: "claim-1" }))
      await stores.evidence.put(makeEvidence({ id: "ev-3", claim_id: "claim-2" }))

      expect((await stores.evidence.get("ev-1"))?.id).toBe("ev-1")
      expect((await stores.evidence.forClaim("claim-1")).map((e) => e.id)).toEqual(["ev-1", "ev-2"])
    })

    test("appendItem adds to the set without removing existing items", async () => {
      await stores.evidence.put(makeEvidence())
      const updated = await stores.evidence.appendItem("ev-1", {
        source_id: "obs-2",
        relation: "contradicts",
        quality: "tool_result",
        freshness: "fresh",
      })
      expect(updated.items).toHaveLength(2)
      expect((await stores.evidence.get("ev-1"))?.items).toHaveLength(2)
    })
  })

  // ---------------------------------------------------------------------------
  // The point of step 7: persistence survives the instance boundary.
  // ---------------------------------------------------------------------------

  describe("cross-instance persistence", () => {
    test("a belief written by one store instance is readable by a fresh instance", async () => {
      // Session A writes an imported, external_document-provenance belief.
      await stores.claims.put(makeClaim({ id: "claim-x" }))
      await stores.beliefs.put(
        makeBelief({ id: "belief-x", claim_id: "claim-x", authority: "imported" }),
      )

      // Session B is a brand-new connection/instance against the same database.
      const sessionB = createPostgresStores(url as string)
      try {
        const seen = await sessionB.beliefs.get("belief-x")
        expect(seen?.authority).toBe("imported")
        const imported = await sessionB.beliefs.list({ authority: ["imported"] })
        expect(imported.map((b) => b.id)).toContain("belief-x")
        expect(await sessionB.claims.get("claim-x")).toBeTruthy()
      } finally {
        await sessionB.close()
      }
    })
  })
})
