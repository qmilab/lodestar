# @qmilab/lodestar-viewer — CLAUDE.md

The read-side Governing UI. A local, **strictly read-only** web viewer
over the event log. It reuses `@qmilab/lodestar-trace`'s `projectChain()`
and `renderReport()` and serves them through Elysia + a no-build vanilla
SPA. It is the live, interactive sibling of `lodestar report`.

The CLI entry point is `lodestar view [session-id]` (in
`@qmilab/lodestar-cli`); this package owns the server and the SPA.

## What lives here

- `src/server.ts` — `startViewer(opts)` builds the Elysia app and listens
  on loopback, returning a `ViewerHandle` (`{ url, host, port, logRoot,
  stop() }`). All routes are `GET`. The Elysia instance is intentionally
  **not** exported, so its deeply-generic type never reaches the package's
  public `.d.ts` (declaration emit under `composite` would otherwise
  choke). Includes the SSE live-tail (`/stream`) — the event log has no
  native tail, so the server re-reads the session on a short interval and
  emits new envelopes; polling stops on client disconnect.
- `src/sessions.ts` — `listSessions(logRoot)` (one summary per
  `(project_id, session_id)`) and `readAllEvents(logRoot)`. Also
  re-exports `pendingApprovals` / `PendingApproval`, which graduated to
  `@qmilab/lodestar-trace` (issue #138) — the queue projection is a pure,
  I/O-free read in the same family as `projectChain`, so it lives next to
  the chain projection; the viewer re-exports it unchanged for source
  compatibility.
- `src/wire.ts` — re-exports `toWireProjection` / `WireProjection`, which
  graduated to `@qmilab/lodestar-trace` (issue #139) — a pure `Set → array`
  serialization of a `ChainProjection` in the same family as `projectChain`,
  so a consumer that only wants to JSON-serialize a projection need not pull
  in this package's HTTP server. The server still imports it from here; the
  viewer re-exports it unchanged for source compatibility. (The conversion:
  `actor_ids` is a `Set`, which `JSON.stringify` turns into `{}`, so it
  becomes an array; the heavy `raw_events` is dropped — the `/events`
  endpoint and the SSE stream carry raw envelopes.)
- `src/public/` — the SPA: `index.html`, `app.css`, `app.js`. Plain
  HTML/CSS/vanilla JS, **no build step**. Served via `Bun.file()` relative
  to `import.meta.dir`, so it resolves under `src/` when run from source
  under Bun (the dev + probe path). The CSS uses custom properties as
  brand tokens so the future write-side can re-skin without forking.

## Invariants

1. **Read-only — no mutation surface.** Every route is a `GET` and every
   handler is a pure read + projection. There is no route that writes the
   log, resolves an approval, or mutates anything. Pending approvals are
   *surfaced* (so an operator can see what is waiting), never resolved —
   resolution is the separate write-side surface (`lodestar approve`, or
   a separate write-side product). The `viewer-is-read-only`
   probe (`packs/lodestar-core/`) locks this: it asserts no mutation route
   exists and that the on-disk log is byte-for-byte unchanged after
   serving. If you add a write route, that probe trips — that is the point.

2. **Loopback by default; the log is sensitive.** `startViewer` binds
   `127.0.0.1`. The event log can carry `secret`-sensitivity beliefs and
   verbatim attacker-controlled content (poisoned files, injected tool
   output), so localhost is the trust boundary — exactly as for
   `lodestar report`. Never bind a non-loopback interface without an auth
   layer in front. Authenticated, multi-user exposure is the write-side's
   job, not this viewer's.

3. **The SPA treats all log content as hostile.** The browser client
   inserts every dynamic string as a text node or HTML-escapes it first.
   The only `innerHTML` assignment is the markdown renderer, which escapes
   its source before adding its own structural tags. A regression that
   renders raw log content as HTML is an XSS hole — the poisoned-file
   threat model is the whole reason the firewall exists.

4. **Reuse the trace read side; do not re-project.** Chain projection and
   report rendering belong to `@qmilab/lodestar-trace`. This package wraps
   them in HTTP + a UI; it must not grow its own projection logic. When the
   chain gains a primitive, it lands in core → trace → here, in that order.

## What does not live here

- Any write path. Approvals, policy edits, belief edits — all write-side,
  out of scope by design.
- The chain projection / report rendering themselves — see
  `@qmilab/lodestar-trace`.
- A bundler / framework toolchain. The open read-side stays no-build; a
  framework-rich UX is an external write-side surface's concern.
- Indexed / time-range log queries. v0 lists by reading each project's log
  in full (the same whole-log scan `findProjectForSession` already does).
  Fine for local logs; an index is a later concern.

## When you add an endpoint

- It is a `GET`. If you reach for `POST`/`PUT`/`DELETE`, stop — that is the
  write-side surface, not this package.
- Keep the Elysia instance internal; expose new capability through
  `startViewer`'s handle or a plain exported function, never by leaking the
  Elysia type.
- If it serves log-derived strings to the browser, confirm the SPA escapes
  them before render.
