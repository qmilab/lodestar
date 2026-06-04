# @qmilab/lodestar-guard — CLAUDE.md

A meta-package. Mostly re-exports plus one helper (`wrap`).

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
  resolves a held action (see invariant 5).
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
   `guard.session.failed`), plus the core `approval.*` wire events the hold
   path emits (`approval.requested@1`, `approval.granted@1`,
   `approval.denied@1`, `approval.expired@1`) — all already defined in
   `@qmilab/lodestar-core`, none new.
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

## What does not live here

- MCP proxy mode — `@qmilab/lodestar-guard-mcp` (shipped).
- The signed/declarative policy engine itself — `@qmilab/lodestar-policy-kernel`
  (shipped; guard re-exports `autoApprovePolicy` + `compile` + the approval
  lifecycle from it and wires the in-process resolver seam around it).
- The MCP proxy's deadline / out-of-band hold-resolution loop and the
  `lodestar approve` reference CLI — later host-wiring slices.
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
