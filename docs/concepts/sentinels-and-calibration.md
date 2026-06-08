---
title: "Sentinels and calibration"
description: "Runtime monitors that watch the live event stream and raise findings, and the calibrator that measures whether an agent's stated confidence matches reality."
---

# Sentinels and calibration

Probes are Lodestar's *offline* spec — they run adversarial scenarios and pin
invariants in CI. Sentinels and the calibrator are the *online* half: they watch a
real run as it happens and measure whether the agent's confidence is earned.

A note on scope, up front: **sentinels observe and the calibrator measures** —
neither blocks an action on its own. A sentinel raises a finding; the calibrator
scores confidence against outcome. What gives a finding teeth is the Policy
Kernel's **arbitrate hook**: when a host wires the sentinel arbiter — both
`guard.wrap()` and the MCP proxy do — a sentinel alert flows through the
[trust ladder](trust-ladder.md) and **holds** the dependent action at
`pending_approval`. That sentinel→action wiring has landed (locked by the
`guard-arbiter-gates-dependent-action` and
`mcp-proxy-arbiter-gates-dependent-action` probes). So a finding here can mean
either "flagged for review" *or* "the dependent action was held," depending on
whether the host wired the arbiter.

## Sentinels

A **sentinel** is a runtime monitor over the live [event stream](epistemic-chain.md).
It subscribes to events, watches for a known risk signature, and raises a
structured finding (escalating to an `Incident` for serious signatures) — all of
it itself recorded in the audit trail. Sentinels share a `Sentinel` base class in
`@qmilab/lodestar-harness`; the three first-party ones ship in the
[`coding-agent-safety` pack](../reference/probe-packs.md), declared by id under the
manifest's `sentinels` field and resolved against the harness's first-party
registry.

| Sentinel | Watches for |
| --- | --- |
| `low-confidence-action` | a high-trust action resting on a weak / low-confidence belief |
| `suspicious-memory-origin` | an `external_document` belief steering a decision; memory whose provenance doesn't justify its influence |
| `anomalous-tool-sequence` | a tool-call sequence that deviates from the expected shape of the task |

Each one targets a failure mode the offline probes can't fully cover because it
only shows up in the *ordering and provenance* of a live run — a confidently-acted
weak belief, an injected document that nonetheless reached a decision, a tool
sequence that looks like manipulation. They are the early-warning layer that pairs
with the firewall's hard invariants.

## Calibration

A belief carries a `confidence` score, but a score is only meaningful if it tracks
reality: when an agent says it's 90% sure, it should be right about 90% of the
time. The **Calibrator** (`@qmilab/lodestar-harness`) measures exactly that, by
comparing stated confidence against recorded [outcomes](epistemic-chain.md).

It reports per **`calibration_class`** — so "confidence on test-passing" is graded
separately from "confidence on file edits" rather than being averaged into one
meaningless number:

- **ECE** (Expected Calibration Error) — the average gap between confidence and
  observed accuracy across confidence bins.
- **Brier score** — the mean squared error of probabilistic predictions.
- **Calibration gap** — per-class over- or under-confidence.

Synthetic beliefs (those produced by probes) are **excluded** from calibration, so
adversarial test fixtures don't pollute the real measurement. The `confidence-drift`
probe drives the Calibrator and pins that miscalibration is flagged per class — and
that synthetic beliefs stay out of the numbers.

Calibration is what turns the README's third promise — *"and whether it was
right"* — from a slogan into a number. An agent that is consistently
over-confident on a class of actions is a measurable, fixable problem rather than a
vague unease.

## Where this is heading

The honest current state: sentinels watch and report, the calibrator measures —
and **sentinel-to-action wiring has landed.** A sentinel finding now escalates
through the Policy Kernel's arbitrate hook to **hold** a risky dependent action
(in both `guard.wrap()` and the MCP proxy), and a calibration flag escalates a
gate decision the same way. What's still ahead is the team-approval surface and a
richer sentinel library — the instrumentation that makes problems *visible and
gradable* is the foundation all of that builds on.

## Related

- [The trust ladder](trust-ladder.md) — the gate sentinel alerts escalate through.
- [Probe-pack reference](../reference/probe-packs.md) — how probes and sentinels
  are packaged and run.
- [The epistemic chain](epistemic-chain.md) — the events sentinels watch and the
  outcomes calibration grades against.
