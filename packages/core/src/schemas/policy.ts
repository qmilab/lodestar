import { z } from "zod"
import {
  BlastRadiusSchema,
  DataSensitivityForActionSchema,
  ReversibilitySchema,
  TrustLevelSchema,
} from "./action.js"
import { SignatureSchema } from "./actor.js"
import { ResourceScopeSchema, SensitivitySchema } from "./common.js"

/**
 * Action policy — the wire format for what actions may touch the world.
 *
 * Design lock: `docs/architecture/policy-kernel.md`. The short version:
 *
 * - Policy is a *declarative document*, not a function. Today's enforcement
 *   is an opaque `PolicyGate` closure (the `autoApprovePolicy` preset). The
 *   Policy Kernel compiles a `Policy` document into that gate, so the verdict
 *   becomes data — addressable, hashable, signable, and citable by
 *   `Decision.policy_dependencies`.
 * - Rules are evaluated *in order*; the first decisive rule wins, over a
 *   *structural* deny default. There is deliberately no `default` field and
 *   no expressible `default: allow` — the safe outcome is structural, not a
 *   rule someone can forget to add ("no silent defaults for security-relevant
 *   settings", root CLAUDE.md).
 * - The *trust-ladder floor* (L5 deny, L4 always require_approval) is a
 *   non-overridable pre-check applied *before* the rule list, in the engine —
 *   it is NOT expressed as a rule, so no broad earlier `allow` can lift it.
 *
 * Not to be confused with `ContextPolicy` (`belief.ts`), which governs what
 * beliefs may enter model context. This `Policy` governs what actions may
 * touch the world — a different gate on a different chain link.
 *
 * Core owns the wire format only. The engine — `compile(policy) → PolicyGate`,
 * the three-valued gate, signature verification, the arbitrate hook — lives in
 * `@qmilab/lodestar-policy-kernel`.
 */

/**
 * The declarative effect of a matched rule.
 *
 * `require_approval` is the *declarative* counterpart of the gate's runtime
 * `hold` verdict: a matched `require_approval` rule causes the engine to park
 * the action at `pending_approval` and open an `ApprovalRequest`. (The runtime
 * three-valued verdict `allow | deny | hold` is an engine type and lives in
 * `@qmilab/lodestar-policy-kernel`, not in the wire format.)
 */
export const PolicyEffectSchema = z.enum(["allow", "deny", "require_approval"])
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>

/**
 * The match clause of a rule. All present fields must hold (AND); an absent
 * field is a wildcard. A rule with an empty `match` matches every action.
 *
 * The fields constrain an `ActionContract` (`action.ts`):
 * - `tool` is a glob over the tool registry key (e.g. `"git.*"`).
 * - `max_blast_radius` matches contracts at or below this radius on the
 *   ordering self < session < project < external (the comparison is engine
 *   logic; the schema stores the ceiling).
 * - `reversibility` is the set the contract's reversibility must be a member
 *   of (e.g. `["reversible", "compensable"]` excludes `irreversible`).
 * - `scope` constrains the contract's `ResourceScope`.
 * - `data_sensitivity` matches the contract's 3-value action sensitivity.
 * - `required_level_lte` matches contracts whose `required_level` is at or
 *   below this trust level.
 */
export const PolicyMatchSchema = z.object({
  tool: z.string().min(1).optional().describe("glob over the tool registry key, e.g. 'git.*'"),
  max_blast_radius: BlastRadiusSchema.optional().describe(
    "matches contracts at or below this blast radius (self < session < project < external)",
  ),
  reversibility: z
    .array(ReversibilitySchema)
    .min(1)
    .optional()
    .describe("the set the contract's reversibility must be a member of"),
  scope: ResourceScopeSchema.optional().describe("constrains the contract's ResourceScope"),
  data_sensitivity: DataSensitivityForActionSchema.optional().describe(
    "matches the contract's 3-value action sensitivity",
  ),
  required_level_lte: TrustLevelSchema.optional().describe(
    "matches contracts whose required_level is at or below this",
  ),
})
export type PolicyMatch = z.infer<typeof PolicyMatchSchema>

/**
 * Constraints an approver must satisfy to resolve a held action. *Data, not a
 * callback* — it says *what* an approver must be, checked against the
 * resolver's `Actor`. This is what lets a team approval surface route a
 * request to the right person without the Policy Kernel knowing anything
 * about people. All fields optional; an empty object means "any actor the
 * host has configured as a resolver may approve".
 *
 * The clearance check spans two alphabets: an action's `data_sensitivity` is
 * the 3-value `public | private | secret`, an `Actor.sensitivity_clearance`
 * is the 4-value `Sensitivity`. `sensitivity_clearance` here is the *4-value*
 * `Sensitivity` — the action's sensitivity *mapped* via the Action Kernel's
 * `sensitivityForContract` (`public→public`, `private→internal`,
 * `secret→secret`) — so the approver-side comparison happens in one alphabet.
 */
export const RequiredAuthoritySchema = z.object({
  min_trust_baseline: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("floor on an approver's Actor.trust_baseline"),
  sensitivity_clearance: SensitivitySchema.optional().describe(
    "4-value clearance the approver must hold; the action's data_sensitivity mapped via sensitivityForContract",
  ),
  scope: ResourceScopeSchema.optional().describe("ResourceScope the approver must hold"),
})
export type RequiredAuthority = z.infer<typeof RequiredAuthoritySchema>

/**
 * The approval requirement carried by a `require_approval` rule. When the rule
 * fires, its `required_authority` becomes the opened `ApprovalRequest`'s
 * `required_authority`. Omitting `required_authority` (or the whole
 * `approval` object) means any configured resolver may approve.
 *
 * A thin wrapper today; it is the seam where multi-approver / N-of-M
 * constraints attach when the team approval surface is built (deferred —
 * `policy-kernel.md`, "a separate team surface").
 */
export const ApprovalRequirementSchema = z.object({
  required_authority: RequiredAuthoritySchema.optional().describe(
    "constraints an approver must satisfy; omitted means any configured resolver may approve",
  ),
})
export type ApprovalRequirement = z.infer<typeof ApprovalRequirementSchema>

/**
 * One match → effect rule. Evaluated in document order; the first rule whose
 * `match` holds is decisive. `reason` is surfaced verbatim in the
 * `PolicyDecision` (and, for a held action, in the `ApprovalRequest`).
 *
 * `approval` may be present only on a `require_approval` rule (enforced
 * below). It is not *required* there — an absent `approval` means the hold has
 * no authority constraints (any configured resolver may approve), which is a
 * meaningful default, so it is left optional rather than forced to an empty
 * object.
 */
export const PolicyRuleSchema = z
  .object({
    match: PolicyMatchSchema,
    effect: PolicyEffectSchema,
    approval: ApprovalRequirementSchema.optional().describe(
      "present only on a require_approval rule; carries the authority an approver must hold",
    ),
    reason: z
      .string()
      .min(1)
      .describe("surfaced verbatim in the PolicyDecision and ApprovalRequest"),
  })
  .superRefine((rule, ctx) => {
    if (rule.approval !== undefined && rule.effect !== "require_approval") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval"],
        message: "approval may only be set on a rule whose effect is 'require_approval'",
      })
    }
  })
export type PolicyRule = z.infer<typeof PolicyRuleSchema>

/**
 * A signed, packageable action-policy document.
 *
 * `version` is the monotonic string that `Decision.policy_dependencies` cites,
 * so an audit can resolve exactly which policy version arbitrated an action.
 *
 * `signature` / `signed_by` are *optional at the schema level* so that
 * unsigned **drafts** parse, but `v02-delta.md` §5 lists policy versions among
 * the artifacts that *require* Ed25519 signatures: the Policy Kernel rejects an
 * unsigned (or invalid-signature) policy at the gate, except under an explicit,
 * logged `allow_unsigned: true` development opt-in. The signer is
 * `signature.signer_id`; `signed_by` is a top-level convenience that must
 * equal it when a signature is present (enforced below) — never a second,
 * divergeable source of truth.
 *
 * The signature is computed over the *canonical document without the
 * signature* — `{ id, version, rules }` — since a document cannot sign over
 * its own signature. That canonical hash is what `signature.payload_hash`
 * carries and what `Decision.policy_dependencies` ultimately pins.
 */
export const PolicySchema = z
  .object({
    id: z.string().min(1).describe("stable policy id"),
    version: z
      .string()
      .min(1)
      .describe("monotonic version; this is the string Decision.policy_dependencies cites"),
    rules: z
      .array(PolicyRuleSchema)
      .describe("evaluated in order; first decisive rule wins, over a structural deny default"),
    signature: SignatureSchema.optional().describe(
      "Ed25519 over the canonical document { id, version, rules }; required at the gate for an active policy",
    ),
    signed_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "actor_id of the signer; present iff signature is present, and equals signature.signer_id",
      ),
  })
  .superRefine((policy, ctx) => {
    if (policy.signature !== undefined) {
      if (policy.signed_by === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["signed_by"],
          message: "signed_by must be present when signature is present",
        })
      } else if (policy.signed_by !== policy.signature.signer_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["signed_by"],
          message: "signed_by must equal signature.signer_id",
        })
      }
    } else if (policy.signed_by !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signed_by"],
        message: "signed_by must be omitted when signature is absent (unsigned draft)",
      })
    }
  })
export type Policy = z.infer<typeof PolicySchema>
