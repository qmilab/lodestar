# arXiv submission plan — Lodestar position paper

Companion to [`outline.md`](./outline.md). The outline is the **content plan**
(sections, argument, citations). This note is the **submission plan + current
readiness**: where it goes, in what form, and what changed since the outline was
written (Batches 3–5 have since landed).

This is the *research voice* artifact ("epistemic governance for agentic
systems"). Keep it distinct from the public-voice blog walkthrough
([`../walkthrough/BRIEF.md`](../walkthrough/BRIEF.md), "trust layer for AI
agents") — same project, different audience; do not mix the two.

## The paper

- **Type**: position / design-contribution paper, validated by a working
  implementation + adversarial probes — **not** an empirical study of agent
  failure rates. (Per `docs/roadmap.md` → Research arc: this is the one paper
  draftable now; the empirical memory-poisoning and calibration papers are
  2027+ and must not be pre-empted with unsupported numbers.)
- **Working title**: *Lodestar: Epistemic Governance for Agentic Systems*
  (alternate: *Epistemic Governance: An Architectural Primitive for Trustworthy
  AI Agents*).
- **Length**: ~25pp arXiv; reducible to ~12pp for a workshop/venue submission.

## arXiv logistics

- **Primary category**: `cs.CR` (Cryptography & Security) — the threat-model /
  memory-poisoning / prompt-injection framing is the sharpest hook and matches
  the outline's venue targets (USENIX Security, etc.).
- **Cross-list**: `cs.SE` (the governed coding-agent / two-phase-execution /
  replay-grade audit-log angle) and `cs.AI` (agents). Consider `cs.MA` if the
  multi-agent framing grows. Final choice is a framing call — pick the primary
  that matches the venue you adapt toward.
- **License on arXiv**: submit under **CC BY 4.0** so the preprint is as reusable
  as the Apache-2.0 implementation (arXiv's default non-exclusive license is more
  restrictive; choose CC BY explicitly at submission).
- **Ordering**: arXiv preprint first, then adapt to a venue. The outline lists
  AAAI Safe & Responsible AI, ICML/NeurIPS Agentic-AI workshops, USENIX Security.
- **Author**: Nandan, QMI Lab; co-authors earn slots via specific technical
  contributions (see outline's writing notes).

## Readiness update (what's changed since the outline)

The outline's §10 (Implementation and validation) and §1.3 (Contributions) were
written at the "pre-v0.1 / week-2 scaffold / two passing probes" stage. They are
now understated and should be refreshed before drafting:

- **Probes**: now **22 passing** across two packs (`lodestar-core` +
  `coding-agent-safety`), not two. They are the paper's reproducible spec of the
  invariants — cite them as such, including `mcp-proxy-injection-defense`,
  `prompt-injection-cross-tool`, `tool-poisoning-cross-session`, and
  `poisoned-file-cannot-hijack-feature-work`.
- **MCP proxy (Batch 3)**: the "wrap an existing agent" story is real
  (`lodestar guard mcp-proxy`). The paper's framing ("governance layer above
  agent runtimes") is now demonstrated, not hypothetical.
- **Harness (Batch 4)**: `Probe`/`Sentinel`/`Calibrator` + the three sentinels +
  the probe-pack format all exist — §7 can describe shipped code, not plans.
- **Telenotes primary proving ground (Batch 5)**: the headline worked example.
  A real Claude Code agent, wrapped via the proxy, adds a feature end-to-end with
  a full epistemic-chain trust report (committed under
  `examples/telenotes-governed-dev/reports/`), the policy gate blocking the L4
  push, and a poisoned-file run where the firewall holds. This **replaces** the
  outline's older "11-event Telenotes audit trail" as the §10 / §4.3 worked
  example, and gives the memory-poisoning-defense claim a concrete, reproducible
  demonstration (the `poisoned-file-cannot-hijack-feature-work` probe + the
  `poison-run` `firewall verdict: HELD`).
- **Documentation-agent (Batch 5 secondary)**: a second worked example for the
  claim/evidence-provenance argument (§3, §6) over free-form file content.

These are still **design-contribution** evidence (working implementation +
adversarial probes + worked examples), not deployment metrics — keep §11.4's
honest scoping intact.

## Pre-submission checklist

- [ ] Refresh outline §10 + §1.3 with the Batch 3–5 reality above.
- [ ] Confirm the threat-model section (§8) matches `docs/concepts/threat-model/` and the
      `v02-delta.md` Round 5 retraction (no unverifiable CVE claims).
- [ ] Decide primary arXiv category + target venue (drives the 12pp cut).
- [ ] Figures (5–7 per outline) — reuse the committed trust reports as listings.
- [ ] Reproducibility appendix points at `bun run probes:ci` + the two examples.
- [ ] Choose CC BY 4.0 at submission.
- [ ] Cross-check claims against the blog walkthrough so the two artifacts agree.

## Status

Outline complete; Batches 1–5 landed, so the paper is now genuinely draftable as
a position paper. Drafting is a separate work item from the implementation
roadmap (see `docs/roadmap.md` → Research arc). Not started.
