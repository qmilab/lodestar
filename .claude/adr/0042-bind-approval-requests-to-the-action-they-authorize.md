# ADR-0042: Bind approval requests to the action they authorize

- **Status:** Accepted (implemented — #179, PR #192 on `feat/approval-representation-adr-0042`)
- **Date:** 2026-10-11
- **Deciders:** Nandan, Claude
- **Related:** #179, PR #192, ADR-0010 (signed approval resolutions — the forgery
  boundary this extends), ADR-0015 (the `ApprovalChannel` transport seam and its
  `announce` sensitivity ceiling), ADR-0041 (quorum — the additive-optional
  precedent, and the promote-then-adjudicate host flow),
  `docs/reference/public-api.md`, `packages/core/src/schemas/approval.ts`,
  `packages/policy-kernel/src/approval-signature.ts`,
  `packages/trace/src/approvals.ts`, `packages/cli/src/commands/approve.ts`,
  `packages/action-kernel/src/kernel.ts`

## Context

*Loopjacking* (Kumar, arXiv:2609.21081) names two ways a human-in-the-loop
approval is hijacked: **(1) representation mismatch** — the reviewer is shown
less than, or something other than, the operation that will run — and **(2)
post-approval state substitution** — pending state is mutated after sign-off.

Lodestar defends (2) structurally: `ActionKernel.execute` runs the stored action
and a grant is bound to one `action_id`, never a fungible token. **(1) is open.**
`ApprovalRequest`, `PendingApproval` and `lodestar approve list` carry
`request_id`, `action_id`, the *rule's* `reason`, `required_authority`,
`deadline`, `quorum` — no tool, no inputs, no binding to either. An approver signs
an `action_id` they cannot inspect from the approval surface, and the signed
resolution `{ request_id, action_id, kind, approver_id, reason?, at }` says
nothing about *what* was approved.

Three facts about the shipped system shape the fix:

1. **The log is not authenticated per event.** ADR-0010's threat model already
   includes a local writer who can append the NDJSON log (`.approvals/` is its
   sibling under one `log_root`). Such a writer can plant a benign-looking
   `action.proposed` for a held action, so **any read-side rendering can be fed a
   story**. The only unforgeable artifact in the approval path is the approver's
   signature.
2. **The runtime gate rebuilds a held action from the log.** After a restart,
   `resume` reconstructs the parked action from the *latest*
   `action.pending_approval` and the request from `approval.requested@1`. "The
   stored action" is therefore sometimes the log itself.
3. **The precedent exists.** ADR-0041 added three additive-optional fields under
   `public-api.md`'s "additive growth only" contract and was accepted as *not*
   v0.2-lock surgery. This ADR follows the same rule.

So the fix cannot be "show the approver more" alone. The approver has to sign
**what they were shown**, and the host — the one party holding the action it is
about to run — has to refuse any authorization that names something else.

## Decision

### 1. The representation, and the hash that binds it

An action's **representation** is `{ action_id, tool, inputs, contract,
proposed_by }` — *which action, running which tool, with which inputs, under
which terms, as whom*. `proposed_by` is execution data, not provenance: the Action
Kernel hands it to the tool as `ToolContext.actor_id`.
`canonicalActionRepresentation(action)` builds it key-by-key (so an incidental
field can never enter it), JSON-normalizes `inputs` and `contract` (so the
in-memory value and its on-disk re-read hash identically), and
`actionRepresentationHash(action)` is the sha-256 hex of its `stableStringify`.
Both live in `@qmilab/lodestar-core` `src/crypto/` — a pure canonicalisation
primitive, the carve-out core already makes for signing.

It is **phase-independent**: the same hash comes out of the action at
`proposed`, `pending_approval` or `approved`, out of the `action.proposed` log
payload, and out of a parked action the runtime gate reconstructed. Excluded on
purpose: `intent`, `decision_id`, `proposed_at`, `phase`, `audit`, `approval` —
narrative, provenance and lifecycle that `execute()` never reads.

The `contract` is included so a forged `action.pending_approval` on the restart
path cannot keep the tool and inputs while stripping the preconditions that will
be revalidated, or lowering `data_sensitivity`.

**What runs is what was hashed.** Canonical JSON treats objects as unordered and
cannot express `-0`, so two values a tool could tell apart — a reordered object,
`-0` against `0` — can share a hash. The two cross-process hosts close that by
construction. Once the binding check passes, the MCP proxy and the runtime gate
execute the held action with its `inputs` and `contract` **replaced by their
canonical JSON re-parse**. The value the tool receives is then byte-for-byte the
value the approver's hash covers, and the representation hash is unchanged by the
replacement (canonical JSON is a fixed point).

`guard.wrap()` does not replace. In process, a tool schema may legitimately
produce non-JSON values such as a `Date`, and those are bound only through their
JSON form. That is consistent with §4's in-process posture.

### 2. (a) `ApprovalRequest` gains two additive-optional fields

- `action_type?: string` — the held action's `tool`, verbatim (the namespaced
  name a host registered: `mcp.<server>.<tool>`, `runtime.<name>`, or a native
  tool name).
- `inputs_hash?: string` — `actionRepresentationHash(action)`, 64 lowercase hex.
  The name is #179's. It hashes the whole representation rather than only the
  inputs, as §1 defines.

`openApprovalRequest` stamps both, so every host that opens a request through it
emits them with no host-specific code. Each is **omitted entirely when absent**
(never `undefined`, never `null`), so a request already in a log, or built by a
consumer who leaves them out, parses and behaves exactly as before and its
canonical hash does not move. That is "additive growth only" as the ledger
states it, and the ADR-0041 shape. No `schema_version` bump: the request schema
is not `.strict()`, so a v0.6 reader strips the new keys.

**The hash is not secret.** It is unsalted, so anyone holding the request can
confirm a *guess* of low-entropy inputs. It travels only where the request
already travels: the host's own log, and the advisory `announce`, which is
already withheld above the channel's sensitivity ceiling (ADR-0015 §2).
`action_type` now rides `announce` too. It is operator configuration, not
content.

### 3. (b) `inputs_hash` joins the signed resolution, optionally

The canonical resolution document becomes
`{ request_id, action_id, kind, approver_id, reason?, inputs_hash?, at }`.

**Compatibility rule:** `inputs_hash` is added to the canonical document only
when present, built key-by-key like `reason`, so `stableStringify` reproduces the
pre-ADR bytes for every resolution without it. Every existing signature
therefore verifies unchanged.

The field is carried by `ApprovalResolutionSchema`, which is `.strict()` and so
must declare it. It is also carried by the promoted `approval.granted@1` /
`approval.denied@1` payloads, so a promoted event stays **self-verifying**: a
quorum record's `granted_event_id` re-verifies against the bytes the approver
signed. Finally it is carried by `ApprovalOutcome`'s granted/denied variants, so
a host threads it from resolution to promoted event without a side table.

**Optional and verify-if-present, not required.** Requiring it would break every
approval tool and HTTP approval service built against v0.6 the moment a host
upgrades. The downgrade is not the attacker's to choose:

- `inputs_hash` is inside the signed bytes, so stripping it from a bound
  resolution breaks the signature.
- The capability signal — the request's own `inputs_hash` — cannot be shadowed
  without detection. An appended unbound copy of a bound request is a
  *conflicting* `approval.requested` record. The CLI flags it `MISMATCH` and
  refuses to sign (§5), and the runtime gate refuses to resume over it (§4).

What remains is the approver's own choice to use pre-0.7 tooling, which this ADR
states as a non-guarantee. Mixed versions work in both directions:

- A new approver tool binds only when the request carries an `inputs_hash`, and
  only a new host writes one. So an old host never receives a field its strict
  schema would reject.
- An old tool's unbound resolution is accepted by a new host, at today's
  `action_id`-only binding.

**Forward compatibility is a declared boundary, not "additive".** An unbound
resolution is byte-identical to today. A *bound* one is, by construction, not
verifiable by a pre-0.7 verifier: an old schema strips `inputs_hash`, rebuilds
the pre-ADR document and rejects the signature. It fails closed — the vote is
treated as unverifiable, never accepted. The capability boundary is the request's
`inputs_hash`: only a ≥ 0.7 host writes one, and approver tooling binds only when
it is present, so in a forward-moving fleet a bound vote only ever meets a ≥ 0.7
verifier. Rolling a host back to 0.6 mid-hold stalls its bound votes to the
deadline, and pre-0.7 offline log verifiers reject them. The ledger row for the
signed document records the boundary as "since 0.7.0".

A host-level opt-in that refuses unbound resolutions is the natural next step
once approver tooling has caught up. It is deferred.

**Semantics: sign what you saw.** The approver's tooling computes `inputs_hash`
from the record it *rendered*, not by copying the request's field. A planted
`action.proposed` therefore yields a hash the host will not accept. §5 covers the
CLI.

### 4. (c) Hosts check the binding before promotion, and fail closed

Before any resolution is **promoted**, each of the three hosts recomputes
`actionRepresentationHash` from **the action it will execute**. Promotion means
written to the host's log as `approval.granted@1` / `approval.denied@1`, or
applied through `resolve()`. "The action it will execute" is the in-memory parked
action, or the one reconstructed from the log on the runtime gate's resume path.
The host refuses the resolution unless all of these hold:

- the request's `action_type`, when present, equals the action's `tool`;
- the request's `inputs_hash`, when present, equals the recomputed hash, so the
  request still describes the held action;
- the resolution's signed `inputs_hash`, when present, equals the recomputed
  hash, so the approver authorized *this* representation.

The predicate is one shared function, `representationMismatch(action, request,
resolution?)`, in `@qmilab/lodestar-guard` beside the ADR-0041 host vocabulary.
Each host calls it at **every** promotion site:

- the single-approver log path and channel path;
- the quorum path's channel promotion and its log-vote scan;
- `guard.wrap()`'s resolver outcome and each collected quorum vote.

The probe asserts it per host, not by symmetry. A deny bound to a different
representation is refused too: it is not a resolution of *this* hold, and
refusing it only defers rejection to the deadline.

**The runtime gate's resume path recovers terms it can trust.** Today `resume`
rebuilds the parked action from the *latest* `action.pending_approval` (cast, not
parsed) and the request from the *latest* `approval.requested`. Both are
latest-wins over an unauthenticated log, so one appended shadow record could swap
the operation, or strip `quorum`, weaken `required_authority` or move the
`deadline` behind an authentic vote.

The fix: the gate schema-parses every record for the action. If the log holds
records that **disagree** — more than one distinct representation among its
`action.pending_approval` records, or more than one distinct canonical payload
among its `approval.requested` records — the gate refuses to resume and rejects
the action. That is fail closed.

The rule is order-independent: an appending writer cannot remove the genuine
record, so a shadow always shows up as a conflict, whichever record came first.
An attacker who can *rewrite* the log, rather than append to it, defeats restart
reconstruction wholesale. That is outside this ADR; ADR-0025's durability already
trusts the log's contents.

Two backstops add defence in depth; neither is the boundary:

- `ActionKernel.resolve()` refuses an outcome whose `inputs_hash` differs from
  the action's representation. This parallels the existing `action_id` binding:
  approval is per-representation, not only per-id.
- `evaluateQuorum` rejects a vote whose signed `inputs_hash` differs from the
  request's, under the **existing** `not_for_request` code. A log re-adjudicator
  then reaches the host's answer, and the stable `QuorumRejectionCode` union does
  not grow.

**What the host writes on a mismatch.**

- **MCP proxy and runtime gate.** The resolution is not promoted. It is recorded
  as `guard.approval.signature_rejected@1` (shape unchanged; `reason` begins
  `representation mismatch:` and names both hashes). A channel resolution is
  consumed, because it can never become valid. A log event is skipped by id. The
  hold stays parked to its deadline and ends `approval.expired@1`, the existing
  soft denial.

  Reusing the event is deliberate. Its read-side function is "refused at the
  promotion boundary; do not count it as a resolution", and `pendingApprovals`
  and `lodestar approve` already exclude it precisely: a log-sourced refusal names
  the event via `rejected_event_id`. A new event type would leave every existing
  read-side consumer counting a refused log grant as resolving its request — the
  forged-grant-masks-a-pending-hold bug, reintroduced. The schema's doc widens to
  say the event now covers a binding failure as well as a bad signature.
- **`guard.wrap()`.** In-process there is no deadline and no log or channel
  source, so nothing needs read-side exclusion. A refused single-approver outcome
  expires the request at once: `approval.expired@1`, then `action.rejected`
  whose audit detail names the mismatch. That is the same in-process soft-denial
  terminal the quorum shortfall already uses. A refused quorum vote is not
  promoted, and the shortfall expiry names it.

  In-process the check is a **consistency assertion**, not a boundary against code
  in the same realm. It is the posture ADR-0010 already takes for the in-process
  resolver. It catches a held action whose live inputs were mutated during the
  hold. The window between apply and the tool body belongs to the Action Kernel; a
  deep-freeze of inputs at propose is a separate follow-up.

### 5. (d) What `lodestar approve list` renders, and when `grant` refuses

From the project log it already reads (`EventLogReader`), for each pending
request, the CLI finds every `action.proposed` and `action.pending_approval`
record for the request's `action_id`.

**Every log-sourced string is untrusted terminal input.** That covers ids,
`reason`, the tool name, timestamps, scopes and approver names, not only the
inputs. Each is rendered through one escaping function, so no control, bidi or
invisible code point reaches the terminal raw. A forged entry can add a line to
the queue; it cannot rewrite another entry's lines. The CLI then renders:

- **`tool:`** the record's tool.
- **`inputs:`** the canonical inputs: sorted keys, pretty-printed JSON, **never
  truncated**. Truncation is itself a representation gap, because the payload can
  hide after the cut. Invisible, bidi-control and C1 code points are escaped as
  `\uXXXX`, so the terminal shows exactly what the hash covers. JSON already
  escapes C0 controls, ANSI escapes included.
- **`contract:`** the full contract, rendered the same way as the inputs —
  scope, preconditions and their expected values included, since the hash binds
  all of it.
- **`as:`** the `proposed_by` actor.
- **`binding:`** one of:
  - `verified` — the request's `inputs_hash` equals the hash recomputed from a
    single consistent record, and its `action_type` equals that record's tool;
  - `UNBOUND` — a legacy request with no `inputs_hash`; rendered, but not
    verifiable;
  - `MISMATCH`, listing each problem:
    - the request's hash differs from the record;
    - `action_type` differs from the tool;
    - the action has records with *different* representations (a planted
      `action.proposed` or `action.pending_approval`);
    - the request id has `approval.requested` records that disagree;
    - no record is found.

The lookup and the safe rendering are one pure function in
`@qmilab/lodestar-trace`, `approvalRepresentation(events, request)`. The CLI
prints its output verbatim, and a viewer or third-party approval UI renders the
identical thing. `pendingApprovals` surfaces `action_type` and `inputs_hash`
verbatim (`PendingApproval` grows additively).

`approve grant` refuses (new exit code `6`) unless the binding is `verified` or
`UNBOUND`. A `MISMATCH` is never signed. On a verified request, the grant signs
`inputs_hash` set to the hash recomputed from the record it rendered.

The approving act can also acknowledge the display explicitly.
`approve list` prints the representation hash and a ready-to-run
`grant … --expect-hash <prefix>` command, and `grant --expect-hash` refuses
unless the verified hash starts with that prefix. The flag is optional, so
existing scripts keep working.

`approve deny` binds the rendered hash when the binding is `verified`. Otherwise
it signs **unbound**, with a warning naming the problems, rather than assert a
representation the approver was never shown. Denial is the safe direction, and an
unbound deny is the legacy shape every host accepts.

These flags are **advisory**, because the log they read is unauthenticated. The
boundary is §4. The CLI's job is to show the approver the operation and to sign
exactly what it showed.

### 6. The probe

`approved-action-cannot-be-substituted`, appended last in the `lodestar-core`
manifest, pins each property below. Every host case also runs a control: the
same vote, correctly bound, executes.

- **All three hosts** (`guard.wrap()`, the MCP proxy, the runtime gate): a
  validly signed grant from a pinned, eligible approver whose `inputs_hash` names
  a different representation is refused at promote. It is not promoted, the tool
  body never runs, and the proxy and gate audit it.
- **A request that no longer matches its held action** is refused: the runtime
  gate resuming over a planted `action.pending_approval` or a planted
  `approval.requested` that strips `quorum`, and an in-process held action whose
  inputs were mutated during the hold (`guard.wrap()` and the proxy).
- **What runs is what was hashed:** the proxy and the runtime gate hand the tool
  the canonical inputs.
- **The approver-visible rendering** re-parses to the canonical stored inputs and
  re-hashes to the request's `inputs_hash`. A bidi control and an ANSI escape
  planted in a log-sourced field render escaped. A planted conflicting
  `action.proposed` is flagged `MISMATCH`.
- **The kernel backstop and the `evaluateQuorum` backstop** each refuse a
  mismatch.
- **Byte-identity:**
  - a resolution without `inputs_hash` has the pre-ADR canonical hash;
  - an unbound legacy resolution still resolves a bound request on the
    single-approver path and on the quorum path.

## Consequences

**Easier.**

- An approver sees the tool, the full canonical inputs and the contract on the
  surface they approve from.
- Loopjacking's representation mismatch is closed for every approver whose
  tooling binds the hash. A planted `action.proposed` is flagged `MISMATCH` and
  never signed by the CLI. If other tooling signs the planted representation, the
  host refuses the vote.
- A refused binding leaves a durable forensic record that names the hash the
  approver was shown and the hash of what would have run.
- The runtime gate's resume path gains checks it never had. A planted
  `action.pending_approval` can no longer swap the operation that runs, and a
  planted `approval.requested` can no longer strip a quorum.

**Harder / accepted.**

- **The guarantee is conditional on binding.** An unbound resolution is still
  accepted, at today's `action_id`-only strength. This is a stated
  non-guarantee until the deferred "require binding" opt-in lands.
- **An inconsistent log blocks a grant.** `approve grant` refuses on any
  `MISMATCH`, including one a hostile writer planted. The operator denies and the
  agent re-proposes. A local writer could already deny service in many ways; this
  adds a conservative one rather than a permissive one.
- **Pre-0.7 verifiers cannot verify bound resolutions.** They fail closed (§3).
  The new CLI binds only when the request carries a hash, so a forward-moving
  fleet keeps working. A rollback mid-hold stalls bound votes to the deadline.
- **Held actions in the proxy and the runtime gate execute with canonically
  ordered inputs.** A tool that reads meaning from object key order sees sorted
  order after an approval hold. That is the price of the approver's view and the
  executed value being the same bytes.
- **Every new request is two fields larger,** and the hash can confirm guesses of
  low-entropy inputs to anyone who already sees the request (§2).
- Three hosts, the read side and the CLI all grow. The shared predicate and the
  per-host probe cases keep them from drifting.

**Not addressed.**

- The in-process mutation window between `resolve()` and the tool body (§4). It
  belongs to the Action Kernel.
- Per-event authentication of the log. The log stays unauthenticated, and the
  host-side recompute is what makes the binding sound without it. An attacker who
  can *rewrite* the log, rather than append to it, defeats the runtime gate's
  restart reconstruction wholesale. That is pre-existing, and outside this ADR.

## Alternatives considered

- **`inputs_hash` = the `action.proposed` envelope's `payload_hash`** (#179's
  sketch) — rejected. That hash covers `phase`, `audit` and timestamps, which
  change between propose and promote, so a host cannot recompute it from the
  action it is about to run. It could only compare remembered values, and on the
  runtime gate's restart path the remembered value comes from the same log a
  local writer can extend. The check must hash what will run.
- **Hash the inputs alone** — rejected. A same-inputs, different-tool
  substitution, or a restart-path record that strips preconditions or changes the
  acting `proposed_by`, would still match.
- **An insertion-order (unsorted) hash, so key order is bound without touching
  execution** — rejected. Every approval surface would have to preserve JSON key
  order, which several languages' decoders do not, and `-0` would still collapse.
  Executing the canonical form binds both and stays portable.
- **A signed commitment to the request terms (`quorum`, `required_authority`,
  `deadline`) inside the resolution** — rejected for now. Conflict detection
  already defeats an appending writer on the only path that reads terms back from
  the log (the runtime gate's resume), without growing the signed document again.
- **Copy the full inputs into the request** — rejected. It duplicates possibly
  sensitive content into a second event and into the `announce` egress. The hash
  binds without copying, and the inputs are already in `action.proposed`.
- **Require `inputs_hash` on every resolution now** — rejected for v0.7. It
  breaks every existing approver tool on host upgrade. Deferred as an opt-in.
- **A new audit event type for a binding refusal** — rejected. Existing read-side
  consumers would count a refused log grant as resolving its request.
- **Promote a mismatched vote but not count it, like an ineligible vote
  (ADR-0041)** — rejected. The log would say "alice granted" this request when
  alice approved a different operation. Eligibility is about *who*; this is about
  *what*.
- **Enforce only in the CLI / read side** — rejected. The log is not
  authenticated, and only the host holds the action it will run.
- **A keyed commitment (HMAC under a host secret) to stop guessing low-entropy
  inputs** — rejected. The approver must recompute the binding from what they are
  shown. A host secret would make the approver trust the host's hash, which is
  the thing being checked.
