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

- **Window = peeked at synthesis, consumed on execution; not cumulative.** The
  arbiter accumulates belief ids from the `belief.adopted` events it observes (it
  already projects them for `resolveContext`). `peekRecentBeliefIds()` returns a
  *copy* of that buffer without clearing it; the proxy calls it immediately before
  `kernel.propose`, builds a `Decision` whose `belief_dependencies` are the peeked
  ids, emits `decision.made`, and proposes the action with that `decision_id`. The
  beliefs are removed only later, via `consumeBeliefIds(snapshot)`, **once the
  dependent action actually executes** (`executed.phase === "completed"`). An
  empty window (the first read of a session) synthesizes nothing — the action
  carries no `decision_id` and is gated only by contract + rule + subject-agnostic
  signals, exactly as today.

  *Why consume-on-execution, not drain-at-synthesis (Codex P1, round 2):* the
  proxy's `approval_required` / `approval_timeout` results are, by design, *soft*
  denials the agent re-plans around — it re-proposes the same `tools/call`. If the
  window were drained at synthesis, a held call would consume the poisoned beliefs
  even though it never acted on them, and the **retry would find an empty window,
  synthesize no decision, and slip through the gate** — a real bypass via a
  first-class flow. Deferring consumption to execution closes it: a held / denied
  / failed action leaves the window intact, so every re-proposal re-reads the same
  beliefs and stays gated; only an action that *executes* consumes them (it has
  now genuinely acted on what it read). Beliefs the executing action's own result
  adopts land *after* the peeked snapshot, so they correctly become the next
  action's window rather than being consumed with it.

  *Why not cumulative:* a cumulative "every belief ever seen backs every action"
  window over-gates so coarsely it is useless for audit. Consume-on-execution is
  bounded the other way: once an action executes and consumes the window, the next
  genuinely-different action starts fresh (plus that action's own results), so a
  clean action *after a consumed read* is not gated — scoping stays legible across
  the execute boundary. The only stickiness is intentional: an unresolved poisoned
  read (its dependent action held, never approved) keeps gating until it is
  granted or the session ends — the safe direction for an opaque adversarial
  agent, and the same "the dependency persists until the agent acts" behaviour
  `guard.wrap()` gets for free (its agent re-declares the decision on retry).

- **Concurrency: synchronous peek/consume, documented best-effort.** Both
  `peekRecentBeliefIds()` (copy) and `consumeBeliefIds(ids)` (set-filter) are
  synchronous — atomic in the JS single-threaded model, so two overlapping
  `handleCallTool`s never tear the buffer, and consume removes only the specific
  snapshot ids (overlap cannot blow away a concurrent peek's beliefs the way a
  blanket clear could). The residual *semantic* cost of overlap is attribution
  fuzz: two concurrently-proposed actions peek the same window and both link it.
  That errs toward over-gating (the safe direction), and we accept it for v0
  because (a) it is the same best-effort concurrency posture the proxy already
  documents (guard invariant 3; captures keyed by action id, the chain not
  serialised); (b) the primary threat — read untrusted content, *then* act — is
  causally sequential. A timestamp-ordered window is a hardening follow-up (P3),
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
`ctx.recordDecision` in guard; synthesized via `peekRecentBeliefIds()` +
`consumeBeliefIds()` in the proxy). The recency buffer it now also maintains is
the one reusable primitive ADR-0002 anticipated ("a reusable 'decision from
recent beliefs' helper").

## Consequences

- The proxy completes the epistemic chain it previously skipped: held actions now
  carry a Decision link explaining *why* they were gated (which beliefs, which
  alert), not just a bare `pending_approval`.
- Wiring `suspicious-memory-origin` into the proxy means the action that depends
  on an `external_document`-rooted read is held — and, because the read is not
  consumed until a dependent action *executes*, it keeps gating re-proposals until
  one is approved. The conservative, opt-in posture for an opaque agent over
  untrusted downstreams; operators dial it with which sentinels they enable.
- The concurrency gap is explicit and small; closing it (ordered window) is
  scoped to P3 hardening alongside the deferred arbiter items (F1/F4/F6).
- The synthesis layer is a small new public surface (`peekRecentBeliefIds`,
  `consumeBeliefIds`, `PROXY_DECISION_SYNTHESIS_ACTOR`) and one new arbiter feed in
  the proxy's `emit` — no new schema, no new core type.

## Alternatives considered

- **Cumulative session window** (every belief backs every action). Rejected:
  over-gates uselessly and destroys the gate's scoping legibility — a
  belief-scoped alert could never be demonstrated to spare an unrelated action.
- **`tool_sequence`-only gating, no synthesis.** Rejected (already by ADR-0002):
  belief-scoped alerts — the whole `suspicious-memory-origin` story — would
  silently never fire in the proxy.
- **Drain the window at synthesis.** Rejected (Codex P1, round 2): a held / denied
  call would consume beliefs it never acted on, so the agent's re-proposal of that
  call would find an empty window and slip through the gate. Consume-on-execution
  is the fix.
- **Serialise all proxied calls to make the window exact.** Rejected: throws away
  the proxy's overlapping-call support for a precision the sequential threat does
  not need; the documented best-effort peek/consume is the right cost/benefit.
- **Put the window in a standalone synthesizer, not the arbiter.** Rejected: the
  arbiter already observes every `belief.adopted` and owns the belief projection;
  a second observer would duplicate the feed for no gain. The arbiter exposes the
  window as data (`peekRecentBeliefIds` / `consumeBeliefIds`) and the host owns
  the Decision shape.
