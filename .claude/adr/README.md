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
  valid signature; resolution is a **non-executing fetch** (no install/lifecycle
  hooks run before verification); badges = **locally-verifiable signed
  attestations** (the format is
  open, being a trusted attester at scale is commercial). Scope cut: probe-pack
  (+sentinels) first, the unified `lodestar.pack.json { kind }` deferred behind the
  spec version. Reuse core + policy-kernel + harness before a new package. Ordered
  children: #91 threat-model → #88 signed manifests → #86 npm/git resolution →
  #90 publish/add CLI → #89 badges → #87 discovery index.
- [ADR-0017](0017-signed-pack-manifests.md) — Signed pack manifests (#88, the
  trust root): Ed25519 over the canonical `lodestar.probe-pack.json`, verified on
  load against operator-pinned author keys, the signature binding a per-file
  `content_digest` so a swapped probe byte is caught under a valid signature. The
  canonical-hash + sign/verify primitive graduated to `@qmilab/lodestar-core`
  `src/crypto/` so manifest, approval, and badge signing share one implementation.
- [ADR-0018](0018-npm-git-pack-source-resolution.md) — npm/git pack source
  resolution (#86, the transport): `loadProbePackFromSource(ref)` resolves a pinned
  `PackSourceRef` (npm: exact version + SRI integrity; git: full commit SHA) to
  confined bytes via a **non-executing fetch** (no `npm install` lifecycle scripts,
  no git hooks — system `tar` with self-enforced confinement, git clone with hooks
  disabled and `.git` removed), then delegates to the #88 verify-on-load over the
  *fetched* bytes. Zero new dependencies.
- [ADR-0019](0019-pack-publish-add-cli.md) — `lodestar pack publish` / `pack add`
  (#90, the author + consumer flow, ADR-0016 step 4): publish freezes the files,
  computes the content digest, signs the canonical manifest **after** the files are
  final, then self-verifies; `add` parses a pinned source, verifies signature +
  digest against pinned author keys via the non-executing fetch **before** any pack
  code runs, then surfaces / installs (with a re-verify of the installed copy) /
  records the pin in a lockfile. Logic in `harness`, formats in `core`, shell in
  `cli` — no new package (ADR-0016 §6). `pack keygen` mints author keys (never on
  argv). Probe `pack-publish-add-roundtrip`.
- [ADR-0020](0020-verification-badges.md) — verification badges (#89, ADR-0016
  step 5): locally-verifiable signed attestations (`probe_results` /
  `security_scan`) **attached to — not baked into** — a pack as `badges/*.badge.json`,
  so they accrue without re-signing the manifest. Verified against a **separate**
  pinned **attester** trust root (`attester_keys`); the `subject.manifest_hash`
  binding defeats mis-attach, the signature defeats forgery. Badges are **advisory**:
  `pack add` surfaces verified-vs-unverified and never gates on them. Schema +
  shared-primitive crypto in `core`, production/verify in `harness`, `pack attest` +
  `keygen --attester` in `cli`. The scanner/issuing authority at scale is commercial.
  Probe `unverified-badge-not-trusted`.
- [ADR-0021](0021-pack-discovery-index.md) — pack discovery index (#87, ADR-0016
  **step 6 of 6** — the last child): discovery as a **protocol, not a service** — a
  fetchable **static signed JSON listing** (`schemas/pack-index.ts`), hostable
  anywhere, verified locally against a **third** pinned trust root
  (`index_publisher_keys`, distinct from author + attester keys). Each entry carries
  the immutable `PackSourceRef` (#86), so discovery feeds resolution directly. The
  load-bearing property: an index **advertises, never authorizes** — choosing a listed
  pack still routes through `addProbePack` (#86/#88) against pinned **author** keys, so
  a hostile/tampered index can mis-list or omit but never make an unsigned/forged pack
  verify. `loadPackIndex` (fail closed, `allow_unsigned` opt-out) + `searchPackIndexes`
  (local filter, multiple indexes compose) in `harness`; `pack search` / `pack list`
  (read) + a thin `pack index-sign` / `keygen --index` publisher side in `cli`; the
  format + sign/verify primitive in `core`. The hosted search/ranking backend stays
  commercial. Probe `pack-index-signature-required`.
- [ADR-0022](0022-probe-runner-scoped-env-execution.md) — probe-runner scoped-env
  execution (#114, the registry epic's **orthogonal runner-side sibling** — not a
  child): the registry chain delivers *authentic bytes* to the runner but does not
  govern what they do when run, and the runner used to spawn `bun run <probe>`
  inheriting the **full host `process.env`**. **Step 1 (the unblocking step):** the
  runner now spawns each probe with an explicit scoped env (fresh empty HOME + inherited
  PATH), denying host secrets — mirroring `baseGitEnv`/`defaultScopedEnv` and the Action
  Kernel's "no host env to sandboxes" rule. The operator widens it via an explicit
  allowlist (`RunPackOptions.allowHostEnv` / `lodestar harness run --allow-env <NAME>`);
  the **untrusted manifest cannot**, so a hostile pack can't declare its way to a secret.
  First-party DB-gated probes keep working because `probes:all`/`probes:safety` forward
  `LODESTAR_TEST_DATABASE_URL` explicitly. A **TS/process-level governance boundary, not
  an OS sandbox** — it denies host-env secrets, not filesystem/network reach; the OS
  sandbox is **step 2, deferred and filed separately**. Probe
  `runner-denies-host-env-to-probe`.
- [ADR-0023](0023-probe-runner-os-sandbox.md) — probe-runner **OS sandbox (step 2)**
  (#121, the follow-up ADR-0022 deferred): step 1 closed host-env secrets but not a
  probe's **filesystem/network reach**. Confines both together via a **pluggable
  sandbox-launcher seam** wrapping the spawn, with **native per-platform** backends —
  `sandbox-exec`/SBPL on macOS, `bubblewrap` on Linux — *no container/daemon
  dependency* (container kept as a future opt-in the seam accepts). Writes → a per-run
  `TMPDIR` scratch; outbound network → loopback + an operator `--allow-host` allowlist;
  reads → an operator `--allow-read` root (default the pack dir). The read guarantee is
  **asymmetric**: Linux/bwrap binds only the declared roots (a true allowlist); macOS
  hosts a JIT runtime so it `(allow default)`-then-clamps, denying the **operator's home
  directory** (the credential store). Egress is coarse on both (macOS **port-scoped** —
  SBPL can't filter by host; Linux all-or-nothing under `--unshare-net`), and macOS
  allows no Unix-socket egress. The **untrusted
  manifest cannot widen** anything (mirrors `--allow-env`). Opt-in at the `runPack`
  library; the **CLI defaults it ON for external packs, OFF for the two bundled
  first-party packs** (the trusted reference set, several of whose probes drive `runPack`
  → would nest). **Degradation:** fail closed with an ergonomic `--no-sandbox` opt-out.
  Honest boundary: OS-primitive confinement, not kernel-grade. **Status: Accepted.**
  Locking probe `runner-sandboxes-probe-filesystem-and-network`.
- [ADR-0024](0024-langgraph-runtime-adapter-seam.md) — LangGraph runtime adapter
  (#83, epic #75 first child): wrap a non-MCP agent loop so its native tool calls
  are governed. The engine is already proven (the MCP proxy's two-phase + held-L4
  approval polling + cognitive-core ingest + decision synthesis are reusable
  as-is), so the only new work is the **seam**. Decision: **Python-first**, a thin
  pip-installable `lodestar-langgraph` hook + a language-agnostic TS
  **governance-gate sidecar** (`@qmilab/lodestar-runtime-core`, `lodestar runtime
  gate`) that reuses the engine unchanged. Callbacks are observe-only → rejected
  for enforcement; the hook **wraps tools** and surfaces L4 holds as LangGraph
  `interrupt`. Two-phase is preserved by **remoting execution back into Python**
  — from the kernel's view the hook is "just another downstream," so no
  kernel/schema change. **One closed, fail-closed enforcement surface** (wrap the
  whole bound toolset at every entry point — `invoke`/`ainvoke`/`batch`/`abatch`
  — `governed_call` for custom nodes; unrecognized tool → denied; raw out-of-band
  I/O honestly out of scope, ADR-0004 lineage). **Durable, idempotent holds**: the
  sidecar is **stateless across the hold boundary** — pending action + request +
  deadline durably logged before `interrupt`, hold reconstructed from the event log
  + signed ADR-0010/0015 side-channel by any (even freshly restarted) sidecar,
  execution **exactly-once per action id** (terminal-event lookup → no
  double-execute), deadline **fail-closed** (late approval rejected). Transport:
  bidirectional NDJSON-RPC over stdio with **concurrency invariants** (unique
  correlation+action ids per leg, order-independent matching, fail-closed
  timeout/cancel, exactly-once ingest) for LangGraph's parallel tool calls. Layout:
  TS in `packages/runtime-core/`, Python in a new `runtimes/langgraph/` (PyPI). The
  sidecar is the **shared spine** the also-Python CrewAI (#84) / AutoGen (#85)
  reuse. Probes `runtime-gate-enforces-two-phase` (always-on TS contract — held-L4,
  idempotent duplicate resume, post-deadline rejection, restart-durable hold,
  fail-closed unknown tool, parallel-call correlation) + `langgraph-tool-calls-are-governed`
  (runtime-gated end-to-end, skips loudly). Durability / enforcement-closure /
  concurrency specifics hardened by the PR #124 Codex adversarial review. The
  riskiest mechanic (re-entrant remoted execute) is **validated against the real
  `ActionKernel`** by `spikes/adr-0024-remoted-execute/` (Python hook ↔ TS gate
  over stdio NDJSON-RPC; held-L4-runs-nothing, resume, exactly-once duplicate
  resolve, and parallel-call correlation all pass — no kernel/schema change).
  **Status: Accepted.**
- [ADR-0025](0025-runtime-core-gate-and-side-channel-graduation.md) — runtime-core
  gate server **implementation decisions** + side-channel graduation (realises
  ADR-0024). (1) The signed `.approvals/` side-channel **graduates** from
  `guard-mcp` to `@qmilab/lodestar-guard` (a second consumer appeared — the runtime
  gate — and a security-critical signed-format reader must have one implementation;
  guard-mcp re-exports unchanged, so the proxy / `lodestar approve` / approval
  probes are untouched, and `runtime-core` reaches the format through `guard`
  without pulling the MCP SDK). (2) The gate **namespaces** runtime tool names
  `runtime.<sanitised>` (the action-kernel registry needs `namespace.action`; a
  native tool has none — the analogue of the proxy's `mcp.<server>.<tool>`). (3)
  The **operator owns every tool contract** (`tool_defaults`); the untrusted hook
  only declares a name → unregistered is fail-closed. (4) `govern` returns the hold
  immediately, `resume` resolves it (single-check or block-poll); `approval_timeout_ms`
  is the **hold deadline window** (`0` = terminal soft denial, no out-of-band
  resolution / no forgery surface; `> 0` = park + enable signed out-of-band
  resolution, requiring a pinned key/`allow_unsigned`); exactly-once keyed on the
  durable terminal event; deadline reconstructed from the log (a restart can't reset
  it). The v0 Python hook drives the sanctioned **block-poll** headless path; the
  interrupt integration is exposed via the `govern`/`resume` primitives. (5) The
  gate is **transport-agnostic** (`RpcChannel`): `stdioChannel` for the CLI,
  `createLoopbackPair` so the always-on probe drives the real gate in-process.
  **Status: Accepted.**

- [ADR-0026](0026-crewai-runtime-adapter.md) — CrewAI runtime adapter, the **second
  thin hook** on the shared gate (#84, realises ADR-0024/0025 for a second
  framework). The enforcement seam is a governed `crewai.tools.BaseTool` subclass
  overriding `_run` (the single point `BaseTool.run` **and** `CrewStructuredTool`
  dispatch through); the gate ref rides a Pydantic `PrivateAttr`, the original
  `args_schema` is preserved, denials re-raise `LodestarDenied` which `ToolUsage`
  surfaces as a re-plannable observation. The Python `client.py` is duplicated
  verbatim (graduation to a shared package deferred to the third hook). Decisions
  2–4 of ADR-0025 are inherited unchanged. Probe `crewai-tool-calls-are-governed` +
  CI `crewai-runtime` job (Python 3.12, chromadb). **Status: Accepted.**

- [ADR-0027](0027-autogen-runtime-adapter.md) — AutoGen runtime adapter, the **third
  thin hook** on the shared gate (#85, the second proof the spine generalises). The
  enforcement seam is a governed `autogen_core.tools.BaseTool` subclass overriding
  **`run_json`** (the single point `AssistantAgent` → `StaticWorkbench.call_tool`
  and direct callers dispatch through); AutoGen's `BaseTool` is not Pydantic, so the
  gate ref lives in plain instance attrs and the original schema surface is
  delegated; denials re-raise `LodestarDenied` which `StaticWorkbench.call_tool`
  surfaces as an error `ToolResult`. **One mechanical divergence from ADR-0026:**
  AutoGen's tool surface is fully async, so the wrapper offloads the blocking gate
  RPC off the event loop (`asyncio.to_thread`) and the remoted body drives the
  coroutine with `asyncio.run` — one path, no sync/async fallback. Targets the 0.4+
  actor line (`autogen-agentchat`/`autogen-core`), not legacy `pyautogen`. The
  Python `client.py` is the **third** verbatim copy; the shared-`lodestar-runtime-client`
  graduation is **deferred to #128** (coupled to PyPI publish-ordering). Decisions
  2–4 of ADR-0025 inherited unchanged. Probe `autogen-tool-calls-are-governed` + CI
  `autogen-runtime` job (Python 3.12). **Status: Accepted.**

- [ADR-0028](0028-pypi-publishing-and-runtime-client-graduation.md) — PyPI trusted
  publishing for the three runtime hooks **+** graduating the triplicated `client.py`
  into a shared **`lodestar-runtime-client`** package (#128, paying off the
  deferral ADR-0026 §3 / ADR-0027 §4 scheduled here). The graduated client is
  byte-identical below the docstring; the graduation is purely internal (hooks
  re-export, public surface unchanged) and the hooks pin it `==<version>` in
  lockstep. A new `publish-pypi.yml` fires on the **same `v*` tag** as npm (one
  version line, lockstep cadence), publishes over **OIDC trusted publishing** (no
  tokens) in a `pypi` environment, **client first → hooks matrix** (the analogue of
  npm's `PUBLISH_ORDER`), with a pre-publish **guard** asserting every Python
  version + the three client pins equal the tag (mirrors `publish.yml`'s version
  guard). Manual bumps, not `hatch-vcs`. The only manual step is the one-time PyPI
  **pending-publisher** registration per project (npm-bootstrap analogue), documented
  in the workflow header. CI `*-runtime` jobs install the local client first.
  **Status: Accepted.**
- [ADR-0029](0029-firewall-observability-via-events.md) — Memory-firewall
  observability via stable **events**, not a stable store interface (#137, the
  last child of epic #140). The `firewall.*@1` audit events already flowed
  (firewall `auditSink` → the three hosts → the log → the `-trace` projection);
  this gives them the stability contract — the wire shape graduates to `-core`
  (`FirewallAuditPayloadSchema`, a `kind`-discriminated union + the three
  two-segment event-type constants + `FIREWALL_EVENT_SCHEMA_VERSION "1"`), a
  **structural supertype** of the firewall's richer internal producer type (so
  `-memory-firewall` is unchanged), and the emitters validate + stamp `"1"` at
  the boundary (`"0.1.0" → "1"`; type strings kept verbatim). The store
  interfaces stay experimental **by design** — they are mutable read+write, so
  integrators read the firewall through the events, not the store, keeping the
  ledger's pure-projection promise true for it. Pinned in `public-api-surface`.
  **Status: Accepted.**
- [ADR-0030](0030-guard-approval-channel-writer-free-subpath.md) — A writer-free
  `@qmilab/lodestar-guard/approval-channel` subpath (#152, a child of epic #140).
  The `.` barrel re-exports `wrap()` next to the channel symbols, so any import
  drags the write-side runtime (action-kernel, memory-firewall, cognitive-core,
  harness) — wrong for an UNTRUSTED transport's audience (ADR-0015). A new
  re-export-only `src/channel.ts` (`export *` from both the transport seam and the
  signed-resolution reader) behind a 4-condition subpath export (the
  `-memory-firewall/postgres` precedent) gives a writer-free import whose transitive
  runtime graph is `{ -core, zod, node:* }` — the lone action-kernel edge is
  type-only and erased. A module-graph test (`channel.test.ts`) enforces the subset,
  names any offender, and can't pass vacuously. The `.` barrel is unchanged (the
  subpath is the alternative, not a move). **Status: Accepted.**
- [ADR-0031](0031-belief-lesson-mapping-and-harvest-projection.md) — Beliefs map to
  durable **lessons**, not current world-state (#154, epic — cognitive-core belief
  enrichment). The `WorldModel` stays the current-state store; the belief machinery
  (evidence, `truth_status`, **supersession `superseded_by`**, calibration) is the
  lesson substrate, so a durable-memory consumer harvests the **belief** stream, not a
  KV. Adds a read-side **harvest projection** in `@qmilab/lodestar-trace` — a pure
  projection over `EventEnvelope[]` surfacing end-of-run **supported** + **superseded-
  with-history** beliefs (with evidence + provenance) as **review-ready memory
  candidates**, mirroring the `pendingApprovals` graduation, **advisory / human-review
  gated, never auto-promoted**. No `packages/core` schema change, no new event (a read,
  not new state). Ships independently of epic children A (linker join) / B (reflection
  derive rule). **Status: Accepted.**
- [ADR-0032](0032-evidence-linker-cross-belief-join.md) — Evidence-linker cross-belief
  join (#157, epic #154 child A): fill the `evidence-linker.ts:61-76` placeholder so a
  new claim is **corroborated** / **contradicted** by prior beliefs. Walk
  `belief.claim_id → ClaimStore` for the prior predicate and read the prior belief's
  `EvidenceSet` (already-held `EvidenceStore`) so the cross-belief item **inherits** the
  corroborator's strongest quality + `independence_group` — making every AC fall out with
  **no `aggregateStrength` change and no gate change** (two `external_document` beliefs
  stay blocked; a stronger independent source flips `unverified → supported`; a same-source
  re-read dedups). Shared `predicateKey` extracted from `retrieval.ts`; the join lives in a
  `protected crossBeliefItems()` all four linker bodies call (the three -aware subclasses
  **override** `linkForClaim`, strict-insert `EvidenceStore.put`). **AC#1 reframed** from the (unsatisfiable, because
  normalized) "higher `aggregateStrength`" to the **promotion-outcome flip**; the
  corroboration-aware *scalar* is deferred to #158. Linker stays pure (prior belief never
  transitioned — that is reflection's job, child B). **Status: Accepted.**
- [ADR-0033](0033-harvest-projection-candidacy-gate.md) — The harvest projection's
  candidacy gate (epic #154 child D, the implementation of ADR-0031). `harvestCandidates`
  in `-trace` surfaces a belief as a keeper candidate only when its **reconstructed
  current** state is `truth_status: supported` **and** `security_status: clean` **and**
  `retrieval_status` ∈ {`normal`, `restricted`} — the security-relevant subset of
  `DEFAULT_CONTEXT_POLICY`, so a quarantined / hard-demoted belief cannot launder past the
  firewall into the human Keep queue (no-self-promotion, extended to durable memory).
  Freshness / sensitivity / scope / confidence are **surfaced, not gated** (the reviewer's
  call; the shipper owns the egress sensitivity ceiling). Supersession is surfaced as the
  successor's newest-first `supersedes` history, never a separate candidate; lifecycle state
  is replayed from `belief.adopted` + `firewall.belief.transitioned`, not snapshot-read. No
  `packages/core` schema change, no new event. Locked by the
  `harvest-projection-surfaces-durable-lessons` probe. **Status: Accepted.**
- [ADR-0034](0034-reflection-derive-supersession-rule.md) — The reflection DERIVE rule
  (epic #154 child B, on top of ADR-0032). A third reflection rule that *derives* a
  contradiction from live belief state — two `supported` beliefs in one scope sharing a
  claim's `(subject, relation)` but asserting different `object`s — and **proposes** a
  `belief_supersession` (older `superseded_by` newer). **Propose-only, enforced at the run
  loop:** `run()` surfaces but never applies it even under `apply: true` (a derived conflict
  is a human-adjudicated hypothesis); a reviewer drives the existing `markSuperseded` path
  via `applyProposal`. Supersession-only output (detects contradiction, proposes the
  actionable resolution — not a raw `contradicted` that would pick a loser). Reuses the
  evidence-linker's exported `isEligibleJoinPeer` + shared `predicateKey`/`stableStringify`
  narrowed to `truth_status: supported`; pairs only **equal-sensitivity** beliefs (stricter
  than the linker's `≤` ceiling — the output names both beliefs to a human, and the higher
  belief can itself be the window trigger). Single-fire on the later belief's
  `belief.adopted` event; no authenticity gate needed (reads from the governed store, only
  proposes). No `packages/core` schema change. Locked by
  `reflection-derives-supersession-from-conflict`. **Status: Accepted.**
- [ADR-0035](0035-generic-llm-claim-extractor.md) — Opt-in LLM-driven generic claim
  extractor (epic #154 child C-2, #163). `createGenericLLMExtractor(model)` claims the
  reserved `__generic__` fallback slot so observation text with no schema-bound extractor
  can still yield claims — registered explicitly, **never** a built-in (replay-stable
  deterministic extraction stays the default). The provider-agnostic `GenericExtractionModel`
  seam keeps the LLM client/key/prompt in the consumer (Lodestar ships none). Every claim is
  `extraction_method: "llm"`, and the partner **`GenericAwareEvidenceLinker`** stamps its
  source evidence at `model_inference` quality, so the auto-observation (Parallax) gate keeps
  the belief `unverified` — at high strength and even across two independent LLM inferences.
  The downgrade lives in the linker (not the base path — making it load-bearing there would
  break the locked #157 probe), so the opt-in is the extractor *and* its linker. No
  `packages/core` schema change; pure no-op for existing flows. Locked by
  `generic-llm-extractor-stays-unverified`. **Status: Accepted.**
- [ADR-0036](0036-corroboration-aware-evidence-scalar.md) — Corroboration-aware evidence
  scalar as a separate, non-gate signal (#158, deferred from #157). `aggregateStrength` (the
  gate input) is normalized `(S − C)/(S + C)`, so an all-supporting set is always exactly
  `1.0` — de-normalizing it would re-baseline every consumer. So corroboration is made
  legible by a **second, additive** scalar `corroborationStrength` (a quality-weighted
  noisy-OR over independent supporting groups; monotone, saturating, bounded `[0, 1)`,
  contradiction-dampened; shared `strongestPerGroup` so the two can't drift) that **feeds no
  gate** — `aggregateStrength` stays byte-for-byte unchanged, so no belief's lifecycle shifts
  and Parallax holds untouched. Wired into the harvest projection as ranking-only
  `MemoryCandidate.corroboration`. Locked by
  `corroboration-strength-rewards-independent-sources`. **Status: Accepted.**
- [ADR-0037](0037-world-model-honours-auto-observation-gate.md) — World-model writes honour
  the auto-observation gate (epic #154 tail, #165). `ingest` step 6 wrote the world model —
  the ungated "current state" store a planner reads to decide — on net-positive strength
  alone, so a positive-but-gated claim (a lone `external_document` / `model_inference`) still
  wrote current state, bypassing the Parallax gate that keeps it an `unverified` *belief*: a
  poisoning **side door**, latent only because nothing reads the world model back yet. The
  fix: a write updates current state only if its evidence nets positive **and** clears the
  gate — otherwise the write is **withheld** and recorded on `IngestResult.worldModelWithheld`
  (hosts carry it as `world_model_withheld`). Withhold rather than write-and-flag: the world
  model has no read-time gate to enforce a flag, and a flagged write would shadow a
  gate-cleared value; the unverified belief still carries the full record. Refines ADR-0032's
  P2#1 rule. No `packages/core` schema change. Locked by
  `world-model-withholds-gated-current-state`. **Status: Accepted.**
- [ADR-0038](0038-sql-query-bounded-cursor-fetch.md) — `sql.query` bounds the fetch with a
  server-side cursor (#101, hardens ADR-0013). The L1 read materialized the whole result set
  then `slice`d to `maxRows`, so the cap bounded the *observation*, not host memory — a fast
  large scan (`SELECT * FROM huge` within `statement_timeout`) could OOM the host. Bun 1.3.14's
  `Bun.SQL` exposes no JS-level cursor, so the fix uses the SQL-level server-side cursor: inside
  the `READ ONLY` transaction, `DECLARE … NO SCROLL CURSOR` for the statement then
  `FETCH FORWARD maxRows+1` (one past the cap, for `truncated`) then `CLOSE` — the host buffers
  a bounded number of rows regardless of result size. Values still bind (`DECLARE` carries the
  `$1..$N` params), so the injection boundary is unchanged. Only SELECT-family statements are
  cursorable (`isCursorable`); `EXPLAIN`/`SHOW` take the prior direct read. Ride-along:
  `assertPostgresUrl` fails a non-Postgres URL (`mysql://`/`sqlite://`) early with a clear,
  credential-free scheme error. No `packages/core` schema change, no new package. Locked by two
  new sub-cases of `sql-adapter-enforces-invariants`. **Status: Accepted.**
