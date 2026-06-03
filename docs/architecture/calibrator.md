# Calibrator — Design Doc

Batch 4, step 9 — the last piece. This is the design lock for the
`Calibrator` and the `confidence-drift` probe that forces it. The Batch-4 kickoff
note (step 9) places it last
("needs accumulated event-log data to validate"); the roadmap
(`docs/roadmap.md`, Batch 4) specifies it as *"`Calibrator` that consumes
the event log and produces per-class accuracy tables (ECE, Brier score)
suitable for the calibration paper drafts"* and names the probe:
*"`confidence-drift` — belief confidence diverges from observed outcome
over a sequence of actions; the calibrator should flag this as a per-class
miscalibration."*

This doc does not relitigate the locked v0.2 schema. The hook it builds on
already exists: `Belief.calibration_class` (`packages/core/src/schemas/belief.ts`)
was added for exactly this consumer, and its docstring states the mission
verbatim — *"The Calibrator measures empirical accuracy per
calibration_class and can require the Policy Kernel to downweight
confidence in classes where the agent is historically overconfident."*

Written 2026-05-31.

> **Status (current as of 2026-06-03).** The design below landed and still holds.
> The `Calibrator` / `calibrate()` API, the metrics (ECE / Brier / calibration
> gap), the sample resolver (both signals), the markdown formatter, and the
> `confidence-drift` probe that drives it end-to-end all ship in
> `@qmilab/lodestar-harness`. It remains **measure-only**: the
> `calibration.computed@1` wire format, a `lodestar harness calibrate` CLI, and
> the Policy-Kernel feedback loop that would act on a flagged class are still
> deferred (see "What's wired, what isn't"). Reader-facing summary:
> [sentinels & calibration](../concepts/sentinels-and-calibration.md).

---

## Mental model

A **calibrator is an offline read over the event log** that asks one
question: *when the agent said it was p confident, was it right p of the
time?* It is the third harness surface and the mirror image of the other
two. A **probe** is an offline adversarial pass/fail test of an invariant.
A **sentinel** is an online tripwire that alerts on a live event shape.
A **calibrator** is an offline statistical audit that scores how well
stated confidence matched realised outcome, grouped by `calibration_class`.

It does not block, it does not alert, it does not pass/fail. It reads a
slice of the log, pairs predictions with outcomes, and returns a
`CalibrationReport`: per-class ECE / Brier / calibration-gap tables plus
the reliability bins a calibration paper's reliability diagram is drawn
from. A class whose stated confidence is statistically out of line with
its realised accuracy is **flagged** — that flag is the calibrator's only
verdict, and it is advice, not enforcement.

What a calibrator is **not**:

- Not a blocker and not a hot-path component. It runs after the fact over
  a recorded log. Nothing waits on it.
- Not a belief mutator. It never writes a revision or transitions a
  belief. Acting on a flag (downweighting a class's confidence) is the
  **Policy Kernel's** job, deferred exactly like the sentinels' consuming
  `arbitrate` hook. The calibrator only measures.
- Not a time-series drift detector. "Drift over a sequence of actions" is
  the *input scenario* the `confidence-drift` probe constructs; the
  *output* the roadmap asks for is per-class miscalibration, which an
  aggregate ECE / gap over that class captures. A temporal trend view is
  noted as a future extension, not v0.

## The unit of calibration: a belief, binned by class

The atomic prediction is a **belief's `confidence`** (a probability in
[0, 1]). The grouping key is its **`calibration_class`** (a free-form
string the cognitive core stamps on every belief). The realised label is a
binary **`correct ∈ {0, 1}}`** drawn from the world. One
`(confidence, correct)` pair, tagged with its class, is a
`CalibrationSample`. The calibrator bins samples by class and scores each
class.

Why the belief and not the decision or the action: `calibration_class`
lives on the belief, the schema was built for this, and "is the agent
well-calibrated" is fundamentally a question about its *beliefs*. A
decision or an action inherits its trustworthiness from the beliefs that
justified it.

## What is a "realised outcome"? Two signals, both honest

A belief's correctness is only knowable once the world says something
about it. Two distinct signals in the event log carry that, and the
calibrator resolves samples from both (each configurable on/off):

### Signal A — action outcome (the roadmap's "sequence of actions")

The epistemic chain is `Belief → Decision → Action → Outcome`. A decision
records the beliefs it leaned on (`decision.belief_dependencies`); an
action records the decision that drove it (`action.decision_id`); the
action's realised result is its outcome. So for every action with a
realised result, each *distinct* belief the deciding decision depended on
gets one sample (a repeated id in the dependency list still counts once —
the schema does not enforce uniqueness):

- `correct = 1` if the action succeeded, `0` if it failed.

The realised result is read tolerantly from **two forms**, because hosts
differ:

1. An explicit `Outcome` event (`outcome.observed` / `action.outcome`,
   already tolerated by `@qmilab/lodestar-trace`'s `projectChain`) whose
   `result` is `success` → 1 or `failure` → 0.
2. Failing that, the action's **terminal phase** as emitted by Guard and
   the MCP proxy today: `action.completed` → 1, `action.failed` → 0. The
   phase is read from `payload.phase`, falling back to the event *type*
   when the payload omits it (a minimal host may emit a bare
   `action.completed` / `action.failed` whose type already encodes the
   terminal phase) — tolerant reading, same as the sentinels.

`partial` / `unknown` outcomes and `rejected` actions are **not labels** —
a policy rejection is not evidence the belief was wrong, and a partial
result is not a clean binary. They are skipped, not coerced. An explicit
`partial` / `unknown` outcome also *suppresses* a terminal phase on the
same action: the host declared the result inconclusive, so the phase
cannot quietly stand in for it.

A belief used across N actions yields N samples. That is the point: a
belief class held at high confidence whose actions keep failing
accumulates N divergent samples — this *is* "confidence diverges from
observed outcome over a sequence of actions."

### Signal B — truth-status transition (belief-native)

The firewall emits `firewall.belief.transitioned` when a belief's
`truth_status` axis moves. A post-adoption transition is the world
revising the belief:

- `→ supported` → `correct = 1`
- `→ contradicted` → `correct = 0`
- `→ superseded` / `→ unverified` are not labels (a supersession replaces,
  it does not adjudicate truth).

Confidence and class come from the belief's `belief.adopted` record
(transitions carry only `belief_id`), so a belief with no adoption event
in the analysed slice is skipped.

### Why both, and why that is not double-counting

The two signals are independent evidence about the same prediction: "the
firewall says this belief turned out contradicted" and "three actions that
leaned on it failed" are *different observations of the world*, not two
copies of one. Each is one sample. A consumer that wants only one lens
sets `outcomeSources` accordingly; the `confidence-drift` probe drives a
single source so its assertions are exact. Each sample records its
`source` so a report can break the pooled class down if needed.

## Excluded by construction: synthetic-authority beliefs

A belief with `authority: "synthetic"` is a probe artefact and "never
affects real reasoning" (`belief.ts`). Calibrating real classes on
synthetic beliefs would let harness runs pollute a live system's
calibration — the same hazard the firewall's
"synthetic-probe evidence cannot adopt a real belief" invariant guards
against. So the calibrator **excludes `authority: "synthetic"` by
default** (`includeSyntheticAuthority: false`). The `confidence-drift`
probe models *real* overconfident beliefs (authority `inferred`) and
plants one synthetic-authority belief purely to assert it is excluded.

## Metrics, per class

For a class with samples `{(pᵢ, yᵢ)}`:

- **`n`** — sample count.
- **`mean_confidence`** — `mean(pᵢ)`.
- **`empirical_accuracy`** — `mean(yᵢ)`, the realised positive rate.
- **`brier_score`** — `mean((pᵢ − yᵢ)²)`. 0 is perfect; lower is better.
- **`ece`** — Expected Calibration Error. Partition [0, 1] into `bins`
  equal-width bins (default 10). For each non-empty bin *b*:
  `gapᵦ = |mean_confidenceᵦ − accuracyᵦ|`; weight by `nᵦ/n`.
  `ece = Σᵦ (nᵦ/n)·gapᵦ`.
- **`calibration_gap`** — signed `mean_confidence − empirical_accuracy`.
  `> 0` is **overconfident** (the dangerous direction); `< 0`
  underconfident.
- **`overconfident`** — `calibration_gap > 0`.

A class is **flagged** when it has enough data *and* is materially off:

```
flagged  ⇔  n ≥ min_samples ∧ ( ece ≥ ece_threshold ∨ |calibration_gap| ≥ gap_threshold )
```

Defaults: `min_samples = 5`, `ece_threshold = 0.1`, `gap_threshold = 0.1`.

The `min_samples` guard is load-bearing: flagging a class off two samples
is noise, and a false "you're miscalibrated" is its own kind of
miscalibration. ECE and the gap are kept as *separate* triggers because
they catch different shapes — within a class of near-constant confidence
(the `confidence-drift` scenario) ECE collapses toward the gap, but a
class with a wide confidence spread can carry a near-zero gap while still
being badly calibrated bin-to-bin, and ECE catches that.

The report also computes a pooled **`overall`** metric block across all
included samples (the headline number for the paper) and lists the
`flagged_classes`.

## What lives where

The harness owns all of it. No core schema change in v0:

`packages/harness/src/calibration/`
- `metrics.ts` — pure functions (`brierScore`, `expectedCalibrationError`,
  `reliabilityBins`, `computeMetrics`). No I/O, no event knowledge;
  unit-tested against hand-computed values.
- `samples.ts` — `resolveSamples(events, options)`: event stream →
  `CalibrationSample[]`. Reads through the same tolerant projections the
  sentinels use (`asBeliefView`, `asDecisionView`, `asActionView`) plus
  two local views for firewall transitions and `Outcome` events. Skips a
  payload that lacks the minimum rather than throwing — same discipline as
  the sentinels (event payloads are `z.unknown()` on the wire).
- `calibrator.ts` — the `Calibrator` class and `calibrate(events, options)`
  → `CalibrationReport`. Zod schemas for the report types live here
  (harness-local), validated at the boundary like every other harness
  output.
- `format.ts` — `formatCalibrationReport(report)` → a scannable markdown
  table, the artefact a calibration-paper draft pastes.
- `index.ts` — the calibration sub-surface, re-exported from the harness
  root.

### Why harness-local types and no `calibration.computed` event in v0

The other two harness surfaces are auditable: a probe run writes a
synthetic `observation.recorded`, a sentinel finding writes a
`sentinel.alerted@1`. The consistent end-state for the calibrator is a
`calibration.computed@1` governance event (payload-is-payload, like the
alert), with its wire format in `@qmilab/lodestar-core`. It is
**deliberately deferred**, for the same reason the sentinels' `arbitrate`
hook is: there is no consumer yet. The Policy Kernel — the thing that will
*act* on a flag by downweighting a class — is Batch 4+/future. Emitting an
event no one reads, and committing a core wire format before its consumer
exists, is exactly the premature lock-in the kickoff's "calibrator last,
it's hypothetical until data" guidance warns against. The `confidence-drift`
probe asserts directly against the returned `CalibrationReport`; it needs
no event. When the Policy Kernel lands and needs to consume calibration
verdicts, the wire format graduates to core then — the same staged path
the sentinel `arbitrate` hook follows.

## The `confidence-drift` probe

Lands in `packs/coding-agent-safety/` (the first non-core pack), joining
`prompt-injection-cross-tool` and `tool-poisoning-cross-session`. It is the
forcing function: without a probe exercising it, "calibrator code is
hypothetical."

It synthesises a **real NDJSON session log** (via `EventLogWriter`, read
back via `EventLogReader` — the real I/O path, same as the sibling probes)
containing:

- An **overconfident class** `payments-api-shape`: several beliefs adopted
  at high confidence (≈0.9, authority `inferred`), each backing a decision
  that backs an action that **fails**. Confidence diverges from outcome
  over the sequence.
- A **well-calibrated control class** `git-state`: beliefs whose
  confidence tracks their realised success rate.
- One **synthetic-authority belief** that backs a failing action, present
  only to prove exclusion.

Then it runs the calibrator over the read-back stream and asserts:

1. The overconfident class is **flagged**, with a large positive
   `calibration_gap` and `overconfident: true`.
2. The control class is **not flagged**.
3. A class below `min_samples` is **not flagged** even if its gap is large
   (no alarm on thin data).
4. The synthetic-authority belief contributes **zero** samples (exclusion
   holds); flipping `includeSyntheticAuthority: true` makes it appear,
   proving the exclusion is the gate and not an accident of the fixture.
5. The pooled `overall.brier_score` and per-class numbers match an
   independent hand-computation over the fixture (the math is real, not a
   rubber stamp).

The probe deliberately does **not** assert any belief was revised or any
action was blocked — calibration measures, it does not enforce. That line
is the same one the cross-tool probe draws ("the guarantee is epistemic,
not a runtime intercept").

## Open questions — resolved here

1. **Unit of calibration?** The belief, keyed by `calibration_class`.
   (`belief.ts` was built for this.)
2. **What is the realised label?** A binary from either an action outcome
   (Signal A) or a truth-status transition (Signal B). Both on by default;
   each configurable. `partial`/`unknown`/`rejected`/`superseded` are not
   labels.
3. **Where does the action result come from**, given no host emits a
   standalone `Outcome` today? The action's terminal phase
   (`action.completed`/`failed`), with explicit `outcome.observed` events
   honoured when present. Future-compatible with both.
4. **Output as event or return value?** Return value (`CalibrationReport`)
   in v0; `calibration.computed@1` deferred until the Policy Kernel
   consumes it.
5. **Flagging policy?** `n ≥ min_samples ∧ (ece ≥ θ_ece ∨ |gap| ≥ θ_gap)`.
   The `min_samples` guard prevents false alarms on thin data.
6. **Synthetic beliefs?** Excluded by default; mirrors the firewall's
   synthetic-isolation invariant.

## What's wired, what isn't (v0 scope)

- **Wired:** the metrics, the sample resolver (both signals, tolerant
  views), the `Calibrator` / `calibrate()` API, the markdown formatter,
  and the `confidence-drift` probe that drives it end-to-end over a real
  log.
- **Not wired (deliberately):**
  - `calibration.computed@1` core wire format + an event sink — lands with
    its consumer (Policy Kernel), like the sentinel `arbitrate` hook.
  - The Policy-Kernel feedback loop that downweights a flagged class's
    confidence. The calibrator produces the signal; acting on it is policy.
    Designed in [policy-kernel.md](./policy-kernel.md) ("The arbitrate hook").
  - A `lodestar harness calibrate --session <id>` CLI and the
    `/lodestar-calibrate` slash command. The calibrator is a library
    surface today; a CLI is additive and can follow without changing the
    contract. (Severity recalibration for sentinels — sentinels.md's
    "calibrator-era concern" — is downstream of that loop.)
  - Temporal drift view (gap as a function of position in the action
    sequence). Aggregate per-class miscalibration is what the roadmap
    asks for; the trend view is a future extension.
