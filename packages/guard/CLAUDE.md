# @qmilab/lodestar-guard — CLAUDE.md

A meta-package. Mostly re-exports plus two helpers: `wrap` and the
`SentinelArbiter` sentinel→action bridge.

## What lives here

- `src/index.ts` — re-exports from `@qmilab/lodestar-event-log`,
  `@qmilab/lodestar-action-kernel`, `@qmilab/lodestar-memory-firewall`,
  `@qmilab/lodestar-cognitive-core`, and selected types from `@qmilab/lodestar-core`. Plus
  the local helpers below.
- `src/wrap.ts` — `wrap(loop)` and `runGuarded(loop, config)`. Wires up
  one fresh session per invocation: writer, in-memory stores, firewall,
  cognitive core, kernel. Calls the loop with a `GuardContext`. The
  evidence linker defaults to `EvidenceLinker` unless the caller supplies
  `config.cognitive.evidenceLinkerFactory`.
- `src/types.ts` — `GuardConfig`, `GuardContext`, `CallToolOptions`,
  `CallToolResult`, `GuardRunResult`, `GuardInternals`, `ApprovalResolver`.
  `GuardConfig.cognitive.evidenceLinkerFactory` is the additive seam for
  injecting a custom evidence linker (e.g. `DocAwareEvidenceLinker` for the
  documentation-agent example), built per session from the session's
  evidence/belief stores. Mirrors the `stores` seam — add new cognitive
  overrides under the same `cognitive` bag rather than widening `GuardConfig`.
  `GuardConfig.policy_gate` accepts either a bare `PolicyGate` or a
  `CompiledPolicy`; `GuardConfig.approval_resolver` is the in-process seam that
  resolves a held action (see invariant 5); `GuardConfig.arbiter` wires the
  sentinel→action bridge (see invariant 6). `GuardContext.recordDecision` is the
  trusted channel an agent uses to declare a decision's `belief_dependencies`
  (feeds the arbiter); the raw `GuardContext.emit` logs but is not trusted for
  arbitration.
- `src/sentinel-arbiter.ts` — `SentinelArbiter` + `compileWithSentinels`. The
  host-side glue that gives sentinel alerts teeth (ADR-0001,
  `docs/architecture/policy-kernel.md` "The arbitrate hook"). The arbiter is fed
  every host-authored event (`observe`); it runs a harness `SentinelRunner`,
  buffers the alerts that land, and projects `decision.made → belief_dependencies`
  and `belief.adopted → { calibration_class, confidence, truth_status }` from the
  same stream. It is **single-session**: a host binds it (`bindSession`, or lazily
  on the first event) and `resolveContext` reports exactly that session — never
  "whichever event was seen last" (which would race under concurrent reuse). A
  second concurrent session on the same arbiter is rejected loudly at
  `bindSession`; a session-end unbinds and clears, so sequential reuse is fine. It
  also exposes `actorId` (the sentinel actor) so the host attributes
  `sentinel.alerted@1` to the sentinel, not the agent. `resolveContext(action)` turns that into the gate's
  `ArbitrationContext` (the buffered alerts, the action's backing beliefs, an
  optional calibration snapshot). `compileWithSentinels(policy, { sentinels, … })`
  is the one-call form that wires the arbiter's `resolveContext` into the
  compiled gate and returns the matched `{ gate, arbiter }` pair. This is the new
  `guard → @qmilab/lodestar-harness` dependency. The arbiter never writes the log
  itself — `observe()` *returns* the alerts and `wrap` emits them as
  `sentinel.alerted@1` on its own writer, so the session stays the sole writer. It
  also exposes `drainRecentBeliefIds()` — the causal-recency window (belief ids
  since the last drain, projected from `belief.adopted`) the **MCP proxy** drains
  to synthesize a decision for its opaque agent (ADR-0003); guard.wrap() uses
  declared decisions and never drains it.
- `src/policy-presets.ts` — `alwaysHoldsChecker` only. `autoApprovePolicy` has
  **graduated** into `@qmilab/lodestar-policy-kernel` (it now honours the
  trust-ladder floor: L4 always holds, L5 denies; its ceiling caps at L3) and is
  re-exported from `src/index.ts` for source compatibility, alongside `compile`
  and the approval-lifecycle helpers (`openApprovalRequest`,
  `authorizeResolution`, `expireRequest`, `holdEvaluationForParkedAction`).
  Neither preset is a default; both must be invoked by name.

## Invariants

1. **No silent defaults for security-relevant settings.** `policy_gate`
   and `precondition_checker` are required fields on `GuardConfig`. The
   helpers `autoApprovePolicy()` and `alwaysHoldsChecker` exist but
   must be invoked by name with explicit parameters — Guard never
   auto-approves on the caller's behalf.
2. **One session per `runGuarded` call.** Each invocation constructs a
   new event-log writer and a new session_id, and builds fresh in-memory
   firewall stores — *unless* the caller injects their own via
   `GuardConfig.stores` (e.g. the Postgres stores from
   `@qmilab/lodestar-memory-firewall/postgres`, to share durable state
   across sessions). Injected stores are caller-owned: `runGuarded` never
   opens or closes their connection, and returns the same handles on
   `GuardRunResult.internals`. The package does not currently support
   reusing a guarded *context* across multiple loop invocations.
3. **Sequential tool calls within a session.** Two parallel `callTool`s
   in the same `GuardContext` may race on the shared observation-sink
   capture. Multi-process / parallel-tool safety is a Batch 3 concern
   that lands with the MCP proxy.
4. **No new schemas.** Guard does not extend `@qmilab/lodestar-core`. All
   event payloads are existing chain primitives or simple status events
   (`guard.session.started`, `guard.session.ended`,
   `guard.session.failed`, and `guard.sentinel.failed` — the best-effort
   record written when the arbiter feed throws; see invariant 6), plus the core
   `approval.*` wire events the hold path emits (`approval.requested@1`,
   `approval.granted@1`, `approval.denied@1`, `approval.expired@1`) and the
   `sentinel.alerted@1` events the arbiter surfaces (stamped with the canonical
   `SENTINEL_ALERTED_SCHEMA_VERSION` + the sentinel `actorId`, matching the harness
   alert sink) — all already defined in `@qmilab/lodestar-core`, none new.
5. **A hold needs a resolver — no silent default.** The three-valued gate's
   third outcome is `hold`: a held action is parked at `pending_approval` and
   `callTool` resolves it through `GuardConfig.approval_resolver` (open an
   `ApprovalRequest`, emit `approval.requested@1`, await the resolver, emit the
   resolver's `approval.granted@1`/`approval.denied@1`/`approval.expired@1`,
   then un-park via `ActionKernel.resolve()`). If an action is held and no
   resolver is configured, `callTool` **throws** — it never silently approves or
   denies. The field is optional only because guard cannot statically introspect
   an opaque `PolicyGate`; the runtime check is the load-bearing guard. The
   resolver owns authorisation (match an approver against
   `request.required_authority` via `authorizeResolution`) and must return an
   outcome bound to the request — `resolve()` rejects a mis-bound one.
6. **Sentinels gate only through a wired arbiter — and only when the agent
   declares its decisions.** `GuardConfig.arbiter` is the seam; supplying it (with
   `policy_gate` compiled from the *same* arbiter, i.e. the `compileWithSentinels`
   pair) is the only thing that lets a sentinel alert / calibration flag /
   low-confidence belief escalate an action. Omit it and the gate keeps its pure
   contract+rule behaviour — sentinels still only observe. The arbiter scopes a
   belief-subject alert to an action via `action.decision_id →
   belief_dependencies`, so the agent declares decisions through
   **`ctx.recordDecision`** for belief-scoped gating to bite; an action with no
   decision link is gated only by subject-agnostic signals (a `tool_sequence`
   alert). The arbiter never blocks or calls back into the kernel — enforcement
   lives in the gate. Because arbitration can produce a *hold*, `approval_resolver`
   (invariant 5) is required alongside it.
   **Only host-authored events feed the arbiter** — `ctx.recordDecision` and
   guard's own emits do, the raw agent-facing `ctx.emit` does NOT (it passes
   `feedArbiter: false`). That is the security boundary: an agent loop must not be
   able to forge a `guard.session.ended` (to clear buffered alerts) or a
   `belief.adopted` (to overwrite a flagged belief) and bypass the gate it is
   subject to. The arbiter is **single-session**: `runGuarded` binds it
   (`bindSession`) at session start, `resolveContext` reports that one session
   (never "whichever event was seen last"), and a second concurrent session on the
   same arbiter throws at `bindSession` rather than silently cross-talking; a
   session-end unbinds and clears, so sequential reuse is fine. A host emits the
   arbiter's `sentinel.alerted@1` with the sentinel `actorId`, so the audit
   attributes the alert to the sentinel, not the governed agent. The feed is
   **best-effort and non-blocking**: a throw from a
   sentinel (or a finding that fails schema validation) is caught in `emit`, logged
   as a `guard.sentinel.failed` status event, and swallowed — a faulty/hostile
   sentinel degrades observability but never aborts the governed session. The
   arbiter ignores `sentinel.alerted` events, so its own output cannot recurse the
   feed regardless of the sentinel set.

## What does not live here

- MCP proxy mode — `@qmilab/lodestar-guard-mcp` (shipped).
- The signed/declarative policy engine itself — `@qmilab/lodestar-policy-kernel`
  (shipped; guard re-exports `autoApprovePolicy` + `compile` + the approval
  lifecycle from it and wires the in-process resolver seam around it).
- The MCP proxy's deadline / out-of-band hold-resolution loop and the
  `lodestar approve` reference CLI — later host-wiring slices.
- The MCP proxy's *use* of the arbiter. The `SentinelArbiter` is reusable
  (guard-mcp depends on guard) and now ships a `drainRecentBeliefIds()` primitive
  — the proxy's wrapped agent is opaque and cannot declare `decision.made` over
  MCP, so guard-mcp drains the arbiter's causal-recency window to **synthesize** a
  decision per action (ADR-0002, ADR-0003). The recency buffer lives in the
  arbiter (populated from `belief.adopted`, cleared on session end); guard.wrap()
  uses declared decisions and never drains it. The proxy-side wiring itself lives
  in `@qmilab/lodestar-guard-mcp`.
- **Three deferred arbiter-hardening items (from the PR #54 review):** (F1)
  re-projecting `firewall.belief.transitioned` so the belief cache reflects
  post-adoption truth_status — needs a policy-kernel gate-semantics call on
  whether `contradicted`/`superseded` should gate (the low-conf signal tests only
  `=== "unverified"`); today the staleness only skews conservative. (F4) a bounded
  alert recency window so a `tool_sequence` alert does not stay sticky for a whole
  long session. (F6) a binding token so a hand-wired `arbiter`/`policy_gate`
  mismatch fails loudly instead of observing-but-not-gating (`compileWithSentinels`
  is the safe path today). These belong with the P1 hardening / P3 security track.
- Anything that consumes the event log on the read side — that's
  `@qmilab/lodestar-trace`.

## When changing `wrap`

- The shape of `GuardContext` is part of the public API. Add new fields
  before removing or renaming existing ones.
- Every event written by `wrap` carries the configured `project_id`,
  `session_id`, and `actor_id`. `lodestar report` relies on session_id
  to slice the log.
- New event types should be additive. Existing consumers (the trace
  package, examples) must keep working with old event types.
