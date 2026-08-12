import { describe, expect, test } from "bun:test"
import type { Actor, ApprovalRequest } from "@qmilab/lodestar-core"
import {
  type ApprovalResolutionDoc,
  type AuthorizedApproverKeys,
  generateApproverKeyPair,
  signApprovalResolution,
} from "./approval-signature.js"
import { openApprovalRequest } from "./approval.js"
import type { PolicyEvaluation } from "./gate.js"
import { type QuorumVote, evaluateQuorum } from "./quorum.js"

/**
 * Unit coverage for the pure adjudicator. The adversarial spec — a
 * collector-synthesized grant, a revoked key, a pinned-but-ineligible approver —
 * lives in the `packs/lodestar-core/` probe; these are the mechanics underneath.
 */

const REQUESTED_AT = "2026-08-12T00:00:00.000Z"

function actor(id: string, over: Partial<Actor> = {}): Actor {
  return {
    id,
    kind: "human",
    display_name: id,
    authority_scope: [{ level: "global", identifier: "*" }],
    trust_baseline: 0.9,
    sensitivity_clearance: "secret",
    created_at: REQUESTED_AT,
    ...over,
  }
}

interface Approver {
  actor: Actor
  privateKeyPem: string
  publicKeyPem: string
}

function approver(id: string, over: Partial<Actor> = {}): Approver {
  const keys = generateApproverKeyPair()
  return { actor: actor(id, over), ...keys }
}

function keyRoster(...approvers: Approver[]): AuthorizedApproverKeys {
  return new Map(approvers.map((a) => [a.actor.id, a.publicKeyPem]))
}

function authorityRoster(...approvers: Approver[]): ReadonlyMap<string, Actor> {
  return new Map(approvers.map((a) => [a.actor.id, a.actor]))
}

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    request_id: "req-1",
    action_id: "act-1",
    reason: "L4 egress requires approval",
    required_authority: { sensitivity_clearance: "internal" },
    requested_at: REQUESTED_AT,
    quorum: 3,
    ...over,
  }
}

let voteSeq = 0

/** A genuinely signed vote from `who`. */
function vote(
  who: Approver,
  over: Partial<ApprovalResolutionDoc> = {},
  req: ApprovalRequest = request(),
): QuorumVote {
  voteSeq += 1
  const doc: ApprovalResolutionDoc = {
    request_id: req.request_id,
    action_id: req.action_id,
    kind: "granted",
    approver_id: who.actor.id,
    at: new Date(Date.parse(REQUESTED_AT) + voteSeq * 1000).toISOString(),
    ...over,
  }
  return {
    resolution: doc,
    signature: signApprovalResolution(doc, who.privateKeyPem),
    event_id: `evt-${voteSeq}`,
  }
}

describe("evaluateQuorum — the threshold", () => {
  test("M valid grants from distinct eligible approvers satisfy it", () => {
    const [a, b, c] = [approver("alice"), approver("bob"), approver("carol")]
    const result = evaluateQuorum(request(), [vote(a), vote(b), vote(c)], {
      authorizedKeys: keyRoster(a, b, c),
      approverAuthority: authorityRoster(a, b, c),
    })
    expect(result.satisfied).toBe(true)
    expect(result.required).toBe(3)
    expect(result.approvals.map((x) => x.approver_id)).toEqual(["alice", "bob", "carol"])
    expect(result.rejected).toEqual([])
  })

  test("M-1 valid grants do not satisfy it", () => {
    const [a, b, c] = [approver("alice"), approver("bob"), approver("carol")]
    const result = evaluateQuorum(request(), [vote(a), vote(b)], {
      authorizedKeys: keyRoster(a, b, c),
      approverAuthority: authorityRoster(a, b, c),
    })
    expect(result.satisfied).toBe(false)
    expect(result.approvals).toHaveLength(2)
  })

  test("a duplicate actor_id counts once", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const result = evaluateQuorum(request(), [vote(a), vote(a), vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
    })
    expect(result.satisfied).toBe(false)
    expect(result.approvals.map((x) => x.approver_id)).toEqual(["alice", "bob"])
    expect(result.rejected.map((r) => r.code)).toEqual(["duplicate"])
  })

  test("every verified grant is recorded, not just the first `required` of them", () => {
    const [a, b, c, d] = [approver("a"), approver("b"), approver("c"), approver("d")]
    const result = evaluateQuorum(request({ quorum: 2 }), [vote(a), vote(b), vote(c), vote(d)], {
      authorizedKeys: keyRoster(a, b, c, d),
      approverAuthority: authorityRoster(a, b, c, d),
    })
    expect(result.satisfied).toBe(true)
    expect(result.approvals).toHaveLength(4)
  })

  test("each counted grant names its evidence — payload hash and log event", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const av = vote(a)
    const result = evaluateQuorum(request({ quorum: 2 }), [av, vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
    })
    const [first] = result.approvals
    expect(first?.granted_event_id).toBe(av.event_id)
    expect(first?.payload_hash).toBe(av.signature?.payload_hash)
    expect(first?.at).toBe(av.resolution.at)
  })
})

describe("evaluateQuorum — authenticity", () => {
  test("an unsigned vote never counts (no allowUnsigned escape hatch)", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const unsigned: QuorumVote = { ...vote(a), signature: undefined }
    const result = evaluateQuorum(request({ quorum: 2 }), [unsigned, vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected.map((r) => r.code)).toEqual(["signature"])
  })

  test("a revoked key's outstanding vote stops counting (verify-time roster)", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const votes = [vote(a), vote(b)]
    // Alice's key is dropped from the roster after she signed.
    const result = evaluateQuorum(request({ quorum: 2 }), votes, {
      authorizedKeys: keyRoster(b),
      approverAuthority: authorityRoster(a, b),
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.approver_id).toBe("alice")
    expect(result.rejected[0]?.code).toBe("signature")
  })

  test("a signature lifted onto another approver's resolution does not count", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const alice = vote(a)
    const forged: QuorumVote = {
      ...alice,
      resolution: { ...alice.resolution, approver_id: "bob" },
    }
    const result = evaluateQuorum(request({ quorum: 1 }), [forged], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.code).toBe("signature")
  })

  test("a vote bound to another request does not count", () => {
    const a = approver("alice")
    const other = request({ request_id: "req-2", action_id: "act-2" })
    const result = evaluateQuorum(request({ quorum: 1 }), [vote(a, {}, other)], {
      authorizedKeys: keyRoster(a),
      approverAuthority: authorityRoster(a),
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.code).toBe("not_for_request")
  })
})

describe("evaluateQuorum — eligibility is orthogonal to authenticity", () => {
  test("an authentically-signed grant from a pinned approver who does NOT clear required_authority does not count", () => {
    const a = approver("alice")
    const intern = approver("intern", { sensitivity_clearance: "public" })
    const result = evaluateQuorum(
      request({ quorum: 2, required_authority: { sensitivity_clearance: "secret" } }),
      [vote(a), vote(intern)],
      {
        authorizedKeys: keyRoster(a, intern),
        approverAuthority: authorityRoster(a, intern),
      },
    )
    expect(result.satisfied).toBe(false)
    expect(result.approvals.map((x) => x.approver_id)).toEqual(["alice"])
    expect(result.rejected[0]).toMatchObject({ approver_id: "intern", code: "shortfall" })
  })

  test("an approver with no supplied Actor does not count (fail closed)", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const result = evaluateQuorum(request({ quorum: 2 }), [vote(a), vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a), // bob is pinned but has no Actor
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]).toMatchObject({ approver_id: "bob", code: "no_authority" })
  })

  test("a mis-keyed roster cannot lend one actor's authority to another", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const misKeyed = new Map<string, Actor>([["bob", a.actor]])
    const result = evaluateQuorum(request({ quorum: 1 }), [vote(b)], {
      authorizedKeys: keyRoster(b),
      approverAuthority: misKeyed,
    })
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.code).toBe("no_authority")
  })

  test("a shortfall on trust_baseline or scope is reported verbatim", () => {
    const weak = approver("weak", { trust_baseline: 0.1 })
    const result = evaluateQuorum(
      request({ quorum: 1, required_authority: { min_trust_baseline: 0.8 } }),
      [vote(weak)],
      { authorizedKeys: keyRoster(weak), approverAuthority: authorityRoster(weak) },
    )
    expect(result.rejected[0]?.reason).toContain("trust_baseline 0.1 is below the required 0.8")
  })
})

describe("evaluateQuorum — the deny veto", () => {
  test("a deny after M-1 grants rejects, regardless of grants collected", () => {
    const [a, b, c] = [approver("alice"), approver("bob"), approver("carol")]
    const result = evaluateQuorum(
      request(),
      [vote(a), vote(b), vote(c, { kind: "denied", reason: "active incident" })],
      { authorizedKeys: keyRoster(a, b, c), approverAuthority: authorityRoster(a, b, c) },
    )
    expect(result.satisfied).toBe(false)
    expect(result.vetoed).toMatchObject({ approver_id: "carol", reason: "active incident" })
    expect(result.approvals).toHaveLength(2)
  })

  test("a later deny from an actor who earlier granted still vetoes", () => {
    const [a, b, c] = [approver("alice"), approver("bob"), approver("carol")]
    const result = evaluateQuorum(
      request({ quorum: 2 }),
      [vote(a), vote(b), vote(a, { kind: "denied" }), vote(c)],
      { authorizedKeys: keyRoster(a, b, c), approverAuthority: authorityRoster(a, b, c) },
    )
    expect(result.satisfied).toBe(false)
    expect(result.vetoed?.approver_id).toBe("alice")
  })

  test("the veto is chronological, not input-order", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const early = vote(a, { kind: "denied", at: "2026-08-12T00:00:05.000Z" })
    const late = vote(b, { at: "2026-08-12T00:00:09.000Z" })
    const result = evaluateQuorum(request({ quorum: 1 }), [late, early], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
    })
    // The deny landed first, so the later grant is moot and never counted.
    expect(result.vetoed?.approver_id).toBe("alice")
    expect(result.approvals).toEqual([])
    expect(result.satisfied).toBe(false)
  })

  test("an INVALID deny does not veto", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const impostor = approver("impostor")
    const result = evaluateQuorum(
      request({ quorum: 2 }),
      [vote(impostor, { kind: "denied" }), vote(a), vote(b)],
      { authorizedKeys: keyRoster(a, b), approverAuthority: authorityRoster(a, b) },
    )
    expect(result.vetoed).toBeUndefined()
    expect(result.satisfied).toBe(true)
  })

  test("the proposer may still withdraw their own action by denying it", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const result = evaluateQuorum(request({ quorum: 2 }), [vote(a, { kind: "denied" }), vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
      proposedBy: "alice",
    })
    expect(result.vetoed?.approver_id).toBe("alice")
  })
})

describe("evaluateQuorum — the proposer exclusion", () => {
  test("the proposer's own grant does not count at quorum >= 2", () => {
    const [a, b] = [approver("alice"), approver("bob")]
    const result = evaluateQuorum(request({ quorum: 2 }), [vote(a), vote(b)], {
      authorizedKeys: keyRoster(a, b),
      approverAuthority: authorityRoster(a, b),
      proposedBy: "alice",
    })
    expect(result.satisfied).toBe(false)
    expect(result.approvals.map((x) => x.approver_id)).toEqual(["bob"])
    expect(result.rejected[0]).toMatchObject({ approver_id: "alice", code: "proposer" })
  })

  test("no exclusion applies at the single-approver threshold", () => {
    const a = approver("alice")
    const result = evaluateQuorum(request({ quorum: undefined }), [vote(a)], {
      authorizedKeys: keyRoster(a),
      approverAuthority: authorityRoster(a),
      proposedBy: "alice",
    })
    expect(result.required).toBe(1)
    expect(result.satisfied).toBe(true)
    expect(result.rejected).toEqual([])
  })
})

describe("evaluateQuorum — the validity window", () => {
  test("a vote signed before the request was opened does not count", () => {
    const a = approver("alice")
    const result = evaluateQuorum(
      request({ quorum: 1 }),
      [vote(a, { at: "2026-08-11T23:59:59.000Z" })],
      { authorizedKeys: keyRoster(a), approverAuthority: authorityRoster(a) },
    )
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.code).toBe("out_of_window")
  })

  test("a vote past the request's deadline does not count", () => {
    const a = approver("alice")
    const result = evaluateQuorum(
      request({ quorum: 1, deadline: "2026-08-12T00:00:02.000Z" }),
      [vote(a, { at: "2026-08-12T00:05:00.000Z" })],
      { authorizedKeys: keyRoster(a), approverAuthority: authorityRoster(a) },
    )
    expect(result.satisfied).toBe(false)
    expect(result.rejected[0]?.code).toBe("out_of_window")
  })

  test("an unparseable vote timestamp is a rejection, not a throw", () => {
    const a = approver("alice")
    const bad = vote(a, { at: "not-a-timestamp" })
    const result = evaluateQuorum(request({ quorum: 1 }), [bad], {
      authorizedKeys: keyRoster(a),
      approverAuthority: authorityRoster(a),
    })
    expect(result.rejected[0]?.code).toBe("out_of_window")
  })

  test("an unparseable request timestamp throws — a host bug must be loud", () => {
    const a = approver("alice")
    expect(() =>
      evaluateQuorum(request({ requested_at: "nonsense" }), [vote(a)], {
        authorizedKeys: keyRoster(a),
        approverAuthority: authorityRoster(a),
      }),
    ).toThrow(/unparseable requested_at/)
  })
})

describe("openApprovalRequest carries the rule's quorum", () => {
  function holdEvaluation(quorum?: number): PolicyEvaluation {
    return {
      verdict: "hold",
      reason: "held",
      decider_id: "policy",
      matched: { source: "rule", rule_index: 0 },
      required_authority: {},
      quorum,
    }
  }

  const action = {
    id: "act-1",
    tool: "http.request",
    contract: {
      required_level: 4,
      blast_radius: "external",
      reversibility: "irreversible",
      data_sensitivity: "internal",
      scope: { level: "global", identifier: "*" },
    },
  } as unknown as Parameters<typeof openApprovalRequest>[0]

  test("a quorum >= 2 rule stamps it on the request", () => {
    const req = openApprovalRequest(action, holdEvaluation(3), { request_id: "r" })
    expect(req.quorum).toBe(3)
  })

  test("a rule spelling out quorum: 1 is normalised to omission", () => {
    const req = openApprovalRequest(action, holdEvaluation(1), { request_id: "r" })
    expect("quorum" in req).toBe(false)
  })

  test("no quorum on the rule leaves the request byte-identical to today", () => {
    const req = openApprovalRequest(action, holdEvaluation(), { request_id: "r" })
    expect("quorum" in req).toBe(false)
  })
})
