---
title: "Lodestar and the OWASP Top 10 for Agentic Applications"
description: "A category-by-category map from the OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10) to the Lodestar component that addresses it, the probe that pins it, and the gaps that remain."
---

# Lodestar and the OWASP Top 10 for Agentic Applications

The OWASP GenAI Security Project published the
[OWASP Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
in December 2025 (ASI01–ASI10). This page maps each category to what Lodestar
does about it, and says plainly where it does little or nothing.

Category names below are taken from the official
[PDF](https://genai.owasp.org/download/52117/?tmstv=1765059207) (CC BY-SA 4.0),
not from secondary summaries.

## How to read the ratings

Lodestar is a governance layer around an agent, not an agent runtime and not a
model-level defence. It constrains what a compromised or confused agent can
*believe* and *do*; it does not stop the model from being manipulated.

- **Addressed** — a Lodestar component enforces a control for the category's
  core scenario, and at least one named probe pins it.
- **Partial** — a named probe pins part of the category; the rest is stated as
  a gap.
- **Not addressed** — no probe pins it. Adjacent signals are listed where they
  exist, but they are not claimed as coverage.

Probes are executable specs, so every claim here can be checked by running the
probe. They live in `packs/lodestar-core/` and `packs/coding-agent-safety/`
(run with `lodestar harness run --pack <name>`). Several guarantees are
TypeScript-level boundaries, not OS- or network-level containment; the
per-adapter ADRs in
[`.claude/adr/`](https://github.com/qmilab/lodestar/tree/main/.claude/adr) say
which.

## Summary

| ID | Category (OWASP wording) | Rating |
|----|--------------------------|--------|
| ASI01 | Agent Goal Hijack | Partial |
| ASI02 | Tool Misuse and Exploitation | Addressed |
| ASI03 | Identity and Privilege Abuse | Partial |
| ASI04 | Agentic Supply Chain Vulnerabilities | Partial |
| ASI05 | Unexpected Code Execution (RCE) | Partial |
| ASI06 | Memory & Context Poisoning | Addressed |
| ASI07 | Insecure Inter-Agent Communication | Not addressed |
| ASI08 | Cascading Failures | Partial |
| ASI09 | Human-Agent Trust Exploitation | Partial |
| ASI10 | Rogue Agents | Not addressed |

## ASI01 — Agent Goal Hijack · Partial

**Risk.** Attackers redirect an agent's objectives, task selection, or
decision pathways, typically through instructions hidden in content the agent
reads.

**What Lodestar does.** It does not try to detect the hijack inside the model.
It limits what injected content can *become*: content from documents, web
pages, and tool results is recorded as `external_document` evidence, and the
[auto-observation gate](memory-firewall.md) refuses to let that evidence
promote a claim to `supported`. Injected "facts" therefore stay `unverified`
and out of trusted context. Actions the hijacked agent then proposes still
meet the [trust ladder](trust-ladder.md) and its approval holds.

**Probes.** `prompt-injection-cross-tool` and
`poisoned-file-cannot-hijack-feature-work` (`coding-agent-safety`);
`mcp-proxy-injection-defense` and `auto-observation-gate` (`lodestar-core`).

**Gap.** The agent can still be talked into *proposing* a harmful action; the
defence is that the proposal is gated, not that it is never made. Lodestar
has no model-side goal-integrity check.

## ASI02 — Tool Misuse and Exploitation · Addressed

**Risk.** Agents misuse legitimate tools through prompt injection,
misalignment, or unsafe delegation, leading to exfiltration or workflow
hijacking.

**What Lodestar does.** The Action Kernel runs every tool call in two phases
(propose, then execute) against a typed action contract with an explicit trust
level. The [Policy Kernel](policy-kernel.md) gate is three-valued
(allow / deny / hold) and defaults to deny. Each native adapter (shell, git,
http, messaging, sql, filesystem, nostr, payments, vector) pins its own
invariants: argv-only execution, operator-pinned destinations, bounded output,
scoped credentials. See [governed egress](governed-egress.md).

**Probes.** `l4-action-requires-approval`, `pending-approval-cannot-execute`,
`unmatched-action-defaults-to-deny`, `granted-approval-still-revalidates-preconditions`
(gate and kernel); `shell-adapter-enforces-sandbox-invariants`,
`http-adapter-enforces-egress-invariants`,
`messaging-adapter-enforces-egress-invariants`,
`sql-adapter-enforces-invariants`,
`filesystem-adapter-enforces-write-invariants`,
`payment-adapter-enforces-send-invariants` (adapters).

**Gap.** Coverage is for tools that go through the kernel or the MCP proxy.
A tool the agent calls natively, outside Lodestar, is invisible to it.

## ASI03 — Identity and Privilege Abuse · Partial

**Risk.** Exploiting delegation chains, inherited credentials, and cached
context to escalate access.

**What Lodestar does.** The trust-ladder *floor* means a policy rule cannot
grant an action less scrutiny than its rung requires. Approvals are signed
(Ed25519) and verified against operator-pinned approver keys, so a forged or
tampered grant cannot release a held action. Signature verification applies
wherever approver keys are pinned; an operator can explicitly opt out with
`allow_unsigned` for trusted local setups. Where an operator configures a
policy rule with `quorum >= 2`, an M-of-N quorum is adjudicated by the kernel
over each approver's own signed resolution, counting only eligible, distinct
approvers and excluding the action's own proposer. Quorum is opt-in per rule,
not automatic for high-stakes actions. Adapter credentials
are operator-supplied, scoped, and kept out of inputs, observations, and
errors.

**Probes.** `ladder-floor-overrides-allow-rule`, `forged-approval-cannot-execute`,
`policy-version-signature-required`,
`quorum-requires-distinct-eligible-approvers`.

**Gap.** Lodestar governs the *approval* identity and the credentials its own
adapters hold. It does not manage the agent's identity, credential lifecycle,
or delegation chains across systems.

## ASI04 — Agentic Supply Chain Vulnerabilities · Partial

**Risk.** Third-party tools, plug-ins, models, MCP servers, agents, and
registries that are malicious, compromised, or tampered with.

**What Lodestar does.** This is covered for *probe packs*, Lodestar's own
extension artifact. Pack manifests are Ed25519-signed with a per-file content
digest, verified against consumer-pinned author keys before any pack code
runs. Sources must pin an immutable version (npm integrity, full git SHA);
resolution never runs install scripts or git hooks. Discovery indexes and
verification badges are advisory and never confer trust. See the
[registry threat model](threat-model/registry-supply-chain.md) and ADR-0016
through ADR-0021.

**Probes.** `pack-manifest-signature-required`, `forged-pack-cannot-load`,
`tampered-pack-content-cannot-load`, `mutable-git-ref-rejected`,
`resolution-runs-no-pack-code`, `pack-index-signature-required`,
`unverified-badge-not-trusted`.

**Gap.** Lodestar does not vet the agent's own dependencies, model weights,
or downstream MCP servers. For MCP, it governs what a server's tools can do
and what their output can become, not whether the server is trustworthy.

## ASI05 — Unexpected Code Execution (RCE) · Partial

**Risk.** Agent-generated or tool-triggered code escalating to remote or
local code execution.

**What Lodestar does.** The shell adapter enforces an allowlist, argv-only
execution (no shell interpolation), a scoped environment with no host-env
passthrough, a wall-clock timeout, and bounded output. Probe packs run under
a scoped environment and, for external packs, inside an OS sandbox
(`sandbox-exec` on macOS, `bubblewrap` on Linux).

**Probes.** `shell-adapter-enforces-sandbox-invariants`,
`runner-denies-host-env-to-probe`,
`runner-sandboxes-probe-filesystem-and-network`.

**Gap.** The shell adapter's sandbox is a TypeScript-level boundary, not an
OS sandbox: it governs how commands are constructed and what environment they
get, not what an allowed binary can do once running. There is no sandbox for
arbitrary agent-generated code.

## ASI06 — Memory & Context Poisoning · Addressed

**Risk.** Adversaries corrupt or seed the information an agent retains,
retrieves, or reuses (summaries, embeddings, RAG stores), biasing later
reasoning.

**What Lodestar does.** This is the category the [Memory Firewall](memory-firewall.md)
exists for. Memory state is split across four orthogonal axes (truth,
retrieval, security, freshness); agent-written memories cannot self-promote;
`external_document` and `model_inference` evidence cannot move a claim to
`supported` on its own; quarantined beliefs are not retrievable;
sensitivity ceilings gate what leaves a session. Poisoned content stays
inert across sessions, including through the Postgres-backed stores, and RAG
chunks are treated as untrusted evidence as well. See the
[memory-poisoning threat model](threat-model/memory-poisoning.md) and
[reading isn't believing](reading-isnt-believing.md).

**Probes.** `memory-poisoning-basic`, `auto-observation-gate`,
`quarantined-not-retrievable`, `guard-import-no-self-promote`,
`reflection-cannot-promote-to-normal-alone`,
`vector-retrieval-cannot-auto-promote`, `world-model-withholds-gated-current-state`,
`sensitivity-ceiling` (`lodestar-core`); `tool-poisoning-cross-session`
(`coding-agent-safety`; needs a Postgres test database, skips loudly without
one).

**Gap.** Coverage applies to memory and context that pass through the
firewall. Context the host keeps outside it (a raw chat transcript, a vendor
memory feature) is not governed.

## ASI07 — Insecure Inter-Agent Communication · Not addressed

**Risk.** Weak authentication, integrity, or authorization between agents
lets attackers spoof, intercept, or manipulate agent-to-agent messages.

**What Lodestar does.** Nothing specific. Lodestar has no agent-to-agent
messaging layer, and no probe pins one. Content that arrives from another
agent through a governed tool is treated like any other tool output
(untrusted evidence), which is incidental protection, not a control for this
category.

## ASI08 — Cascading Failures · Partial

**Risk.** A single fault (hallucination, malicious input, corrupted tool,
poisoned memory) propagates across agents and compounds into system-wide
harm.

**What Lodestar does.** It limits propagation of *epistemic* faults along the
chain. When a belief is contradicted, the reflection pass proposes flagging
the decisions that depended on it. Separately, sentinel alerts (for example on
a suspicious memory origin) can hold dependent actions at `pending_approval`
instead of letting them execute.

**Probes.** `contradicted-belief-flags-dependent-decisions`,
`sentinel-alert-gates-dependent-action`, `guard-arbiter-gates-dependent-action`,
`mcp-proxy-arbiter-gates-dependent-action`.

**Gap.** There is no circuit breaker, rate limiting, or blast-radius cap
across agents or workflows, and no probe for multi-agent failure
propagation.

## ASI09 — Human-Agent Trust Exploitation · Partial

**Risk.** Agents exploit human trust (authority, fluent explanations) to get
risky actions approved, or to mask what they are doing.

**What Lodestar does.** Approval is an explicit, out-of-band, signed event, so
a forged or tampered approval cannot release a held action when approver keys
are pinned (the unsigned opt-out is explicit), and a held action that times
out is denied. Separating approver from proposer is enforced by the kernel
only for quorum-enabled holds; on the single-approver path it depends on the
resolver being a separately authenticated channel, not the agent. The decision chain is
recorded and can be reported on afterwards.

**Probes.** `forged-approval-cannot-execute`,
`forged-approval-via-http-channel-cannot-execute`, `approval-timeout-denies`,
`pending-approval-cannot-execute`.

**Gap.** Signed approval authenticates *who* approved, not whether they
understood *what* they approved. The approver is not guaranteed to see the
tool and inputs of the action in front of them, so a persuasive agent can
still shape a rubber-stamp. This is a known gap we intend to close, and no
probe pins it yet. Opt-in quorum raises the cost of such an attack but does
not remove it.

## ASI10 — Rogue Agents · Not addressed

**Risk.** Agents that drift or become misaligned and act outside their
intended scope without an active attacker.

**What Lodestar does.** Nothing that contains a rogue agent. Action
containment (ASI02) bounds what any agent can do, whether or not it is
rogue, but that is not detection or response. The closest detective signals
are calibration reports and the `confidence-drift` probe; they surface
over-confidence in an agent's beliefs and are not a rogue-agent detector.

## Maintenance

Ratings are claims about the code at a given release. If a probe named here is
renamed or removed, or a gap is closed, update this page in the same change.
