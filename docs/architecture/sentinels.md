# Sentinels — Design Doc

Batch 4, step 6. This is the design lock for the Sentinel base class and the
three first-party sentinels. The Batch-4 kickoff note
(step 6) names them; the roadmap
(`docs/roadmap.md`, Batch 4) specifies the three. The execution model was
already settled in **Q7 of `docs/architecture/reflection-pass.md`** — this doc
does not relitigate it, it builds on it.

Written 2026-05-30.

> **Status (current as of 2026-06-03).** The design below landed and still holds.
> The `Sentinel` base class, the `SentinelRunner`, and the three first-party
> sentinels (`low-confidence-action`, `suspicious-memory-origin`,
> `anomalous-tool-sequence`) ship in `@qmilab/lodestar-harness` and fold into the
> `coding-agent-safety` pack via the manifest's `sentinels` field. They remain
> **non-blocking**: the `arbitrate` hook that would let an alert gate an action
> still awaits the Policy Kernel (see "What's wired, what isn't"). Reader-facing
> summary: [sentinels & calibration](../concepts/sentinels-and-calibration.md);
> packaging details: [probe packs](../reference/probe-packs.md).

---

## Mental model

A **sentinel is a watcher over the event stream** that flags a suspicious
shape and emits a `sentinel.alerted@1` event. It is the opposite of a probe: a
probe is an offline adversarial test of an invariant; a sentinel is an online
tripwire over live events. It is also not reflection: reflection is invoked
deliberately and proposes lifecycle changes; a sentinel runs continuously and
only raises alerts.

What a sentinel does in practice:
- Is fed events one at a time, in append order, as they land (or replayed from
  the log)
- Accumulates whatever state its rule needs (a map of beliefs seen, a per-session
  window of executed tools, …)
- Returns zero or more findings for the event it was just shown
- The runner turns each finding into a `sentinel.alerted@1` event whose
  `causal_parent_ids` are exactly the events the sentinel read

What a sentinel is **not**:
- Not a blocker. It never back-pressures the Action Kernel (Q7). It flags a
  subject so a future, additive `arbitrate` hook can gate the *next* action that
  depends on that subject.
- Not a probe. It does not pass/fail; it alerts.
- Not reflection. It is a stream watcher, not a deliberate second look.

## Execution model (settled in Q7, restated)

- **Async tail of the event stream, single process.** Sentinels run over the
  event-log read stream. Worker-thread / out-of-process sentinels are deferred
  to whenever the cross-process event-log file-lock layer lands.
- **Non-blocking.** A sentinel cannot stop an action mid-flight. It emits an
  alert; the latency between "sentinel sees the event" and "an alert exists in
  the log" is the tail-loop latency (microseconds in-process, but not zero).
- **Alerts are events, not Observations.** Like `reflection.completed@1`, the
  `sentinel.alerted@1` payload is the event payload directly and is **not**
  registered in the observation schema registry. (The probe-run observation is
  registered because a probe run genuinely *is* an observation; an alert is a
  governance verdict.)

## What lives where

Core owns the wire format only:
`packages/core/src/schemas/sentinel.ts` — `SentinelAlertPayloadSchema`,
`SentinelSubjectSchema`, `SentinelSeveritySchema`, and the
`SENTINEL_ALERTED_EVENT_TYPE` / `SENTINEL_ALERTED_SCHEMA_VERSION` constants. No
I/O, no behaviour (core invariant #1).

The harness owns everything that runs:
`packages/harness/src/sentinel.ts` — the `Sentinel` base class, the
`SentinelRunner`, and tolerant event-payload projections.
`packages/harness/src/sentinels/` — the three concrete sentinels.
`packages/harness/src/sentinel-recorder.ts` — `eventLogAlertSink`, the injected
sink that appends alerts to the NDJSON log (mirrors the probe-run
`eventLogRecorder`).

## The alert wire format

```
sentinel.alerted@1 {
  alert_id            // unique per alert
  sentinel_name       // which sentinel fired
  rule                // which rule within it (a sentinel may have several)
  severity            // info | warning | critical
  subject { kind, id } // belief | action | decision | tool_sequence
  message             // always human-legible without decoding detail
  observed_event_ids  // the events read to reach this alert; == causal parents
  detail {…}          // rule-specific structured context; may be {}, never undefined
  detected_at
  rationale_id?       // reserved; v0 sentinels leave it unset
}
```

Design notes:
- **`subject.kind: "belief"` is load-bearing.** The eventual `arbitrate` hook
  scopes recent alerts to a candidate action's `belief_dependencies`. A sentinel
  that names a *belief* gates the next action that leans on it. This is why the
  suspicious-memory-origin sentinel emits one alert *per offending belief* rather
  than one per decision, and why the reflection schema already anticipates a
  `sentinel.alerted` naming a `belief_id`.
- **`detail` is an open record, not a discriminated union.** A new sentinel can
  ship without a core schema bump. The trade is that consumers must treat
  `detail` defensively; `message` exists so they never *have* to.
- **No optional payload fields except `rationale_id`.** The event-log writer's
  canonical hash treats `undefined` as `null` while `JSON.stringify` drops the
  key, so an `undefined` field makes the two disagree. Same discipline the
  firewall audit events follow. `rationale_id` is omitted entirely when unset,
  not set to `undefined`.

## Reading the stream: tolerant projections

Event payloads are `z.unknown()` on the wire, and hosts emit payloads of
varying completeness — the greenfield example emits a `decision.made` with no
`belief_dependencies`. So the sentinels read through loose projections
(`asActionView`, `asBeliefView`, `asDecisionView`, `asEvidenceSetView`) that
pull only the fields a rule needs and tolerate absence. These are deliberately
**not** the strict core schemas (`ActionSchema` et al.), which would reject a
partial-but-usable payload. A payload that lacks even the minimum is skipped,
not crashed on.

## The three sentinels

### 1. Low-confidence action (`low-confidence-action`)

Roadmap: alerts on actions at `required_level ≥ 3` backed by a belief at
`confidence < 0.5` or `truth_status: unverified`.

An action does not carry its backing beliefs; the chain is
`action.decision_id → decision.belief_dependencies → belief`. The sentinel
accumulates `decision.made` and `belief.adopted` and checks the backing when a
qualifying `action.proposed` / `action.approved` arrives. It dedupes by action
id so proposed-then-approved fires once. Subject: the **action**; the weak
belief ids are in `detail.weak_beliefs`. Threshold and level are configurable
(defaults 0.5 / 3). Scope is tight: it fires only when a *known weak* backing
belief exists — "action with no backing at all" is a separate concern.

### 2. Suspicious memory-origin (`suspicious-memory-origin`)

Roadmap: alerts when an `external_document`-sourced belief becomes a
`belief_dependency` of a Decision.

Evidence quality is not on the belief; it is on the `evidence.assessed` event
(the EvidenceSet's items carry `quality`), tied to a belief by the shared
`claim_id` on the subsequent `belief.adopted`. So the sentinel learns origin
from `evidence.assessed` + `belief.adopted` and fires at `decision.made` when
such a belief appears in the dependencies. A *contradicting* external document
is ignored — only evidence the belief rests on is a poisoning risk. Emits one
alert per offending belief (subject: **belief**), for the kernel-hook reason
above. This is the residual-path complement to the Round 5 auto-observation
gate, which already blocks `external_document` content from auto-promoting to
`supported`.

### 3. Anomalous tool sequence (`anomalous-tool-sequence`)

Roadmap: pattern-matches known suspicious sequences (e.g.
`fs.read → network.egress → fs.write`).

Watches executed actions per session (default `action.completed` — the phase
that means the side effect happened; configurable via `watchPhases`). Sequences
are matched as an **ordered subsequence** inside a bounded per-session window,
so interleaving a few benign calls does not evade detection, but the match must
**end at the current event**, so a sequence alerts once when it completes rather
than re-firing on every later call. Matched steps are then *consumed* so the
same read/egress prefix cannot be re-paired with a later write — a genuinely
fresh sequence still fires. The default `read-egress-write` pattern keys its
egress step off `blast_radius: "external"` (the contract-level "reaches outside
the project" signal) rather than guessing tool names. Subject:
**tool_sequence** (`id` = the final action's id). Severity defaults to
`critical` — a matched sequence maps onto a concrete attack.

## Memory: per-session state, freed on session end

All three sentinels are stateful, and a live tail runs indefinitely, so
unbounded state would be an OOM vector. Two rules keep it bounded:

- **State is partitioned by session.** Each sentinel keys its accumulators
  (the tool window; the decision/belief maps; the seen-claim and alerted sets)
  by `session_id`. The chains they track — `evidence → belief → decision →
  action` — are intra-session, and the in-memory stores are themselves
  session-scoped, so per-session partitioning loses nothing real.
- **The runner evicts on session end.** `Sentinel.onSessionEnd(sessionId)` drops
  that session's partition; the `SentinelRunner` calls it on any
  `sessionEndEventTypes` event (default `guard.session.ended` /
  `guard.session.failed`). So a session's footprint is reclaimed when it ends.

Cross-session provenance (a belief poisoned in session A surfacing in session B)
is deliberately **out of scope here**: it needs the persistent belief/claim
store (Batch 4 step 7) and is driven by the `tool-poisoning-cross-session` probe
(step 8). This in-memory tail watcher is correct for the session-scoped stores
that exist today.

Two related correctness rules the sentinels enforce, both audit-grade:
- **Stateless regex matching.** A caller-supplied `/…/g` matcher carries a
  mutable `lastIndex`; the tool-sequence sentinel resets it per test so matching
  is deterministic and cannot be evaded by regex statefulness.
- **No `undefined` in `detail`.** The runner normalises `undefined → null`
  throughout a finding's `detail` before it becomes a payload, so the event-log
  writer's `canonicalHash` (undefined → null) and `JSON.stringify` (drops the
  key) cannot disagree on re-read — the same hash-stability discipline the
  top-level payload fields hold by construction.

## What's wired, what isn't (v0 scope)

- **Wired:** the base class, the runner (push `observe` and batch `sweep`,
  session-end eviction), the three sentinels, and the event-log sink. A host can
  run sentinels over a live or replayed stream today and get alerts in the log.
- **Not wired (deliberately):**
  - The `arbitrate` hook that consumes alerts. Q7 describes it as small and
    additive; it lands when there is a policy to attach to it (Policy Kernel,
    Batch 4+). Until then, alerts are audit signal. Designed in
    [policy-kernel.md](./policy-kernel.md) ("The arbitrate hook").
  - Cross-session persistence (see above) — Postgres stores (step 7), forced by
    the `tool-poisoning-cross-session` probe (step 8).
  - A `lodestar harness watch` CLI. The sentinels are a library surface that
    hosts (Guard, the MCP proxy) wire in; a standalone watch command can come
    later without changing the contract.

## Packaging: folding sentinels into a pack (Batch 4, final step)

A probe-pack manifest declares the probes a pack ships; the last Batch 4 step
extended it to declare **sentinels** too, so the `coding-agent-safety` pack now
ships all three.

The decision that shaped this: a sentinel is referenced by a stable **id**, not
by a **file**. A probe is a `bun run`-able script the pack carries as a `file`
and the runner drives by exit code (harness invariant 6). A sentinel is the
opposite kind of thing — a stateful in-process class the `SentinelRunner`
instantiates and feeds events. There is no subprocess contract for it, so making
the manifest carry sentinel *source* would mean inventing a module-load-and-
instantiate contract for an in-process watcher. Instead the manifest lists the
sentinel **ids** it ships, and the harness resolves each id against a built-in
registry of first-party sentinels (`FIRST_PARTY_SENTINELS`, `id → factory`,
seeded with the three). The registry key equals each sentinel's own `name`, so
the manifest id, the registry key, and the `sentinel_name` on every emitted
alert are the same string.

Mechanics (the additive recipe in the harness CLAUDE.md "When extending the pack
format"):
- Core gains an optional `sentinels: [{ id }]` field on
  `ProbePackManifestSchema` — additive under spec `"1"`, so a manifest without
  it still loads (it defaults to `[]`). No spec-version bump.
- The loader resolves each id to its factory, returning
  `LoadedSentinel { id, create }`, and fails loudly (`ProbePackError`) on an
  unknown or duplicated id. Resolution does **not** construct the sentinel —
  loading stays side-effect-free, same as the probe path. A host turns the
  result into a runner: `new SentinelRunner(pack.sentinels.map((s) => s.create()))`.
- `lodestar harness list` prints the declared sentinels under the probes.

Deferred, deliberately: **per-pack construction-option overrides** (the
confidence floor, the suspicious-sequence catalogue — they stay in code with
sensible defaults) and **third-party / file-referenced sentinels** (a pack
shipping its own sentinel module). Both are refinements on the registry
resolution, not part of this step; v0 resolves first-party ids with default
options.

## Open questions deferred to later steps

- **De-duplication / alert fatigue across a long-running session.** Each sentinel
  dedupes within its own natural unit (action id, decision+belief pair, consumed
  tool steps). A global rate-limit / suppression policy is a calibrator-era
  concern, not v0.
- **Severity calibration.** Severities are hand-assigned. Once the Calibrator
  (step 9) has data, it may promote/demote rules — `severity` and the `info`
  level exist to make that possible.
