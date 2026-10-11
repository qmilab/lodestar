import { describe, expect, test } from "bun:test"
import type { Action } from "../schemas/action.js"
import {
  ACTION_REPRESENTATION_HASH_PATTERN,
  actionRepresentationHash,
  canonicalActionRepresentation,
  canonicalJsonValue,
} from "./action-representation.js"

const proposed: Action = {
  id: "act-1",
  intent: "push the release branch",
  tool: "git.push",
  inputs: { remote: "origin", branch: "release", flags: { force: false, tags: true } },
  contract: {
    required_level: 4,
    blast_radius: "external",
    reversibility: "irreversible",
    scope: { level: "repo", identifier: "lodestar" },
    data_sensitivity: "private",
    preconditions: [],
  },
  phase: "proposed",
  audit: [{ phase: "proposed", by_actor_id: "agent", at: "2026-10-11T00:00:00.000Z" }],
  proposed_at: "2026-10-11T00:00:00.000Z",
  proposed_by: "agent",
}

describe("actionRepresentationHash", () => {
  test("is a sha-256 hex digest", () => {
    expect(actionRepresentationHash(proposed)).toMatch(ACTION_REPRESENTATION_HASH_PATTERN)
  })

  test("is phase-independent: lifecycle and narrative fields do not move it", () => {
    const parked: Action = {
      ...proposed,
      phase: "pending_approval",
      intent: "something else entirely",
      decision_id: "dec-9",
      audit: [
        ...proposed.audit,
        { phase: "pending_approval", by_actor_id: "policy", at: "2026-10-11T00:00:01.000Z" },
      ],
      approval: { approver_id: "x", approved: true, at: "2026-10-11T00:00:02.000Z" },
    }
    expect(actionRepresentationHash(parked)).toBe(actionRepresentationHash(proposed))
  })

  test("binds everything execute() reads: tool, inputs, contract, proposed_by, id", () => {
    const base = actionRepresentationHash(proposed)
    expect(actionRepresentationHash({ ...proposed, tool: "git.force_push" })).not.toBe(base)
    expect(
      actionRepresentationHash({ ...proposed, inputs: { remote: "origin", branch: "main" } }),
    ).not.toBe(base)
    expect(
      actionRepresentationHash({
        ...proposed,
        contract: {
          ...proposed.contract,
          preconditions: [
            {
              check_id: "c",
              parameters: {},
              expected_at_approval: 1,
              must_revalidate_at_execution: true,
            },
          ],
        },
      }),
    ).not.toBe(base)
    expect(actionRepresentationHash({ ...proposed, proposed_by: "someone-else" })).not.toBe(base)
    expect(actionRepresentationHash({ ...proposed, id: "act-2" })).not.toBe(base)
  })

  test("survives the event log's JSON round-trip", () => {
    const reread = JSON.parse(JSON.stringify(proposed)) as Action
    expect(actionRepresentationHash(reread)).toBe(actionRepresentationHash(proposed))
  })

  test("a toJSON value hashes as the string the log writes", () => {
    const withDate = { ...proposed, inputs: { when: new Date("2026-10-11T00:00:00.000Z") } }
    const reread = JSON.parse(JSON.stringify(withDate)) as Action
    expect(actionRepresentationHash(withDate)).toBe(actionRepresentationHash(reread))
  })

  test("undefined inputs are omitted, as the log drops the key", () => {
    const none = { ...proposed, inputs: undefined }
    expect("inputs" in canonicalActionRepresentation(none)).toBe(false)
    expect(actionRepresentationHash(none)).toBe(
      actionRepresentationHash(JSON.parse(JSON.stringify(none)) as Action),
    )
  })
})

describe("canonicalJsonValue", () => {
  test("sorts keys at every depth and collapses -0", () => {
    const value = canonicalJsonValue({ b: { y: 1, x: -0 }, a: [3, { d: 1, c: 2 }] })
    expect(JSON.stringify(value)).toBe('{"a":[3,{"c":2,"d":1}],"b":{"x":0,"y":1}}')
    expect(Object.is((value as { b: { x: number } }).b.x, -0)).toBe(false)
  })

  test("is a fixed point that leaves the representation hash unchanged", () => {
    const once = canonicalJsonValue(proposed.inputs)
    expect(canonicalJsonValue(once)).toEqual(once)
    const canonicalized = {
      ...proposed,
      inputs: once,
      contract: canonicalJsonValue(proposed.contract),
    }
    expect(actionRepresentationHash(canonicalized)).toBe(actionRepresentationHash(proposed))
  })

  test("leaves undefined undefined", () => {
    expect(canonicalJsonValue(undefined)).toBeUndefined()
  })
})
