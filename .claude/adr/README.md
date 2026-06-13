# Architecture Decision Records (`.claude/adr/`)

Short, durable records of **agent-facing** decisions: how a piece of work is
being approached, what was deliberately deferred, and why. These complement —
they do not replace — the contributor-facing design locks in
`docs/architecture/` (v0.2 delta, policy-kernel, sentinels, …). Rule of thumb:

- **`docs/architecture/`** — the *what* of the system: schemas, invariants, the
  locked design a contributor reads to understand the code.
- **`.claude/adr/`** — the *how/when/why-this-order* of the work: sequencing,
  rollout splits, host-by-host mechanism choices, and the trade-offs behind
  them. The kind of decision that would otherwise live only in a chat transcript.

## Convention

- One decision per file, numbered `NNNN-kebab-title.md` (zero-padded, monotonic).
- Status is one of `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`.
- Never rewrite history: to change a decision, add a new ADR that supersedes the
  old one and flip the old one's status. The record of *why we changed our mind*
  is the point.
- Keep them tight. An ADR is a paragraph of context, the decision, and the
  consequences — not a design doc.

## Template

```markdown
# ADR-NNNN: <title>

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Deciders:** <names>
- **Related:** ADR-NNNN, docs/architecture/<file>, PR #NN

## Context
What forces are in play? What constraint or gap prompted a choice?

## Decision
What we are doing, stated in the active voice.

## Consequences
What becomes easier, what becomes harder, what we accept as a result.

## Alternatives considered
The options we rejected, each with a one-line reason.
```

## Index

- [ADR-0001](0001-sentinel-action-arbitration-bridge.md) — Sentinel→action
  wiring via a stream-driven, host-side `SentinelArbiter` bridge.
- [ADR-0002](0002-p1-host-sequencing-and-proxy-decision-synthesis.md) — P1
  host sequencing: guard.wrap() first (agent-declared decisions), MCP proxy as
  an immediate follow-up (synthesized decisions).
- [ADR-0003](0003-proxy-decision-synthesis-window.md) — MCP-proxy decision
  synthesis: the conservative belief-dependency set (cumulative, never reduced by
  execution — so an opaque agent can't drain its obligations) and honest
  synthesized-decision attribution.
- [ADR-0004](0004-native-shell-adapter-ts-level-sandbox.md) — Native shell adapter
  (P2 slice 1) is a TS-level governance boundary, not an OS sandbox; exposed as a
  config-driven tool factory (per-command trust). (Its commit/push placement is
  superseded by ADR-0006; the TS-level-boundary decision still stands.)
- [ADR-0005](0005-native-adapter-prioritization-and-extended-p2.md) — Build an
  adapter when governance is load-bearing (consequential action / untrusted output /
  egress). Extends P2 to shell → github → nostr → http → messaging; names the
  memory-import and runtime-adapter (incl. Flue, Pi) backlogs.
- [ADR-0006](0006-forge-agnostic-git-transport-in-adapter-git.md) — Governed git
  transport (`git.commit`/`push`/`clone`) is forge-agnostic, so it lives in
  `adapter-git` (not a "github" adapter); `adapter-github` is reserved for the
  forge-API surface behind a provider seam. Records the remote-pinning + scoped-credential
  model. Supersedes ADR-0004's commit/push placement.
- [ADR-0007](0007-governed-nostr-transport-adapter.md) — Governed Nostr adapter
  (P2 slice 3): `nostr.publish` (L4 egress) + `nostr.fetch` (untrusted inbound).
  Same egress model as ADR-0006 with the signing key as the (in-process) credential
  and relay pinning as the destination pin; adds NIP-42 AUTH, a kind allowlist, a
  fetch SSRF guard, and the `controlled-network` sandbox profile.
- [ADR-0008](0008-governed-http-transport-adapter.md) — Governed HTTP adapter
  (P2 slice 4): `http.request` (L4 egress) + `http.fetch` (untrusted inbound). The
  first adapter to hit all three governance surfaces at once (injection + egress +
  untrusted content). Same egress model with a host-bound auth header as the
  credential and hostname pinning as the destination pin; the headline new teeth is
  per-hop redirect re-validation (the redirect-to-internal SSRF escape), plus a
  scheme allowlist and bounded body capture. Reuses `controlled-network`.
- [ADR-0009](0009-governed-messaging-transport-adapter.md) — Governed messaging
  adapter (P2 slice 5, the last ordered pick): `slack.post` + `email.send`, both L4
  egress — the purest human-approval demo. Same egress model with the *recipient*
  (channel / email address+domain) as the pinned destination, an operator-fixed
  endpoint + sender, and a header credential. Structurally simpler than ADR-0008:
  the agent never names a host (no SSRF, no redirect following). Adds send-specific
  delivery semantics (a non-2xx / Slack `ok:false` ends `failed`). Egress-only this
  slice (inbound reading deferred); reuses `controlled-network`.
- [ADR-0010](0010-signed-approval-resolutions.md) — Signed approval resolutions
  (P3 slice 1): the cross-process forgery boundary. The proxy promoted whatever
  landed in the `.approvals/` side-channel — a plain-string `approver_id` anyone
  who can write the dir could forge. Now the approver signs the canonical
  resolution with a real Ed25519 key (`node:crypto`, no new dep) and the proxy
  verifies it against operator-pinned `approvals.authorized_keys` before promoting;
  a forged / unsigned / unpinned / tampered resolution never un-parks the action.
  Require-signed by default with an explicit `allow_unsigned` opt-out (schema +
  constructor guard). `lodestar approve --key` signs; `approve keygen` mints keys.
  In-process `guard.wrap()` unaffected. Probe `forged-approval-cannot-execute`.
- [ADR-0011](0011-durable-calibration-computed-event.md) — Durable calibration
  event (P3 slice 2): a calibration pass is recorded as a governed
  `calibration.computed@1` event (audit + replay over a cursor window) while the
  Calibrator stays strictly measure-only — the same measure→record split as the
  sentinels. Deliberately unsigned in v0 (audit/replay, not a forgery boundary).
  Probe `calibration-event-is-durable`.
- [ADR-0012](0012-fs-write-in-adapter-filesystem.md) — `fs.write` graduates into
  the existing `@qmilab/lodestar-adapter-filesystem` (one package per domain) rather
  than a new package: L3 governed write, root confinement (lexical + deepest-existing
  -ancestor realpath walk), no host-env expansion, bounded-rejected-not-truncated,
  opt-in `createDirs`. Confinement extracted to a shared `src/confine.ts`. Probe
  `filesystem-adapter-enforces-write-invariants`.
- [ADR-0013](0013-governed-sql-database-adapter.md) — Governed SQL/database adapter
  (`@qmilab/lodestar-adapter-sql`, a new domain so its own package): `sql.query`
  (L1 read, untrusted rows, `READ ONLY` transaction) + `sql.execute` (L3→L4
  mutation, held). The first native adapter whose headline teeth is an **injection
  boundary** — parameterized-only (values always bound, no string SQL), the
  read/mutation split enforced by a database-level read-only transaction (catches a
  data-modifying CTE), scoped connection credential redacted from errors, result-row
  cap + statement timeout. Targets Postgres via Bun's native `Bun.SQL` (no runtime
  dep). TS-level boundary, not DB containment. Probe `sql-adapter-enforces-invariants`.
- [ADR-0014](0014-session-shipper-wire-format.md) — Session shipper
  (`lodestar ship`, new package `@qmilab/lodestar-ship`): batch-exports a
  session's raw envelopes as the versioned NDJSON wire format
  `lodestar.session_ship@1` to any compatible collector, with the locked
  sensitivity-ceiling redaction applied client-side. Redaction never mutates
  the envelope schema: a wrapper record carries the `redacted` flag and the
  original `payload_hash` is preserved, so tamper evidence survives
  redaction. Prerequisite: the sensitivity-gate primitives graduate from the
  otel-exporter into core (re-exports kept). Probes
  `ship-respects-sensitivity-ceiling`, `ship-wire-roundtrip`.
- [ADR-0015](0015-pluggable-approval-channel.md) — Pluggable approval channel:
  the separate-process approval side-channel goes behind an `ApprovalChannel`
  interface (`announce?`/`fetch`/`consume?`); file stays the default
  (byte-for-byte today's behavior), HTTP (operator-pinned endpoint, env-var
  bearer token) lets a resolution arrive from a remote approvals surface. The
  ADR-0010 forgery boundary does not move — every fetched resolution is
  Ed25519-verified against operator-pinned keys before promotion, so a channel
  can only transport a signed decision, never mint one; `kind: "http"` requires
  pinned keys and rejects `allow_unsigned`. Deliberately distinct from guard's
  trusted in-process `ApprovalResolver`. Probe `approval-via-http-channel` +
  an HTTP case in `forged-approval-cannot-execute`.
- [ADR-0016](0016-trust-pack-registry-architecture.md) — Trust-pack registry
  (epic #76) architecture, open/commercial line, and v1.5 sequencing. The open
  registry is a **protocol, not a service**: a pack is addressed by npm name / git
  URL, discovery is a static signed index, and verification is local. Trust root =
  the **signed manifest** (Ed25519, ADR-0010 lineage, author key pinned by the
  consumer) that **binds a content digest over the pack's files** (verified after
  resolution, immutable refs only) so a re-pointed ref can't swap bytes under a
  valid signature; badges = **locally-verifiable signed attestations** (the format is
  open, being a trusted attester at scale is commercial). Scope cut: probe-pack
  (+sentinels) first, the unified `lodestar.pack.json { kind }` deferred behind the
  spec version. Reuse core + policy-kernel + harness before a new package. Ordered
  children: #91 threat-model → #88 signed manifests → #86 npm/git resolution →
  #90 publish/add CLI → #89 badges → #87 discovery index.
