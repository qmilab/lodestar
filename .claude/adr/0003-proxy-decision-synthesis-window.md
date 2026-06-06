# ADR-0003: MCP-proxy decision synthesis — the conservative belief-dependency set

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Nandan, Claude
- **Related:** ADR-0001, ADR-0002, `docs/architecture/policy-kernel.md`, `packages/guard-mcp/src/proxy.ts`, `packages/guard/src/sentinel-arbiter.ts`

## Context

ADR-0002 settled the *sequencing*: `guard.wrap()` first (P1a, merged — the agent
**declares** decisions via `ctx.recordDecision`), then the MCP proxy (P1b — the
opaque agent cannot declare, so the proxy **synthesizes** decisions). It
deliberately left P1b's three mechanics open "to be settled there, with a probe":

1. **Window size** — which beliefs does each synthesized decision link?
2. **Concurrency** — the proxy supports overlapping `tools/call` (capture keyed
   by action id); what does the window mean when two calls race?
3. **Rendering** — how does a synthesized decision read in `lodestar report`?

The load-bearing sentinels (`suspicious-memory-origin`, `low-confidence-action`)
only fire when a belief enters a `decision.made`'s `belief_dependencies`
(ADR-0001, constraint 2). The proxy *forms* the beliefs — it runs the Cognitive
Core over each tool result, emitting `belief.adopted` in its observation sink —
but it does not know the opaque agent's dependency edges. So it must invent the
`decision.made` link, and the question is precisely *which* beliefs to put in it.

A structural fact of the proxy's flow drives the answer: **beliefs are adopted in
`observationSink`, which runs during `execute()` — after the action is gated.**
So the beliefs produced by tool-call *N*'s result land *after* call *N* and
become available to call *N+1*. "The agent just read these things, then acted" is
literally the shape of consecutive proxied calls.

## Decision

**The proxy synthesizes a `decision.made` per action from the conservative
belief-dependency set: every belief the session has observed so far, never
reduced by execution.**

- **The set is cumulative within a session, reset only at session end.** The
  arbiter accumulates belief ids from the `belief.adopted` events it observes (it
  already projects them for `resolveContext`) into a dedup `Set`.
  `observedBeliefIds()` returns a copy; the proxy calls it immediately before
  `kernel.propose`, builds a `Decision` whose `belief_dependencies` are those ids,
  emits `decision.made`, and proposes the action with that `decision_id`. The
  proxy **never removes** from the set on execution — it shrinks only when the
  session ends (the arbiter unbinds). An empty set (the first read of a session)
  synthesizes nothing — the action carries no `decision_id` and is gated only by
  contract + rule + subject-agnostic signals, exactly as today.

  *Why nothing is removed on execution (Codex rounds 2 & 4):* an opaque agent does
  not tell the proxy which subset of what it has read a given action actually
  used, so the proxy must assume the worst — the whole observed set. Every design
  that *removed* beliefs from the set when an action "acted on" them turned out to
  be a real under-gating bypass, because the agent controls when actions execute:
  - **drain-at-synthesis** (the first draft) let a *re-proposed* held call — the
    `approval_required` / `approval_timeout` soft-denial → re-plan flow — find an
    empty set and slip the gate (round 2);
  - **consume-on-execution** (the second draft) let a *low-trust filler* action
    (e.g. an L0 read between a poisoned read and an L3 write) execute ungated and
    remove the belief the L3 write still depended on, so the write slipped the
    level-gated low-confidence signal (round 4).

  The common root is that *any* execution-driven shrink is an attacker-controlled
  drain. A set that only grows within a session is safe by construction against
  the whole class. `guard.wrap()` gets the equivalent for free — its agent
  re-declares the decision (with its `belief_dependencies`) on each retry.

  *What this costs, and why it is acceptable:* the set over-links — a synthesized
  decision depends on supported "filler" beliefs too, and once a flagged belief is
  observed every *subsequent* action's decision carries it (and re-fires the
  belief-scoped sentinel under a fresh `decision_id`). That is verbose, not
  unsafe, and it is opt-in (operators choose which sentinels to enable). Crucially
  **temporal scoping still holds**: a decision is a point-in-time snapshot, so an
  action proposed *before* a flagged belief was observed does not depend on it and
  is not gated — the audit still shows that actions before the poisoned read were
  clean. A *bounded* set (evict by age/count to cap the verbosity) is the deferred
  F4 refinement — but bounding is itself a drain, so it needs a design that an
  agent cannot exploit by flooding; out of scope for v0.

- **Concurrency: a grow-only set is naturally safe.** `observedBeliefIds()` is a
  synchronous copy and `add` is atomic in the JS single-threaded model, so
  overlapping `handleCallTool`s cannot tear it, and — because nothing is ever
  removed — there is no consume/drain race to reason about. The only residual
  overlap effect is that two concurrently-proposed actions both see the same set,
  which over-links (the safe direction). We accept it for v0 because (a) it is the
  same best-effort concurrency posture the proxy already documents (guard
  invariant 3; captures keyed by action id, the chain not serialised); (b) the
  primary threat — read untrusted content, *then* act — is causally sequential. A
  bounded (and concurrency-careful) set is a hardening follow-up (P3 / F4),
  noted in code.

- **Rendering: synthesized decisions are honest, attributed to a synthesis
  actor.** A synthesized `Decision` sets `made_by` to a dedicated actor
  (`PROXY_DECISION_SYNTHESIS_ACTOR = "lodestar-proxy-synthesis"`), and the proxy
  stamps the `decision.made` envelope's `actor_id` the same way — exactly as a
  `sentinel.alerted` is attributed to the sentinel actor, not the governed agent
  (ADR-0001 / P1a Codex round 2). Its `question` states it was synthesized from
  the observed-belief set. `lodestar report` renders it as a real Decision link
  in the chain, clearly *not* an agent-declared one. (The `rationale_id` points
  to a deterministic synthetic id for v0; emitting a full backing `Explanation`
  is a follow-up — it does not change gating.)

- **Opt-in, so the existing proxy is untouched.** The arbiter reaches the proxy
  only through `MCPProxyOverrides.arbiter` (wired with a gate compiled from the
  *same* arbiter via `compileWithSentinels`). With no arbiter the proxy feeds
  nothing, synthesizes nothing, and its event stream is byte-for-byte what it is
  today — every existing proxy / Telenotes probe is unchanged. This mirrors
  `guard.wrap()` invariant 6 ("omit the arbiter and the gate keeps its pure
  contract+rule behaviour").

The `SentinelArbiter` is otherwise **unchanged** between P1a and P1b, as ADR-0001
promised: only the *source* of the decision link differs (declared via
`ctx.recordDecision` in guard; synthesized via `observedBeliefIds()` in the
proxy). The observed-belief set it now also maintains is the one reusable
primitive ADR-0002 anticipated ("a reusable 'decision from recent beliefs'
helper").

## Consequences

- The proxy completes the epistemic chain it previously skipped: held actions now
  carry a Decision link explaining *why* they were gated (which beliefs, which
  alert), not just a bare `pending_approval`.
- Wiring `suspicious-memory-origin` into the proxy means every action proposed
  *after* an `external_document`-rooted read depends on that read and is held
  until approved — the conservative, opt-in posture for an opaque agent over
  untrusted downstreams; operators dial it with which sentinels they enable. The
  cost is verbosity (over-linked decisions, repeated alerts), not under-gating.
- A *bounded* set to cap that verbosity is the deferred F4 item; bounding is
  itself an exploitable drain, so it needs its own design (P3 hardening, alongside
  F1/F6).
- The synthesis layer is a small new public surface (`observedBeliefIds`,
  `PROXY_DECISION_SYNTHESIS_ACTOR`) and one new arbiter feed in the proxy's
  `emit` — no new schema, no new core type.

## Alternatives considered

- **Drain the set at synthesis** (the first draft). Rejected (Codex round 2): a
  held / denied call drains beliefs it never acted on, so the agent's re-proposal
  of that call finds an empty set and slips the gate.
- **Consume on execution** (the second draft — remove a belief once the action
  that read it executes). Rejected (Codex round 4): a low-trust filler action
  executes ungated and removes a belief a later consequential action still depends
  on, so the consequential action slips the level-gated low-confidence signal.
  Both drafts share one root — any execution-driven shrink is an
  attacker-controlled drain — which is why the accepted design never removes on
  execution.
- **`tool_sequence`-only gating, no synthesis.** Rejected (already by ADR-0002):
  belief-scoped alerts — the whole `suspicious-memory-origin` story — would
  silently never fire in the proxy.
- **A bounded set now** (evict by age/count). Deferred (F4): bounding is itself an
  eviction an agent could exploit by flooding the set, so a safe bound needs its
  own design; the grow-only set is the safe v0 default, verbosity accepted.
- **Put the set in a standalone synthesizer, not the arbiter.** Rejected: the
  arbiter already observes every `belief.adopted` and owns the belief projection;
  a second observer would duplicate the feed for no gain. The arbiter exposes the
  set as data (`observedBeliefIds`) and the host owns the Decision shape.
