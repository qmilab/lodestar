# ADR-0041: Kernel-adjudicated M-of-N quorum approvals

- **Status:** Accepted (implemented — #175, six slices on `feat/quorum-approvals`)
- **Date:** 2026-08-05
- **Deciders:** Nandan, Claude
- **Related:** #175, ADR-0010 (signed approvals — the forgery boundary this
  extends), ADR-0015 (the `ApprovalChannel` transport seam), ADR-0030
  (writer-free subpath — the precedent for read-side reachability),
  `docs/architecture/policy-kernel.md` (the non-goal restated by this ADR),
  `packages/core/src/schemas/policy.ts`,
  `packages/core/src/schemas/approval.ts`,
  `packages/policy-kernel/src/approval.ts`,
  `packages/policy-kernel/src/approval-signature.ts`,
  `packages/trace/src/approvals.ts`

## Context

The approval path is strictly single-signature: the first valid resolution
un-parks the action, and `pendingApprovals()` adds a `request_id` to its
`resolved` set on the first non-rejected grant/deny. A demand-pull integrator
needs **M-of-N quorum** and today ships designated-signer 1-of-N, explicitly
labelled *not* quorum — precisely to avoid crossing the line below.

**The invariant that forces this into the kernel.** The value of customer-held
approver keys is that no intermediary can manufacture authorization. If a
coordinating client (a hosted control plane, a desktop app, a CI collector)
gathers N signatures and submits one synthesized grant, the kernel records a
*single-approver* decision and "quorum" degrades into an unverifiable claim by
that intermediary. So: **the client accumulates; the kernel adjudicates.** A
collector must never attest that quorum was met.

Three facts about the shipped code shape the design:

1. **Each approver signs a distinct document.** The canonical resolution is
   `{ request_id, action_id, kind, approver_id, reason?, at }` — it carries
   `approver_id` and `at`. Quorum is therefore **N independent resolutions**, not
   N signatures over one blob. Cross-request replay is already impossible:
   `request_id` and `action_id` are inside the signed bytes.
2. **The read-side projection cannot verify.** `packages/trace/src/approvals.ts`
   states it *"deliberately does NOT re-verify signatures — it has no access to
   the operator's pinned approver keys (the correct boundary)"*, and instead
   trusts the guard's `guard.approval.signature_rejected@1` audit. Quorum
   counting cannot naively live there.
3. **The seam already exists and is documented as this one.**
   `ApprovalRequirementSchema` is described in-source as *"a thin wrapper today;
   it is the seam where multi-approver / N-of-M constraints attach"*, and
   `docs/reference/public-api.md` declares that schema family **"Additive growth
   only."**

Fact 3 corrects the framing this work was filed under. #175 assumed
`RequiredAuthority` would gain a count. It must not: `RequiredAuthority` is a
**predicate on a single approver** (`min_trust_baseline`,
`sensitivity_clearance`, `scope`) that is *max-merged* with the action's mapped
sensitivity by `withActionSensitivity()`. "Each approver must have count ≥ 2" is
meaningless, and merging counts is incoherent. Putting the threshold in its
documented seam instead makes the whole change **three additive-optional
fields** — permitted by the existing stability contract, not v0.2-lock surgery.

## Decision

Express the threshold as **`ApprovalRequirement.quorum`**, adjudicate it in a
pure `@qmilab/lodestar-policy-kernel` function that re-verifies every
constituent resolution, and surface the *already-verified* result to the read
side as a new authoritative event. Routing, rosters-as-UX, reminders, and queue
views stay with consumers, unchanged from #175's boundary.

### The load-bearing separation

Today `approval.granted@1` means two things at once: *"one approver granted"*
and *"the action is authorized to proceed."* At M=1 those coincide. **Quorum
separates them.**

- `approval.granted@1` — unchanged shape, unchanged meaning: **one approver's
  vote**.
- `approval.quorum_reached@1` — **new**: "M distinct verified approvals satisfy
  the threshold; here they are." This is the *authorization*, and it is what
  drives the Action Kernel's `resolve()` when `quorum ≥ 2`.

When `quorum` is absent or `1`, no new event is emitted and the first valid
grant is the authorization — **byte-identical to today** (compatibility ask #1).

### The eight questions, settled

| # | Question | Decision |
|---|---|---|
| **Q2** | Where does the threshold live? | **`ApprovalRequirement.quorum`** (positive integer), **per rule** — never in `RequiredAuthority`. Rules already match on level, so "L4=2, L5=3" is two rules; no per-level table is invented. |
| **Q6** | Which roster governs mid-collection? | **The roster in force when quorum is evaluated.** All M resolutions are re-verified against it at that moment. **No snapshot.** |
| **Q1** | Deny semantics? | **Any single valid deny is decisive** and rejects the action, regardless of grants collected. No deny threshold. |
| **Q7** | May the proposer count toward its own quorum? | **No, when `quorum ≥ 2`** — `Action.proposed_by` is excluded from the M. At `quorum` absent/`1`, no exclusion applies. |
| **Q3** | How is the eligible set expressed? | **The existing `required_authority` predicate only.** No groups, no roles, no roster schema change in v0. |
| **Q4** | Distinctness? | **By `actor_id`** — the only identity the kernel has. A later deny from an actor who earlier granted still vetoes (Q1 is evaluated chronologically and is terminal). |
| **Q5** | Validity window / replay? | **No new concept.** Reuse the existing `deadline` → `approval.expired@1` terminal path, plus an `at ≥ requested_at` sanity bound. |
| **Q8** | Accumulation model? | **Incremental**, one signed event per vote. No bundle submission. |

### Why each of the non-obvious ones

- **Q6 — verify-time roster.** The two failure directions are asymmetric. Pinning
  a snapshot at request time means a **revoked or compromised key still
  authorizes** every in-flight request; evaluating against the current roster
  means a **legitimate mid-collection rotation stalls one vote**, and the
  approver re-signs. Prompt revocation beats convenience, so we fail closed.
  This is also status-quo-preserving: `verifyApprovalSignature` already takes
  `authorizedKeys` from the caller at verification time, and a snapshot would
  require inventing a roster-snapshot format with its own signing and tamper
  questions. Re-verification is cheap (M is small; Ed25519 verify is
  microseconds) and it *is* the enforcement point.
- **Q1 — deny vetoes.** Quorum exists to make **approval** harder. Making denial
  harder inverts the safety property: a lone approver who spots an active attack
  could not stop it while the remaining approvers reach the threshold. Veto also
  preserves today's semantics exactly (one deny → rejected).
- **Q7 — four-eyes, but only at `quorum ≥ 2`.** Scoping the exclusion to real
  quorum keeps the single-approver path byte-identical (compatibility ask #1) and
  protects the *"solo workflow is never gated"* guarantee in
  `policy-kernel.md`. The solo path is unaffected either way — the **agent**
  proposes and the **developer** approves, different `actor_id`s — but scoping it
  removes the question entirely.
- **Q3 — predicate only.** `required_authority` already expresses eligibility
  ("2 approvers who each hold `repo:lodestar` and `secret` clearance") without a
  group registry. Groups would require a roster schema change and pull
  directory/RBAC concepts into OSS, which #175 explicitly assigns to consumers.
  **This makes the predicate load-bearing**: because it is the *only* expression
  of eligibility, adjudication must enforce it, which is why `evaluateQuorum`
  takes an approver-authority input as well as the key roster (see "Adjudication
  checks two orthogonal things").
- **Q8 — incremental.** A bundle submission recreates the precise anti-pattern
  this ADR exists to prevent: an intermediary assembling M signatures and
  handing over one artifact. Per-vote events keep every signature independently
  attributable and re-verifiable.
- **Q4 — the honest non-guarantee.** The kernel cannot detect one human holding
  two `actor_id`s; `authorized_keys` maps `actor_id → public_key` one-to-one, so
  two identities for one person is an **operator roster-hygiene** failure. This
  is documented as an explicit non-guarantee rather than papered over — the same
  honest-boundary discipline as the OS-sandbox and TS-boundary concessions.

### Where the code lives

Driven by compatibility ask #3 — quorum read state must be reachable **without**
the write-side runtime (importing `-guard` drags `wrap` + memory-firewall +
cognitive-core + harness).

| Layer | Package | Responsibility |
|---|---|---|
| Wire format | `@qmilab/lodestar-core` | `ApprovalRequirement.quorum?`, `ApprovalRequest.quorum?`, `ApprovalQuorumReachedPayloadSchema` + event-type constants |
| Adjudication | `@qmilab/lodestar-policy-kernel` | A **pure** `evaluateQuorum(request, resolutions, { authorizedKeys, approvers, proposedBy })` → `{ satisfied, required, approvers[], rejected[] }`. Per resolution: re-verifies authenticity via `verifyApprovalSignature`, **then** re-checks eligibility against `request.required_authority` (see below); dedups by `actor_id`; applies the deny veto and the proposer exclusion. No I/O, no clock. |
| Authority | `-guard` / `-guard-mcp` / `-runtime-core` | Holds the pinned roster, calls `evaluateQuorum`, emits `approval.quorum_reached@1`, drives `resolve()`. Remains the sole log writer. |
| Read side | `@qmilab/lodestar-trace` | Projects the authoritative record. |

`-policy-kernel` is importable without `-guard`, so the adjudication primitive
satisfies ask #3 directly.

### Adjudication checks two orthogonal things, and needs two inputs

Counting signatures is **not** sufficient. Authenticity and eligibility are
separate properties with separate inputs, and conflating them silently weakens
every quorum:

- **Authenticity** — "did an operator-pinned key sign this exact resolution?"
  Input: `authorizedKeys` (`actor_id → SPKI PEM`). Enforced by
  `verifyApprovalSignature`.
- **Eligibility** — "does this approver satisfy `request.required_authority`
  (`min_trust_baseline` / `sensitivity_clearance` / `scope`)?" Input: the
  approver's `Actor`. Enforced by the same predicate `authorizeResolution`
  already applies.

`authorizedKeys` cannot answer the second question, and **the signed resolution
carries no authority** — the canonical document is
`{ request_id, action_id, kind, approver_id, reason?, at }`, deliberately.
So `evaluateQuorum` takes an operator-supplied
`approvers: ReadonlyMap<actor_id, Actor>` alongside the key roster. **An approver
whose `Actor` is absent or falls short does not count toward the quorum** (fail
closed) — it is recorded in `rejected[]` with the shortfall reason, exactly as
`approverShortfall` phrases it today.

Without this, a rule reading `{ required_authority: { sensitivity_clearance:
"secret" }, quorum: 3 }` would be satisfied by *any three pinned approvers*. That
is not a corner case: `openApprovalRequest` runs every rule's authority through
`withActionSensitivity()`, which **always** stamps at least the action's mapped
sensitivity — so every `ApprovalRequest.required_authority` is non-empty, and the
gap would bite on every quorum rather than only on explicitly-stricter ones.

**This raises the predicate's status for the quorum path only.** Today the
eligibility check runs in the *writer* process against a **self-declared**
`Actor` (`lodestar approve` builds one from its own flags; `approve.ts:60`
labels it *"honest-mistake protection … not a cryptographic boundary (a hard
boundary needs signed actors / a trusted actor registry, deliberately
deferred)"*). Quorum cannot inherit that posture, because **Q3 makes
`required_authority` the sole expression of who is eligible** — if adjudication
does not enforce it, Q3's answer is hollow and "2 approvers holding
`repo:lodestar`" degrades to "2 pinned approvers". So for `quorum ≥ 2` the
authority source must be **operator-held**, never taken from the resolution or
from the resolver's self-declaration. Consistent with Q6, it is read at
**evaluation time**, so a demoted approver stops counting exactly as a revoked
key does.

The single-approver path is **unchanged** — still self-declared, still
honest-mistake protection, still byte-identical to today (compatibility ask #1).
This ADR closes the deferred-actor-registry gap for the quorum path only, and
does not pretend to close it generally.

**Authoritative vs. advisory on the read side.** `approval.quorum_reached@1` is
the verified assertion. A UI that wants to render in-progress "2 of 3" derives
that count from non-rejected grants in the projection — explicitly **advisory
progress, never authorization**. The gate never reads the progress count. This
mirrors the badges (advisory, never a gate) and `corroborationStrength` (feeds no
gate) precedents.

### Schema delta

Three additive-optional changes in `packages/core`, all permitted by the
`public-api.md` "additive growth only" contract:

1. `ApprovalRequirementSchema` → `quorum?: number` (int ≥ 1)
2. `ApprovalRequestSchema` → `quorum?: number` (so a read-side consumer knows the
   target without the policy document)
3. `ApprovalQuorumReachedPayloadSchema` + `APPROVAL_QUORUM_REACHED_EVENT_TYPE` /
   `_SCHEMA_VERSION` (`"1"`, versioned from birth)

No change to `RequiredAuthority`, `authorized_keys`, the canonical resolution
document, or `ApprovalOutcome`'s existing variants.

## Consequences

**Easier.** Quorum becomes expressible in a signed policy document without a new
trust root or transport. An integrator drops designated-signer 1-of-N for a
kernel-verified threshold. The read side renders "3 of 5" from OSS-verified truth
instead of its own tally. Every prior single-signature consumer is untouched.

**Harder / accepted.**

- **A held action now has two terminal shapes.** Hosts that assume "first grant →
  execute" must consult the quorum record when `quorum ≥ 2`. All three host paths
  (in-process resolver, MCP proxy, runtime gate) need the same update, and the
  proxy's deadline path must expire a *partially* satisfied request as a soft
  denial — an accumulated 2-of-3 that hits its deadline is **not** an approval.
- **Enabling quorum requires operators to pin approver *authority*, not just
  approver keys.** `authorized_keys` alone cannot satisfy a non-empty
  `required_authority`, and every request has one. A host with no authority
  source cannot satisfy a `quorum ≥ 2` rule — deliberately, since the
  alternative is a quorum that counts ineligible approvers. Note this is a new
  operator *input*, not a roster schema change: the `Actor` map is supplied to
  `evaluateQuorum` by the host, exactly as `authorizeResolution` already takes
  one, so `authorized_keys` keeps its shape and Q3's "no roster change" holds.
- **Mid-collection rotation stalls a vote** (Q6). Accepted as the fail-closed
  direction; must be documented for operators. The same applies to an approver
  demoted below the predicate mid-collection.
- **The floor-held case carries no quorum.** A hold forced by the trust-ladder
  floor has no matched rule and therefore no `ApprovalRequirement`, so it defaults
  to 1. An operator wanting quorum on floor-held actions writes an explicit
  `require_approval` rule. Documented, not silently surprising.
- **One human with two identities defeats the count** (Q4) — an operator
  responsibility, stated as a non-guarantee.

**Required before implementation — all shipped.** This was a design ADR; the
implementation landed as six slices (core wire format → the pure
`evaluateQuorum` → host wiring for `guard.wrap()` / the MCP proxy / the runtime
gate → the `-trace` projection → the probe → the stability ledger). Two things
the design did not anticipate turned up in the build and are recorded here:

- **The read-side queue had to change, not just gain a field.** `pendingApprovals`
  (and `lodestar approve list`) treated any genuine `approval.granted@1` as
  resolving its request — correct at the single-approver threshold, wrong at
  `quorum ≥ 2`, where a 3-of-3 hold would have dropped off both queues on the
  first vote and approvers 2 and 3 would never have seen it.
- **The eligibility input is a structural narrowing, not a full `Actor`.**
  `ApproverAuthority = Pick<Actor, "id" | "trust_baseline" |
  "sensitivity_clearance" | "authority_scope">` — the same deliberate idiom as the
  gate's `BackingBelief` / `CalibrationSnapshot`, and a full `Actor` stays
  assignable. Requiring an `Actor` would have made every host config fabricate
  `kind` / `display_name` / `created_at` that adjudication never reads.

Q8 was **confirmed against the shipped code**: no `ApprovalChannel` change was
needed. `fetch(ref)` still returns at most one resolution per poll; the host
verifies it, promotes it to its own `approval.granted@1`, and consumes it, so the
accumulated votes live in the **log**, not the transport. The one new hazard that
introduced — a quorum hold keeps polling while `consume` is deliberately
fire-and-forget, so a not-yet-deleted file would be re-promoted every pass — is
closed by deduping promotions on the canonical resolution hash.

It shipped with:

- A probe under `packs/lodestar-core/` pinning the adversarial invariants — at
  minimum: a collector-synthesized single grant **cannot** satisfy `quorum: 3`;
  M−1 valid grants do not un-park; a duplicate `actor_id` counts once; a deny
  after M−1 grants rejects; the proposer's own grant does not count at
  `quorum ≥ 2`; a revoked key's outstanding vote stops counting; **an
  authentically-signed grant from a pinned approver who does *not* clear
  `required_authority` does not count** (and an approver with no supplied
  `Actor` does not count — fail closed); and `quorum: 1`/absent is
  byte-identical to today.
- The new symbols declared in `docs/reference/public-api.md` **before**
  integrators pin them (compatibility ask #2).
- `docs/architecture/policy-kernel.md` non-goal restated (done in this ADR's PR).

## Alternatives considered

- **Threshold on `RequiredAuthority`** — rejected: category error (a per-approver
  predicate, max-merged with action sensitivity) and it would break the documented
  seam.
- **Per-`RequiredAuthority`-level threshold table (L4=2, L5=3)** — rejected: rules
  already match on level, so this adds a concept without adding expressiveness.
- **Roster snapshot pinned at request time (Q6)** — rejected: a revoked or
  compromised key would keep authorizing every in-flight request, and it invents a
  signed-snapshot format.
- **Separate deny threshold (Q1)** — rejected: inverts the safety property; a lone
  approver could not stop an in-progress attack.
- **Named approver groups/roles (Q3)** — rejected for v0: requires a roster schema
  change and pulls RBAC/directory into OSS, which #175 assigns to consumers.
- **Atomic bundle submission (Q8)** — rejected: recreates the
  collector-attests-quorum anti-pattern.
- **Counting quorum in the `-trace` projection** — rejected: the projection has no
  access to pinned keys by design, so it would either cross that boundary or count
  unverified grants.
- **Reusing `approval.granted@1` as the authorization at M>1** — rejected: it
  conflates "one approver granted" with "the action is authorized," which is
  exactly the distinction quorum introduces.
- **Adjudicating on signatures alone (no authority input)** — rejected: it counts
  *authentic* approvers rather than *eligible* ones, so any three pinned keys
  would satisfy a `secret`-clearance quorum. Because `withActionSensitivity()`
  always stamps a clearance floor, this would misfire on every quorum rule, and
  it would hollow out Q3.
- **Carrying the approver's authority inside the signed resolution** — rejected:
  self-attested authority is not authority. It would let a pinned-but-ineligible
  approver mint their own clearance, and it would change the canonical resolution
  document (breaking every existing signature).
- **Reading authority from the resolver's self-declaration (today's CLI
  behaviour)** — rejected for quorum: `approve.ts` already labels that
  honest-mistake protection rather than a boundary, and Q3 makes the predicate
  load-bearing. Left unchanged for the single-approver path.
