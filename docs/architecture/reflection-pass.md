# Reflection Pass — Design Doc

Batch 4, step 1. This is the design lock for the reflection pass that has been a stub in `packages/cognitive-core/` since v0.2. The kickoff note (`docs/architecture/batch-4-kickoff.md`) names reflection as load-bearing: the Round 5 auto-observation gate downgrades `external_document` and `model_inference` evidence to **reflection authority**, but reflection itself has no semantics yet, so the gate has no working downstream. The rest of Batch 4 hangs off the decisions made here.

This doc resolves the seven open design questions from the kickoff note. No code lands until each question has an answer recorded here.

Written 2026-05-27.

---

## Mental model

Reflection is a **second look across the event log, performed by the system itself, that proposes lifecycle changes without committing them.** It is cognitive machinery (lives in `packages/cognitive-core/`, not the harness), it never mutates belief state directly, and every proposal it emits goes through the Memory Firewall like any other transition.

What reflection does in practice:
- Re-examines a window of events (claims, beliefs, contradictions, decision outcomes) the agent has accumulated
- Spots cascades the synchronous ingest path missed: a newly-contradicted belief whose dependents should be re-examined; an `unverified` belief that now has independent corroboration; a decision whose post-action outcome contradicts the belief that motivated it
- Emits a `reflection.completed` event whose payload is a list of typed proposals
- Acts on those proposals only by calling the existing firewall API with `by_authority: "reflection"`

What reflection is not:
- Not a planner. It does not propose actions.
- Not a sentinel. It is invoked deliberately, not as a stream watcher. (Sentinels are answered separately in Q7.)
- Not a new transition authority. `"reflection"` already exists in `TransitionAuthority` (`packages/memory-firewall/src/transitions.ts:22`) and already gates several promotions.

Reflection's pre-existing footprint in the schema is the constraint set this design must respect: Round 5 auto-observation gate (`packages/cognitive-core/src/core.ts:99-121`), Cognitive Core invariant #5 ("Reflection never auto-commits"), Memory Firewall invariant #5 ("Every state transition produces an Explanation"). All locked. Reflection slots into the existing structure; it does not get to bend it.

---

## Q1. What triggers reflection?

**Decision: hybrid — on-demand entrypoint plus an opt-in tail watcher. No scheduled (cron-like) mode in v0.**

Concretely:

1. **On-demand**, via:
   - `lodestar reflect [--session-id <id>] [--since-seq <n>]` CLI subcommand
   - `Reflection.run({ since, scope })` programmatic call from `runGuarded`, `lodestar guard mcp-proxy`, or a probe
2. **Tail watcher** (optional, off by default), wired into the event-log read side. It triggers a pass when any of:
   - A `belief.transitioned` event records `truth_status → contradicted` (cascade trigger)
   - N `belief.adopted` events have accrued since the last `reflection.completed` for the partition (configurable batch size; default 16)
   - A `sentinel.alerted` event names a `belief_id` as subject (sentinel asks reflection to follow up)

Explicitly **out of scope for v0**: a scheduled sweep. That coupling belongs to the Calibrator (sequencing step 9), which will want periodic passes for its accuracy tables. Until the Calibrator lands, scheduled reflection is hypothetical and we should not build the cron knob.

Rationale: the hot-path option ("every `belief.adopted` fans into a reflection pass") makes reflection latency a function of belief volume and puts it in the kernel's critical path — a regression we have spent Batches 1-3 actively avoiding. On-demand + tail-async keeps reflection on the tail of the event stream where it belongs, while the batch and cascade triggers give us the "near-real-time without back-pressure" property the Round 5 gate needs to be useful.

---

## Q2. What is reflection's output schema?

**Decision: a new event type `reflection.completed@1`. Proposals are typed payload entries. State changes go through the existing firewall API and emit their own normal `belief.adopted` / `belief.transitioned` events afterwards.**

Two rejected alternatives and why:

- **"Append a `reflection_pass` evidence quality"** — the `EvidenceQuality` enum is closed by Round 5 design. Adding to it re-opens the auto-observation gate tuning, and conceptually it's wrong: reflection produces *proposals* about beliefs, not new categories of source evidence. Reflection is upstream of the evidence taxonomy.
- **"Update existing beliefs in place with a `reflection_revision` field"** — silently mutates state without a separate transition event. Violates Cognitive Core invariant #5 and Memory Firewall invariant #5. Non-starter.

Event payload sketch (the schema lands in `packages/core/src/schemas/event.ts` first per the standard rule):

```ts
// reflection.completed@1
{
  pass_id: string,
  triggered_by: "cli" | "tail_cascade" | "tail_batch" | "sentinel" | "programmatic",
  cursor: { from_seq: number, to_seq: number },
  observed_event_ids: string[],   // every event id the pass considered
  proposals: ReflectionProposal[]
}

type ReflectionProposal =
  | { kind: "claim_promotion",              claim_id, target_truth_status, evidence_id, rationale_id }
  | { kind: "belief_transition",            belief_id, axis, from_value, to_value, evidence_id?, rationale_id }
  | { kind: "belief_supersession",          old_belief_id, new_belief_id, rationale_id }
  | { kind: "decision_dependency_flagged",  decision_id, contradicted_belief_id, rationale_id }
  | { kind: "no_op",                        subject: { kind, id }, rationale_id }
```

`decision_dependency_flagged` is the proposal kind that closes the second Batch-2-deferred invariant ("contradicted belief flags dependent decisions"): when a belief transitions to `truth_status: contradicted` and a past Decision recorded it in `belief_dependencies`, reflection proposes flagging the Decision. Applying the proposal emits a `Revision` event with `target_type: "decision"` — the existing Revision schema supports this directly (see `packages/core/src/schemas/revision.ts:14`), no new persistence shape needed.

Two things to call out:

- **`no_op` is mandatory.** Without an explicit "reflection looked here and changed nothing", the harness cannot distinguish "reflection ran and was silent" from "reflection did not run." For audit, the negative result is load-bearing. Every belief the pass examined gets either a typed proposal or a `no_op`.
- **Applying a proposal emits a separate event.** When reflection acts on a `belief_transition` proposal, it calls `MemoryFirewall.transitionAxis({ ..., by_authority: "reflection" })` and the firewall emits its normal `belief.transitioned` event with the reflection pass's event id in `causal_parent_ids`. The transition event is the source of truth for state change; `reflection.completed` is the source of truth for "what reflection considered."

---

## Q3. What does reflection consume?

**Decision: diff since the last pass, scoped to the `{project_id, session_id}` partition, with an explicit `since_seq` cursor recorded on every `reflection.completed` event.**

Mechanics:
- The runner reads prior `reflection.completed` events from the partition's event log, picks the highest `cursor.to_seq`, and reads events strictly after that point
- The CLI flag `--since-seq <n>` overrides the cursor (useful for replay and probe scenarios)
- Default scope is partition-local. Cross-session reflection is **the forcing function** for the persistent `BeliefStore` (sequencing step 7 in the kickoff). Until that lands, cross-session reflection is N/A in v0.

Why the cursor model wins over alternatives:
- **"Whole event log"** doesn't scale and is non-idempotent — running reflection twice produces different proposals each time as the world drifts.
- **"Sliding window of last N events"** conflates "what reflection considered" with "what reflection has acted on." Two passes back-to-back would re-propose the same transitions.
- **"Per-session subset"** is the right scope, but without a cursor it is still non-idempotent across runs.

Cursor + per-partition scope gives us **idempotent passes**: re-running over the same `[from_seq, to_seq]` window produces the same proposals, by construction. Idempotence is what makes reflection probe-able and replay-safe.

---

## Q4. How does reflection cite?

**Decision: a reflection-derived proposal points to a newly-minted `EvidenceSet` whose items reference pre-existing observations / beliefs / events by id. The `EvidenceItem.quality` values are whatever they originally were. The reflection pass itself appears as a `causal_parent_id` on the resulting firewall transition event.**

What this means concretely:
- Reflection does **not** introduce a new `EvidenceQuality`. The lattice in `packages/core/src/schemas/claim.ts:62-69` is closed by Round 5; we do not extend it.
- Reflection produces a new aggregation of existing evidence. If the original observations were `tool_result` and `direct_observation`, the reflection-minted `EvidenceSet` carries items with those original qualities, and the existing `aggregateStrength` and auto-observation gate logic do the same work they always do.
- **Reflection cannot manufacture independence.** Items in the same `independence_group` count as one source no matter how many times reflection cites them. Five reflection-cited copies of the same memo do not satisfy Parallax — they are still one source.
- Reflection authority **unlocks the transition slot**; it does not invent corroboration.

Audit chain: the `reflection.completed` event id appears in the resulting `belief.adopted` / `belief.transitioned` event's `causal_parent_ids`. An auditor reads the transition, follows the parent id, finds the reflection pass, reads `observed_event_ids`, and reconstructs why the transition was authorised.

Open implementation note: the new EvidenceSet does need an `id` and the `assessed_by` field needs an actor. Use the reflection pass's `pass_id` as the EvidenceSet id namespace prefix and the reflecting actor id (typically the agent's own actor id) for `assessed_by`. This is a step-2 detail, not a step-1 decision.

---

## Q5. What's the invariant for "reflection alone cannot promote to `normal` retrieval"?

**Decision: the invariant is already enforced *structurally* by the existing transition table. The work that lands in Batch 4 is the probe that locks it in writing.**

Reading `packages/memory-firewall/src/transitions.ts:48-68`:

```ts
{ from: "hidden",     to: "restricted", authorities: ["user", "reflection"] },
{ from: "restricted", to: "normal",     authorities: ["user", "probe"] },
```

The `restricted → normal` promotion does **not** include `"reflection"` as an authority. The invariant is therefore not a runtime predicate buried in an `if`-statement — it is the absence of `reflection` from that row. There is no `if`-statement to bury it in, and adding one would be the regression.

Two things this implies:

- The Round 5 auto-observation gate downgrades to `reflection` authority on the **truth_status** axis (`unverified → supported`, allowed for reflection at line 34). The **retrieval_status** axis is gated independently: even with reflection authority on the truth axis, promotion to `retrieval_status: normal` requires `user` or `probe` authority. This is the orthogonal-axes design working as intended.
- Reflection **can** soft-promote `retrieval_status: hidden → restricted` (line 50). That is the only retrieval move reflection ever makes alone.

Batch 4 deliverable: a probe `reflection-cannot-promote-to-normal-alone` that:
1. Constructs an `unverified`+`restricted` belief
2. Drives a reflection pass with an `EvidenceSet` that, on the truth axis, would otherwise be strong enough
3. Asserts that the `reflection.completed` payload contains zero proposals targeting `retrieval_status: normal`
4. Asserts that if such a proposal *were* to be hand-crafted and submitted via the firewall API with `by_authority: "reflection"`, the firewall throws

Probe location: `packs/lodestar-core/` once step 4 of the kickoff sequencing lands.

---

## Q6. Probe pack format

**Decision: dual-source manifest. v0 of the schema supports two pack source types — `local` (filesystem path) and `npm` (published package). The v0 loader ships only the `local` resolver; `npm` resolution follows the first external pack. The manifest accepts both from day one so external authors can write to a stable schema before the npm loader is built.**

Manifest sketch (`lodestar.probe-pack.json` at pack root):

```json
{
  "name": "lodestar-core",
  "version": "0.2.0",
  "spec_version": "1",
  "source_type": "local",
  "coverage_areas": ["memory_firewall", "auto_observation_gate", "guard_contract"],
  "invariants": ["no_self_promotion", "parallax", "retrieval_gates"],
  "probes": [
    { "name": "memory-poisoning-basic", "file": "probes/memory-poisoning-basic.ts" },
    { "name": "auto-observation-gate",  "file": "probes/auto-observation-gate.ts" }
  ]
}
```

For `source_type: "npm"`, the loader will read the manifest from the published package's exports entry (`"./lodestar.probe-pack.json"`) and resolve probe files relative to the package root. Probes are TS in v0 (Bun-runtime); a future compiled-JS variant is a manifest-schema add, not a redesign.

Why this beats "local-only now, redesign later": the kickoff calls for a future-compatible format. Adding `source_type` to the schema costs one field; redesigning the schema after external packs ship is a breaking change. Carry the field now, build the npm resolver when a consumer demands it.

What's deliberately not in v0: signed manifests, public registry, version-range resolution. Sequencing-step 4 is repackaging the 14 existing probes against the local loader; everything else waits.

---

## Q7. Sentinel execution model

**Decision: async tail of the event stream. Sentinels do not back-pressure the Action Kernel. They emit `sentinel.alerted@1` events; the Kernel honours those alerts via a lookup during `arbitrate`, not via direct sentinel callback.**

Confirming what the roadmap already says: "sentinels emit `sentinel.alerted` events" — that wording implies non-blocking. This question existed in the kickoff to verify the wording before building.

Mechanics:
- Sentinels run in a single-process async iterator over the event-log read stream
- When a sentinel pattern-matches, it emits a `sentinel.alerted@1` event with `{ sentinel_name, subject: { kind, id }, severity, rationale_id }`
- The Action Kernel's `arbitrate` step (already exists; see `packages/action-kernel/`) queries recent `sentinel.alerted` events scoped to the candidate action's `belief_dependencies`. If a sentinel has alerted on a dependency, the configured policy applies (deny, require approval, downgrade trust level). The hook into `arbitrate` is small and additive.
- Worker-thread or out-of-process sentinels are deliberately deferred. v0's single-process event log makes in-process tail-async the right shape; cross-process coordination is a separate problem (the same one the cross-process event-log file-lock layer would solve).

Implication for blocking: a sentinel cannot **block** an action mid-execution. It can flag a belief so the **next** action depending on that belief is gated by the Kernel. The latency window between "sentinel sees the event" and "Kernel honours the alert" is bounded by the tail-async loop, which in single-process operation is microseconds — but it is not zero, and the design accepts that.

If a future use case demands true synchronous blocking, the right move is a Policy Kernel rule that pre-emptively requires explicit approval for the relevant action class, not a redesign of sentinel execution.

---

## Out of scope for this design doc

- **Concrete reflection strategy (rule-based vs LLM-driven).** v0 will land rule-based reflection for the contradicted-belief cascade case (well-defined, deterministic, probe-able). LLM-driven reflection — "look at this event window and propose what changed" — is a separate piece of work and deserves its own design pass, probably alongside the first Calibrator-driven scheduled pass.
- **Per-actor reflection policy.** Until typical sessions have more than one actor, "actor A may reflect, actor B may not" is hypothetical.
- **Reflection over imported memories (mem0 / Letta / Zep adapters).** Imports already enter at `restricted` retrieval per the adapter contract; reflection over imports follows the same authority rules as reflection over observations, so no new design is needed — but a dedicated probe (reflection over an imported claim that has since accumulated independent corroboration) is worth adding to `packs/coding-agent-safety/` once it exists.
- **Calibrator input contract.** Reflection's output schema is designed to feed the Calibrator (each `reflection.completed` enumerates the beliefs it considered and the proposals it made, both of which are the Calibrator's natural inputs). But the Calibrator's contract is its own deliverable.

---

## Acceptance criteria for the reflection-pass implementation (step 2 of Batch 4 sequencing)

When step 2 lands, all of the following must hold:

1. `lodestar reflect [--session-id <id>] [--since-seq <n>]` runs an idempotent pass
2. `reflection.completed@1` events appear in the event log with cursor, `observed_event_ids`, and typed proposals (including `no_op` where appropriate)
3. Applying a proposal goes through the existing `MemoryFirewall` API with `by_authority: "reflection"` and emits a normal `belief.adopted` / `belief.transitioned` event with the reflection pass id in `causal_parent_ids`
4. The 14 existing probes continue to pass — in particular, `auto-observation-gate` still passes (reflection does not change the gate's behaviour; it makes the gate's downgrade target actually functional)
5. New probe `reflection-cannot-promote-to-normal-alone` passes (Q5 invariant locked in writing)
6. New probe `contradicted-belief-flags-dependent-decisions` passes (the second Batch-2-deferred invariant from `docs/roadmap.md` lines 192-194, unblocked by reflection's Decision→Belief dependency cascade)

These six are the gate for moving from step 2 to step 3 of the Batch 4 sequencing. Steps 3-4 can run in parallel with step 2, per the kickoff note.

---

## What to read next (when stepping from this doc into code)

1. `packages/cognitive-core/src/core.ts` — where the auto-observation gate lives and where the reflection trigger hooks attach
2. `packages/memory-firewall/src/transitions.ts` — the table that already encodes Q5's invariant by absence
3. `packages/core/src/schemas/event.ts` — add `reflection.completed@1` here first per the standard rule
4. `research/probes/auto-observation-gate.ts` — the test reflection must continue to honour
5. `docs/architecture/v02-delta.md` Round 5 addendum (lines 340-386) and the deferred-items section (lines 509-523) — the auto-observation gate's contract and the explicit acknowledgement that reflection was the missing piece
