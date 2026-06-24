# ADR-0030: A writer-free `./approval-channel` subpath on `@qmilab/lodestar-guard`

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Nandan
- **Related:** ADR-0015 (the `ApprovalChannel` transport seam), ADR-0024/0025 (the
  signed `.approvals/` reader's graduation into `-guard`), Issue #152, Epic #140,
  docs/reference/public-api.md

## Context

`@qmilab/lodestar-guard` exposes a single entry (`.`). Its barrel (`src/index.ts`)
re-exports `wrap()` / `runGuarded()` — the write side — alongside the approval
transport seam (`./approval-channel.ts`) and the signed-resolution wire reader
(`./approvals-channel.ts`). Because ESM evaluates the whole barrel graph, *any*
import from the package drags the full write-side runtime: action-kernel,
memory-firewall, cognitive-core, harness (all real runtime `dependencies`).

That is wrong for the channel's intended audience. By design (ADR-0015) an
`ApprovalChannel` is an UNTRUSTED cross-process transport: a consumer that only
moves approval bytes and signature-verifies them *after* transport — an external
integrator, a relay or read-side consumer, an integration test exercising the real
client — has no business linking the agent runtime. The channel graph is already
clean of the write side at runtime (`approval-channel.ts` imports only core / zod /
the sibling reader; `approvals-channel.ts` imports only `node:*` / zod / core and a
**type-only** `ApprovalOutcome` from action-kernel, erased at compile). `tsc -b`
already emits per-file dist. So the drag is a packaging artifact of the single
barrel, not a code-separation problem.

## Decision

Add a second export to `packages/guard/package.json`, `./approval-channel`, with the
same 4-condition shape as the existing `@qmilab/lodestar-memory-firewall/postgres`
precedent (`bun` → src, `types` / `import` / `default` → dist). It points at a new
re-export-only barrel `src/channel.ts` that `export *`s from both
`./approval-channel.js` (the transport seam) and `./approvals-channel.js` (the signed
wire reader) — so a writer-free consumer gets the client *and* the resolution reader
from one path without ever evaluating the `.` barrel.

The writer-free property is **enforced, not intended**: `src/channel.test.ts`
statically walks the runtime module graph from `channel.ts`, follows relative
imports, skips `import type` / `export type` edges (erased from dist), and asserts
the transitive bare-package set is a subset of `{ @qmilab/lodestar-core, zod }`
(+ `node:*`) — and that none of action-kernel / event-log / memory-firewall /
cognitive-core / harness / policy-kernel appears at runtime. The test also asserts
the walk actually descended (reached core + zod), so a parser regression can't pass
vacuously, and that the subpath specifier resolves and re-exports the expected
surface.

The `.` barrel is left unchanged — the subpath is the writer-free *alternative*, not
a move. The channel stays in `guard` (it pairs with the side-channel writer there).

## Consequences

- An untrusted/read-side/integration consumer links `{ core, zod, node:* }` instead
  of the whole write-side runtime — smaller graph, no agent-runtime coupling, honest
  to ADR-0015's "a channel only moves bytes" posture.
- One small invariant test now guards the boundary; if a future edit makes the
  channel reach into the write side (or turns the type-only action-kernel import into
  a runtime one), CI fails with the offender named.
- No behaviour, wire-format, or `.`-barrel-surface change — pure packaging plus a
  test. Back-compatible.
- Caveat recorded in the issue and the public-API ledger: the approval-specific
  Ed25519 helper `verifyApprovalSignature` lives in `@qmilab/lodestar-policy-kernel`,
  whose `.` barrel still pulls action-kernel + event-log at runtime (via
  `sensitivityForContract`). A strictly writer-free verifier should use the raw
  `verifyPayloadHashSignature` primitive from `@qmilab/lodestar-core`, or a follow-up
  can give policy-kernel its own writer-free signature subpath. This ADR does not
  block on that — the channel subpath is independent of it.

## Alternatives considered

- **Point the subpath straight at `approval-channel.ts`** (zero new files). Rejected
  as the headline option because it would omit the signed-resolution reader
  (`approvals-channel.ts`), which a verifying consumer also needs; the focused
  `channel.ts` barrel bundles both. (Kept as the documented minimal fallback.)
- **Move the channel into its own package.** Rejected — the channel pairs with the
  `.approvals/` side-channel writer that lives in `guard`; a split buys nothing here
  and adds publish/version bookkeeping.
- **Strip the channel symbols from the `.` barrel.** Rejected — breaks back-compat
  for existing importers; the subpath is additive.
