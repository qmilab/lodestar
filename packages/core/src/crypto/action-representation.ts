import type { Action } from "../schemas/action.js"
import { canonicalHashHex, stableStringify } from "./canonical.js"

/**
 * The **representation** of an action — what an approver authorizes (ADR-0042).
 *
 * Loopjacking's *representation mismatch* is a reviewer shown something other
 * than the operation that will run. The fix binds an approval to this document:
 * *which action, running which tool, with which inputs, under which contract, as
 * whom*. Every field is one the Action Kernel's `execute()` reads — `proposed_by`
 * reaches the tool as `ToolContext.actor_id` — and nothing else is in it:
 * `intent`, `decision_id`, `proposed_at`, `phase`, `audit` and `approval` are
 * narrative, provenance and lifecycle that execution never consults.
 *
 * **Phase-independent by construction.** The same hash comes out of the action at
 * `proposed`, `pending_approval` or `approved`, out of the `action.proposed` log
 * payload, and out of a parked action a host rebuilt from the log. That is what
 * lets a host recompute it from *the action it is about to run* at the moment of
 * promotion, rather than compare against a remembered value — and a remembered
 * value, on a restart path, would come from the same log a local writer can
 * append to.
 *
 * `inputs` and `contract` are JSON-normalized (through `JSON.stringify`, so a
 * `toJSON` value such as a `Date` becomes the string the event log writes) and
 * then key-sorted, so the in-memory value and its on-disk re-read hash
 * identically. `inputs` is omitted when the action's inputs are `undefined`,
 * exactly as `JSON.stringify` drops the key on disk.
 */
export interface ActionRepresentation {
  action_id: string
  tool: string
  inputs?: unknown
  contract: unknown
  proposed_by: string
}

/** The action fields the representation reads — a full core `Action` is assignable. */
export type RepresentableAction = Pick<
  Action,
  "id" | "tool" | "inputs" | "contract" | "proposed_by"
>

/** Matches an {@link actionRepresentationHash}: sha-256, 64 lowercase hex. */
export const ACTION_REPRESENTATION_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * The canonical JSON value of `value`: what the event log would write for it
 * (`JSON.stringify` semantics — `toJSON` applied, `-0` → `0`, non-finite numbers
 * → `null`, `undefined` / function keys dropped), re-parsed with every object's
 * keys in sorted order. `undefined` stays `undefined`.
 *
 * A **fixed point**: `canonicalJsonValue(canonicalJsonValue(v))` deep-equals
 * `canonicalJsonValue(v)`, and replacing an action's `inputs` / `contract` with
 * their canonical values leaves {@link actionRepresentationHash} unchanged. That
 * is what lets a host execute the canonical form — so a tool receives exactly the
 * value an approver's hash covers, with no key order or `-0` the hash cannot see.
 *
 * Throws on what `JSON.stringify` throws on (a `BigInt`, a cycle) — a value the
 * event log could not have recorded either.
 *
 * Typed `unknown → unknown` on purpose: normalization is not type-preserving (a
 * `Date` becomes a string, a function `undefined`, `NaN` `null`), so a caller that
 * knows its value is already JSON-shaped asserts that itself.
 */
export function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  if (text === undefined) return undefined
  return JSON.parse(stableStringify(JSON.parse(text)))
}

/**
 * Build the canonical {@link ActionRepresentation} of an action, key-by-key, so
 * an incidental field on the input (an `audit` entry, an `approval`) can never
 * enter the hash.
 */
export function canonicalActionRepresentation(action: RepresentableAction): ActionRepresentation {
  const representation: ActionRepresentation = {
    action_id: action.id,
    tool: action.tool,
    contract: canonicalJsonValue(action.contract),
    proposed_by: action.proposed_by,
  }
  const inputs = canonicalJsonValue(action.inputs)
  if (inputs !== undefined) representation.inputs = inputs
  return representation
}

/**
 * sha-256 hex of the canonical action representation — the value an
 * `ApprovalRequest.inputs_hash` carries and an approver's signed resolution binds
 * (ADR-0042). Pure; the same canonicalisation the approval-resolution signature
 * uses (`stableStringify`).
 */
export function actionRepresentationHash(action: RepresentableAction): string {
  return canonicalHashHex(canonicalActionRepresentation(action))
}
