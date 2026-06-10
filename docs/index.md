# Lodestar — the trust layer for AI agents

You hand a coding agent a task. It reads files, writes code, runs tests, makes
commits. When it does something baffling, what you have to go on is a
transcript and a diff — *what it said* and *what changed*. Neither tells you
what it **believed** was true when it acted, where that belief **came from**,
whether it was **allowed** to do the risky thing it tried — or whether
instructions planted in a file it read quietly became part of its plan.

Lodestar sits **beside** your agent — Claude Code, Cursor, Aider, or a loop you
wrote yourself — and does two things:

1. **It records the agent's reasoning as a tamper-evident chain.** Every step
   becomes a typed record in an append-only, hash-linked log:

    ```
    Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
    ```

    Rendered with one command, that log is a **trust report**: what the agent
    observed, what it came to believe, which beliefs each decision depended
    on, what policy allowed, and what actually happened.

2. **It enforces guardrails.** A **policy gate** grades every action by blast
   radius and holds the irreversible ones (a push, a send, a deploy) for human
   approval — and a **Memory Firewall** keeps untrusted content from silently
   becoming "fact."

The one idea underneath it all: **reading something is not the same as it
being true.** When the agent reads a file, *that the read happened* is recorded
as a verified fact — but *what the file said* stays an unverified rumour until
something other than reading it says otherwise. That line is the
anti-prompt-injection mechanism: in the headline demo, a poisoned file orders
the agent to hardcode credentials and push to main — the run records it,
never believes it, blocks the push, and self-verifies:

```
[firewall verdict] HELD ✓
```

Lodestar is **not** an agent runtime, an observability platform, or a workflow
builder — it's the trust layer beside the tools you already use. It is
**Apache-2.0**, runs entirely locally with no hosted service, and every
guarantee on this site is pinned by an executable spec of adversarial probes
that run in CI.

**Start here:**

- **[Get started](guides/get-started.md)** — clone, run two governed demos, and
  read the trust report in about five minutes.
- **The walkthrough series:**
    - [Part 1 — wrap your coding agent, get a trust report](guides/walkthrough.md)
      — both demos told as a story, with diagrams.
    - [Part 2 — the agent-safety threat model](guides/part-2-the-threat-model.md)
      — what each probe asserts, and what it deliberately doesn't.
    - [Part 3 — wrap your own agent](guides/part-3-wrap-your-own-agent.md)
      — `guard.wrap()`, the MCP proxy, policies, and probes, hands-on.
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

Code: [github.com/qmilab/lodestar](https://github.com/qmilab/lodestar)
