# Lodestar — the trust layer for AI agents

Lodestar wraps your coding agent and turns every tool call into a tamper-evident
**trust report** — and enforces guardrails so untrusted input can't silently
become "fact."

**Start here:**

- **[Get started](guides/get-started.md)** — clone, run two governed demos, and
  read the trust report in about five minutes.
- **[Walkthrough](guides/walkthrough.md)** — the same two demos told as a story,
  with diagrams.
- **[Use cases](use-cases.md)** — where Lodestar fits, beyond the demo.

**Concepts** — how it works:

- [The epistemic chain](concepts/epistemic-chain.md) — the eight links from
  observation to revision.
- [Reading isn't believing](concepts/reading-isnt-believing.md) — the
  auto-observation gate.
- [The memory firewall](concepts/memory-firewall.md) — the four lifecycle axes.
- [The trust ladder](concepts/trust-ladder.md) — how actions are gated.
- [The Policy Kernel & approvals](concepts/policy-kernel.md) — the three-valued
  gate and the signed-approval lifecycle.
- [Governed egress & native adapters](concepts/governed-egress.md) — git, http,
  nostr, messaging, and shell, held at L4 until approved.
- [Sentinels and calibration](concepts/sentinels-and-calibration.md) — runtime
  monitoring and confidence measurement.
- [Memory poisoning](concepts/threat-model/memory-poisoning.md) — the threat model.

**Reference:** [architecture](reference/architecture.md) ·
[CLI](reference/cli.md) · [probe packs](reference/probe-packs.md)

More in the walkthrough series — *the threat model* and *wrapping your own agent* —
coming soon.

Code: [github.com/qmilab/lodestar](https://github.com/qmilab/lodestar)
