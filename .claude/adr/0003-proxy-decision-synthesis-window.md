# ADR-0003: MCP-proxy decision synthesis — the causal-recency window

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

**The proxy synthesizes a `decision.made` per action from a causal-recency
window: the belief ids adopted since the previous synthesized decision.**

- **Window = drained-on-synthesis, not cumulative.** The arbiter accumulates
  belief ids from the `belief.adopted` events it observes (it already projects
  them for `resolveContext`). `drainRecentBeliefIds()` returns that buffer and
  clears it; the proxy calls it immediately before `kernel.propose`, builds a
  `Decision` whose `belief_dependencies` are the drained ids, emits
  `decision.made`, and proposes the action with that `decision_id`. An empty
  window (the first read of a session) synthesizes nothing — the action carries
  no `decision_id` and is gated only by contract + rule + subject-agnostic
  signals, exactly as today.

  *Why drained, not cumulative:* a cumulative "every belief ever seen backs every
  action" window over-gates so coarsely it is useless for audit — one
  external-document read would hold every subsequent action for the whole
  session, and a belief-scoped alert could never be shown to be *scoped*. The
  recency window over-links only the *recent* beliefs (still the safe direction
  ADR-0002 endorses for the sequential read-then-act threat) while keeping the
  gate's scoping legible: the action that follows the poisoned read is held; a
  later action that follows only a clean read is not.

- **Concurrency: synchronous atomic drain, documented best-effort.**
  `drainRecentBeliefIds()` is a synchronous read-and-clear — atomic in the JS
  single-threaded model, so two overlapping `handleCallTool`s never tear the
  buffer. The *semantic* cost of overlap is under-attribution: whichever propose
  drains first takes the window; a concurrent propose links fewer beliefs (or
  none). This is a genuine gap — a concurrently-proposed action could miss a
  belief-scoped alert it "should" have been gated by — and we accept it for v0
  for three reasons: (a) it is the same best-effort concurrency posture the proxy
  already documents (guard invariant 3; the proxy keys captures by action id but
  does not serialise the chain); (b) the primary threat — an agent reads
  untrusted content, *then* acts on it — is causally sequential by construction;
  (c) the low-confidence and `tool_sequence` signals remain partial backstops. A
  timestamp-ordered window that survives overlap is a hardening follow-up (P3),
  noted in code.

- **Rendering: synthesized decisions are honest, attributed to a synthesis
  actor.** A synthesized `Decision` sets `made_by` to a dedicated actor
  (`PROXY_DECISION_SYNTHESIS_ACTOR = "lodestar-proxy-synthesis"`), and the proxy
  stamps the `decision.made` envelope's `actor_id` the same way — exactly as a
  `sentinel.alerted` is attributed to the sentinel actor, not the governed agent
  (ADR-0001 / P1a Codex round 2). Its `question` states it was synthesized from
  the causal-recency window. `lodestar report` renders it as a real Decision link
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
`ctx.recordDecision` in guard; synthesized via `drainRecentBeliefIds()` in the
proxy). The recency buffer it now also maintains is the one reusable primitive
ADR-0002 anticipated ("a reusable 'decision from recent beliefs' helper").

## Consequences

- The proxy completes the epistemic chain it previously skipped: held actions now
  carry a Decision link explaining *why* they were gated (which beliefs, which
  alert), not just a bare `pending_approval`.
- Wiring `suspicious-memory-origin` into the proxy with the recency window means
  **every** action that follows an `external_document`-rooted read is held — the
  conservative, opt-in posture for an opaque agent over untrusted downstreams.
  Operators dial this with which sentinels they enable, not with the window.
- The concurrency gap is explicit and small; closing it (ordered window) is
  scoped to P3 hardening alongside the deferred arbiter items (F1/F4/F6).
- The synthesis layer is one new public surface (`drainRecentBeliefIds`,
  `PROXY_DECISION_SYNTHESIS_ACTOR`) and one new arbiter feed in the proxy's
  `emit` — no new schema, no new core type.

## Alternatives considered

- **Cumulative session window** (every belief backs every action). Rejected:
  over-gates uselessly and destroys the gate's scoping legibility — a
  belief-scoped alert could never be demonstrated to spare an unrelated action.
- **`tool_sequence`-only gating, no synthesis.** Rejected (already by ADR-0002):
  belief-scoped alerts — the whole `suspicious-memory-origin` story — would
  silently never fire in the proxy.
- **Serialise all proxied calls to make the window exact.** Rejected: throws away
  the proxy's overlapping-call support for a precision the sequential threat does
  not need; the documented best-effort drain is the right cost/benefit for v0.
- **Put the window in a standalone synthesizer, not the arbiter.** Rejected: the
  arbiter already observes every `belief.adopted` and owns the belief projection;
  a second observer would duplicate the feed for no gain. The arbiter exposes the
  window as data (`drainRecentBeliefIds`) and the host owns the Decision shape.
