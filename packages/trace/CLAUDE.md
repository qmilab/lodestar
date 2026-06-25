# @qmilab/lodestar-trace — CLAUDE.md

The read side of the event log. The package consumes an existing log and
projects it into the epistemic chain, then renders markdown.

## What lives here

- `src/chain.ts` — `projectChain()` projects a flat event stream into
  the epistemic chain primitives (Observations, Claims, Beliefs,
  Actions, firewall transitions). Pure function. No I/O.
- `src/wire.ts` — `toWireProjection(projection)` is the JSON-safe
  serialization of a `ChainProjection` (and the `WireProjection` type):
  `actor_ids` (`Set<string>`) becomes an array — the one non-JSON-safe
  field — and the heavy verbatim `raw_events` is dropped. Pure, no I/O, in
  the same family as `projectChain`. Graduated here from
  `@qmilab/lodestar-viewer` (issue #139), which re-exports it unchanged so a
  consumer that only wants to JSON-serialize a projection need not pull in
  the viewer's HTTP server (Elysia). It is the serializer the stable
  `projectChain` contract points integrators at.
- `src/approvals.ts` — `pendingApprovals(events)` derives the open-hold
  queue (every `approval.requested@1` with no terminal resolution in the
  log) and the `PendingApproval` type. Pure projection in the same family
  as `projectChain` — no I/O, read-only. Graduated here from
  `@qmilab/lodestar-viewer` (issue #138), which re-exports it unchanged so
  a consumer that only wants open holds need not pull in the viewer's HTTP
  server. **Forgery-aware:** a grant/deny the guard refused to promote (a
  `guard.approval.signature_rejected` audit) is not counted as a
  resolution; a `source: "log"` rejection names the specific forged event
  (`rejected_event_id`) so it is excluded precisely, leaving a genuine grant
  submitted afterwards to still resolve the request. The projection never
  re-verifies signatures (it has no access to the operator's pinned keys —
  the correct boundary); it trusts the guard's audit. Mirrors
  `collectResolvedRequestIds` in the `lodestar approve` CLI.
- `src/harvest.ts` — `harvestCandidates(events)` derives the **durable-memory
  harvest queue** (every supported, clean, retrievable belief worth offering a
  human as a keeper *lesson*, with its evidence + provenance) and the
  `MemoryCandidate` / `SupersededLesson` types. Pure projection in the same
  family as `projectChain` / `pendingApprovals` — no I/O, read-only (ADR-0031,
  epic #154 item D). **Lifecycle is reconstructed, not snapshot-read:** a belief
  enters via `belief.adopted` (full `Belief`) and its axes may move via
  `firewall.belief.transitioned`; the projection replays those in clock order, so
  a belief adopted `unverified` then promoted to `supported` *is* a candidate.
  Both adoption and transitions are trusted **only when firewall-authored** — a
  governed agent's `ctx.emit` is pinned to the session schema version and cannot
  stamp the firewall's (`FIREWALL_EVENT_SCHEMA_VERSION`): a `belief.adopted` is
  surfaced only when a host-authored `firewall.belief.adopted@1` audit confirms the
  same `belief_id` **and matching `claim_id`** (taken first-wins, so a later forged
  re-emit can't overwrite content), the candidate's evidence is the exact set the
  audit's `evidence_id` names (not the latest for the claim) — and the surfaced
  claim + evidence **content** is first-wins per id too (a later same-id
  `claim.extracted` / `evidence.assessed` can't overwrite an authenticated belief's
  provenance) — and a transition is honoured only with the canonical type + that
  schema stamp + a strict payload (so no forged `security_status → clean`
  clearance). Authentication is **per-session** (the projection processes each
  `(project_id, session_id)` independently), so a firewall audit from one session
  can't authenticate a record from another over a project-wide list. The security
  gate applies to supersession **history** too: a quarantined / hard-demoted
  predecessor is kept out of `supersedes`.
  **Candidacy gate (ADR-0033):** current `truth_status: supported` **and**
  `security_status: clean` **and** `retrieval_status` ∈ {`normal`, `restricted`}
  — the security-relevant subset of `DEFAULT_CONTEXT_POLICY`, so a quarantined /
  hard-demoted belief cannot launder past the firewall into the human "Keep"
  queue (no-self-promotion, extended to durable memory). Freshness / sensitivity
  / scope / confidence are **surfaced, not gated** (the reviewer's call; the
  session shipper owns the egress sensitivity ceiling). **Supersession** is
  surfaced as the successor's newest-first `supersedes` audit trail
  (`truth_status: superseded`), never a separate top-level candidate — replacement
  with the history preserved, not overwritten. Advisory only — every item is
  `status: "candidate"`; keeping a lesson is a separate write-side surface.
- `src/report.ts` — `renderReport()` turns a projection into markdown.
- `src/load.ts` — convenience wrappers around `EventLogReader` for the
  CLI; finds project directories and the default log root.
- `src/inspect.ts` — `describeEvent()` / `findEventById()` for the
  `lodestar trace inspect` debug surface.
- `src/cli.ts` — `lodestar-report` bin. The unified CLI dispatches into
  this.

## Invariants

1. **Read-only.** This package never writes to the event log. Every
   path is `readFile` and pure projection.
2. **Tolerant projection.** Unrecognised events do not throw. They are
   counted but kept in `raw_events` for the optional event-log section.
   This lets the report degrade gracefully when the underlying log is
   ahead of `@qmilab/lodestar-trace`'s known event types.
3. **No schema invention.** When an event payload is structurally
   incompatible with a chain primitive (e.g. `firewall.claim.accepted`
   only carries IDs), the projection records the transition but does
   not attempt to fill in fields it doesn't have. The rendered report
   shows what is actually in the log.
4. **`lodestar report` is the headline surface.** Polish it. Other
   exports (`describeEvent`, `findEventById`, `loadSessionEvents`) can
   be sharper-edged.

## What does not live here

- Live event streaming or subscription — Batch 3 / harness territory.
- OTel export — see the `@qmilab/lodestar-otel-exporter` package, which
  reuses this package's `projectChain()` to project a session into OTel
  GenAI spans (`lodestar otel export`).
- Snapshot reconstruction (replay-grade re-derivation of belief stores
  from events) — out of scope until snapshots ship.

## When adding a new chain primitive

1. Add the primitive in `@qmilab/lodestar-core` first.
2. Update `projectChain()` to recognise the corresponding event type.
3. Add a renderer in `renderReport()` so the new primitive shows up
   in the markdown.
4. If the primitive is something a user actually needs to see, add a
   section header to the report — keep the report scannable, not
   comprehensive.
