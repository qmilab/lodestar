# How Lodestar compares

Most 2026 open-source work on agent safety gates the **tool call**: it decides
whether an action may run. Lodestar's distinguishing claim is narrower and
earlier in the chain: it gates what the agent may **believe** before that
decision (a belief lifecycle with provenance-gated promotion, calibration, and a
replayable epistemic chain), and then gates the call as well.

This page positions Lodestar against its neighbours. Every statement about
another project below comes from that project's own documentation or paper,
cited in [Sources](#sources), as read on 2026-10-11. These projects move fast;
check the sources before relying on a detail. Where this page says "not
verified", we did not find the answer in the primary material and make no claim.

## At a glance

| | Gates | Unit of decision | Policy form | Containment | Reversibility |
|---|---|---|---|---|---|
| **Lodestar** | belief promotion, then the tool call | claim / belief / action | declarative rules over a trust ladder, Ed25519-signed | TS-level, plus an opt-in OS sandbox for probe packs only | none |
| **Agent Governance Toolkit** | tool calls, inter-agent messages | action | YAML, OPA Rego, Cedar | "capability sandboxing", execution rings (mechanism not described on the announcement page) | not described |
| **OpenParallax** | tool calls via a separate-process validator | proposed action | YAML rules, heuristics, LLM evaluator, human approval | agent in a kernel sandbox (Landlock/seccomp, sandbox-exec) | copy-on-write snapshots, rollback |
| **HCP** | capability invocations and data pipes | handle / grant | grants + policy engine | in-memory prototype; sandboxing out of scope | not a goal |
| **Guardrail toolkits** | model inputs and outputs | message / response | rails, validators | none | none |
| **Gateways** | requests at the network edge | tool name per consumer | consumer/group ACLs | n/a | n/a |

## Policy-as-code over tool calls: Microsoft Agent Governance Toolkit

Microsoft's toolkit (MIT, announced April 2026) is a seven-package suite. Its
policy engine, Agent OS, intercepts each agent action before execution and
evaluates rules written in YAML, OPA Rego or Cedar. Other packages cover
inter-agent trust (Agent Mesh), execution rings and a kill switch (Agent
Runtime), SRE controls, and compliance mapping. It ships SDKs for Python,
TypeScript, .NET and others, with framework integrations (LangGraph, OpenAI
Agents SDK, and more) [1][2].

**Overlap.** Both put a policy decision in front of tool calls. Lodestar's
actions at trust levels L0–L3 that match no rule are denied; an L4 action is
held for approval by the trust-ladder floor, and L5 is always denied. Lodestar's Policy Kernel is also
declarative and three-valued (allow / deny / hold for approval).

**Approvals and quorum.** The announcement lists "approval workflows with
quorum logic" among its mitigations [1], and the repository's policy example
shows a `require_approval` action with an `approvers` list [2]. Neither source
says how a quorum is computed or how an approver's identity or decision is
verified, so we make no claim about those mechanics. M-of-N approval is
therefore not a differentiator for Lodestar. What Lodestar's version
(ADR-0041, probe `quorum-requires-distinct-eligible-approvers`) pins is
narrower: the kernel adjudicates the threshold over each approver's own
Ed25519-signed resolution, checks each approver's eligibility against the
request's required authority, and a client-synthesised single grant cannot
satisfy it. Whether the toolkit does the same is not stated in the material we
read.

**Different.** The toolkit's unit is the action and the message. Nothing on the
announcement page describes a model of what the agent has *come to believe*
from untrusted content, or a promotion gate between reading and believing.
Lodestar's [memory firewall](memory-firewall.md) is that layer.

**Where Lodestar is weaker.** The toolkit supports mature, widely understood
policy languages (Rego, Cedar), a broad SDK matrix, and a compliance mapping.
Lodestar's policy format is its own and TypeScript-first, with Python only as
thin runtime hooks.

**Complementary.** A Rego/Cedar decision source and Lodestar's belief gating
address different questions; an operator could run both. We have not built or
tested such an integration.

## Cognitive-executive separation: OpenParallax

Fokou's Parallax paper argues that an agent that reasons must not be the thing
that acts: the reasoning system proposes, an independent validator evaluates,
and a separate executor acts. It adds reversible execution, capturing state
before destructive operations so they can be rolled back [3]. The reference
implementation, OpenParallax (Go, Apache-2.0), runs the agent in a kernel
sandbox that can only propose tool calls over gRPC; a separate engine runs a
tiered validator (YAML rules, a heuristic classifier, a separate LLM evaluator,
human approval, all failing closed) and takes copy-on-write snapshots before
destructive actions [4]. Its own README reports 277/280 attacks blocked on its
own corpus, and notes the project is early-stage; the numbers come from its
own test suite [4].

**Overlap.** The same architectural instinct: the model's output is a
*proposal*, never an effect. Lodestar's Action Kernel is two-phase
(propose, then execute), and its human-approval hold is analogous to the
validator's last tier.

**A naming note.** Lodestar's "Parallax" refers to something different and
older in this repo: the rule that two `external_document` beliefs cannot
corroborate each other into `supported`. Same word, unrelated mechanism.

**Where Lodestar is weaker (candidly).**

- **No reversible execution.** Lodestar has no snapshot or rollback. An approved
  action that proves wrong stays done; the epistemic chain records the
  revision, but it does not undo the effect. OpenParallax does offer rollback
  for workspace changes [4].
- **TS-level, not OS-level containment.** Lodestar's adapters enforce
  invariants in TypeScript (scoped env, allowlists, root confinement, timeouts)
  and say so in each ADR. They do not confine a compromised host process. The
  only OS sandbox in the repo wraps the *probe runner* for external packs; it is
  not applied to agent tool execution. OpenParallax puts the agent itself
  behind Landlock/seccomp/sandbox-exec [4].
- **The agent and the gate share a process in the in-process `guard.wrap()`
  mode.** The MCP proxy and runtime-core sidecar give process separation for
  agents that cannot be trusted with the log; the embedded mode does not.

**Where Lodestar goes further.** Parallax's validator judges a *proposed
action*. It does not, per its public description, track whether the facts the
action rests on were ever legitimately established. Lodestar's claim is that a
validator facing an action justified by a poisoned document needs the
provenance chain to see the poisoning at all.

**Complementary.** OS-level agent confinement and rollback are things Lodestar
lacks and OpenParallax has; belief provenance is the reverse.

## Execution-layer invariants: HCP

Liu's paper defines eight execution-layer invariants for MCP-style runtimes and
implements them in HCP, a Handle-Capability Protocol reference runtime. In its
10-case benchmark a naive baseline permits every modelled attack and HCP blocks
all ten. The paper states HCP is not production-ready, is an in-memory
prototype, and leaves sandboxing, persistence and signing out of scope [5][6].

The table maps each invariant to Lodestar probes. "Partial" means the probe
covers a related property, not the invariant as Liu states it. A probe's
existence is not a claim that the invariant is fully met.

| # | HCP invariant [5][6] | Lodestar probe(s) | Coverage | Honest gap |
|---|---|---|---|---|
| I1 | Metadata is not policy authority | `mcp-proxy-injection-defense`, `runtime-gate-enforces-two-phase` (operator-owned `tool_defaults`; unregistered tool denied), `unmatched-action-defaults-to-deny` | Partial | The tool-call envelope is recorded as `tool_result` evidence, while text or resource content a tool returns is tagged `external_document` and cannot self-promote. The hook only declares a tool name. No probe pins that a hostile tool *description* cannot influence a rule. |
| I2 | Approval cannot bypass grant | `l4-action-requires-approval`, `ladder-floor-overrides-allow-rule`, `granted-approval-still-revalidates-preconditions`, `forged-approval-cannot-execute`, `quorum-requires-distinct-eligible-approvers` | Partial | Approval resolves a hold. Out-of-band approvals and quorum votes are Ed25519-verified; the embedded `guard.wrap()` `ApprovalResolver` is a trusted in-process producer and is not signature-checked. The trust-ladder floor cannot be loosened by an allow rule. Lodestar has no separate *grant* object distinct from policy, so "approval AND grant" is not expressed as two artifacts. |
| I3 | Provider-canonical resources | `filesystem-adapter-enforces-write-invariants` (realpath/symlink confinement), `http-adapter-enforces-egress-invariants` (per-hop redirect re-validation), `git-adapter-enforces-egress-invariants` (remote pinning) | Partial | Canonicalisation is per adapter. There is no general provider-resolved-resource layer for arbitrary MCP downstream servers. |
| I4 | Principal binding | `forged-approval-cannot-execute`, `quorum-requires-distinct-eligible-approvers` (proposer cannot count toward own quorum) | Weak | Binding exists for *approvers*. There are no handles; grants and handles are not owned by a principal, so wrong-principal invocation is not a modelled case. **Gap.** |
| I5 | Grant-backed scoped invocation | `proxy-hold-carries-rule-authority`, `l4-floor-preserves-stricter-rule` | Partial | `required_authority` (min trust, scope) is matched at approval time. There is no per-invocation capability-scope matching against a stored grant. |
| I6 | Data-pipe authorization (source and target) | `sensitivity-ceiling`, `ship-respects-sensitivity-ceiling`, `otel-export-respects-sensitivity-ceiling` | Weak | The ceiling governs *export* of recorded events, and context retrieval is gated by sensitivity. Lodestar does not authorise a tool-to-tool data flow between a source handle and a target capability. **Gap.** |
| I7 | Auditable deny paths | `unmatched-action-defaults-to-deny`, `approval-timeout-denies`, `event-log-canonical-hash` | Partial | Denials are decided and the log is hash-verified. We did not verify that each deny path has a probe asserting a distinct audit event, so we do not claim all do. |
| I8 | Explicit protocol state | `runtime-gate-enforces-two-phase` (duplicate resume idempotent, post-deadline resolution rejected) | Weak | Lodestar's state machine covers action and approval lifecycle. We have no probe for pre-initialisation, wrong-version or stale-session calls. **Gap.** |

Net: of eight invariants, none is fully covered. Five have partial coverage
(I1, I2, I3, I5, I7) and three are weak or real gaps (I4, I6, I8). The gaps
are mostly in HCP's strength: a handle/capability model with ownership, which
Lodestar does not have. Conversely HCP's model has no notion of belief, so
none of Lodestar's firewall probes map onto it.

## Guardrail toolkits: NeMo Guardrails and Guardrails AI

NeMo Guardrails is an open-source Python library that adds programmable rails
(input, retrieval, dialog, execution, output) around LLM calls, configured with
YAML and Colang [7]. Guardrails AI provides input/output validators from a
hub, plus structured-output generation [8].

These work on **message content**: is this input or output safe, on-topic,
well-formed? That is a different question from whether the agent may act on a
fact whose origin was an untrusted document. NeMo's retrieval and execution
rails sit nearest to Lodestar's concerns, but they filter content and calls;
they do not, per their documentation, keep a lifecycle of what has been
believed. We read the product overviews only, not the full rail internals, so
treat this as a positioning statement, not an audit.

**Complementary.** Content filters and Lodestar are natural layers: filter the
text, then govern what becomes a belief and what is allowed to act on it.

## Gateways: MCP tool ACLs at the network edge

Kong's AI MCP Proxy plugin applies global and per-tool ACLs keyed to Consumers
and Consumer Groups, for both passthrough MCP servers and REST APIs converted
to MCP tools [9]. This is identity-based allow/deny at the edge, and it is
good at that job.

It decides *who* may call *which tool*. It does not see why the agent wants to
call it. Lodestar's MCP proxy mode is a different placement (it sits at the
agent boundary and synthesises decisions linked to observed beliefs) and is
not a replacement for edge identity and rate controls.

**Complementary.** Edge ACLs for who, Lodestar for on-what-grounds.

## Where this leaves a reader

- If the threat you worry about is a **malicious or compromised model with
  process access**, you want OS-level confinement and ideally rollback.
  Lodestar does not provide either; look at OpenParallax's approach.
- If you need **policy in an established language** with broad SDK coverage,
  the Agent Governance Toolkit is the more mature fit.
- If you need **capability ownership and data-flow rules between tools**, HCP's
  model is stronger than anything in Lodestar today.
- If the threat is **a poisoned document becoming a trusted fact that justifies
  a later action**, that is the question Lodestar is built around, and the
  tool-call gates above do not model it.

These are layers, not rivals. Nothing here has been integration-tested with
Lodestar.

## Sources

1. Microsoft Open Source Blog, "Introducing the Agent Governance Toolkit", 2026-04-02: <https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit/>
2. Agent Governance Toolkit repository: <https://github.com/microsoft/agent-governance-toolkit>
3. J. Fokou, "Parallax: Why AI Agents That Think Must Never Act", arXiv:2604.12986: <https://arxiv.org/abs/2604.12986>
4. OpenParallax repository (README): <https://github.com/openparallax/openparallax>
5. T. Liu, "From Tool Connection to Execution Control: Benchmarking Security Invariants in MCP-Style Agent Runtimes", arXiv:2606.29073: <https://arxiv.org/abs/2606.29073>
6. HCP reference runtime (linked from the paper's HTML version): <https://github.com/SymbolicLight-AGI/handle-capability-protocol>
7. NVIDIA NeMo Guardrails documentation: <https://docs.nvidia.com/nemo/guardrails/latest/index.html>
8. Guardrails AI repository: <https://github.com/guardrails-ai/guardrails>
9. Kong, "Control MCP tool access with Consumer and Consumer Group ACLs": <https://developer.konghq.com/mcp/use-access-controls-for-mcp-tools/>
