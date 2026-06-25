# CLAUDE.md — Lodestar monorepo

Codename `Lodestar`. Open epistemic governance framework for AI agents.

**Status**: v0.3.0 published to npm (all 24 packages via CI trusted
publishing — staged publishing, maintainer-approved), v0.2 architecture
locked. The 0.3.0 release published the two packages that had landed
after v0.2.0: the 23rd, `@qmilab/lodestar-adapter-sql` (the governed
SQL/database adapter, ADR-0013), and the 24th, `@qmilab/lodestar-ship`
(the read-side session shipper — `lodestar ship`, the
`lodestar.session_ship@1` NDJSON wire format, ADR-0014). (`adapter-sql`
shipped at 0.3.0 without provenance — a Cloudflare-WAF false-positive on
a `DROP TABLE` doc literal forced a one-off manual token publish;
resolved for future versions.) Seventy-two probes pass under
strict TypeScript (two need a Postgres test database; one needs a Python
+ LangGraph runtime; one needs a Python + CrewAI runtime; one needs a
Python + AutoGen runtime — see below).
Sixty-eight live in the first-party pack
`packs/lodestar-core/`: six firewall probes, three guard / contract
probes, the three pre-Batch-3 fixes (contradiction routing, kernel
context propagation, event-log single-writer), two Batch 3 MCP probes
(`mcp-proxy-roundtrip`, `mcp-proxy-injection-defense`), three
Batch 4 probes (`reflection-cannot-promote-to-normal-alone`,
`contradicted-belief-flags-dependent-decisions`,
`event-log-canonical-hash`), one Batch 5 probe
(`documentation-evidence-provenance`), one cognitive-core evidence-linker
probe (`evidence-linker-cross-belief-join` — the #157 cross-belief join:
a new claim corroborated by an independent **higher-quality** belief in a
distinct `independence_group` promotes `unverified → supported` (where the
same lone-source `external_document` claim stays `unverified`), a
same-`(subject, relation)` / different-`object` match records a
`contradicts` item that nets `≤ 0` so the claim is not adopted, two
`external_document` beliefs still cannot promote each other (Parallax
holds), and the prior belief is never mutated — quality-inheritance, runs
in-memory always + against Postgres when `LODESTAR_TEST_DATABASE_URL` is
set; ADR-0032), one cognitive-core harvest-projection probe
(`harvest-projection-surfaces-durable-lessons` — the #154 item-D
belief→lesson harvest: the new pure read-side projection
`harvestCandidates(events)` in `@qmilab/lodestar-trace` surfaces a run's
end-of-run **supported** beliefs + **superseded-with-history** chains as
advisory `MemoryCandidate`s, each carrying its claim + evidence + provenance.
Over a real on-disk NDJSON log it pins eight invariants — a genuine supported
lesson surfaces with its evidence; the headline **no-launder** (a poisoned
`quarantined` or hard-demoted `blocked` belief that nonetheless reached
`supported` appears nowhere, not even as history — the no-self-promotion
guarantee extended to the human Keep queue); a belief is harvested only when its
adoption is **firewall-authored** (a `belief.adopted` confirmed by a host-authored
`firewall.belief.adopted@1` audit, first-wins on the record — an **agent-forged**
`belief.adopted` with no audit, or a later content-overwrite, is rejected);
lifecycle is **reconstructed** from those records + **firewall-authored**
`firewall.belief.transitioned` (adopted-unverified then promoted-supported counts;
adopted-supported then quarantined does not); a transition is trusted only when
canonical-type + `schema_version === FIREWALL_EVENT_SCHEMA_VERSION` +
strict-payload, so an **agent-forged** `security_status→clean` `ctx.emit` (pinned
to the session schema version) cannot clear a real quarantine; **supersession** is the
successor's newest-first audit trail, never a separate candidate, and its
security gate applies to **history** too (a quarantined predecessor stays out);
and the projection is **read-only** (log bytes + input array untouched).
Candidacy gate = `truth_status:supported` ∧ `security_status:clean` ∧
`retrieval_status ∈ {normal,restricted}`, the security-relevant subset of
`DEFAULT_CONTEXT_POLICY`; freshness/sensitivity/scope are surfaced not gated;
no `packages/core` schema change, no new event; ADR-0031 mapping + ADR-0033
candidacy gate + firewall-authored reconstruction), and fourteen Policy Kernel probes —
the three-valued gate, the trust-ladder floor, the approval lifecycle,
signature verification, the arbitrate hook, and the host wiring — the
`guard.wrap()` approval-resolver seam, the MCP-proxy deadline/timeout
hold path, the separate-process `lodestar approve` side-channel
resolver, the proxy compiling a declarative `CompiledPolicy` (from a
signed `ProxyConfig.policy` document) so a matched `require_approval`
rule's `required_authority` (`min_trust_baseline` / `scope`) reaches its
holds, and the **signed-approval forgery boundary** (P3 — the proxy
verifies a side-channel resolution's Ed25519 signature against
operator-pinned approver keys before promoting, so a forged / unsigned /
tampered grant cannot un-park a held L4; ADR-0010)
(`l4-action-requires-approval`, `l4-floor-preserves-stricter-rule`,
`pending-approval-cannot-execute`, `ladder-floor-overrides-allow-rule`,
`unmatched-action-defaults-to-deny`, `policy-version-signature-required`,
`granted-approval-still-revalidates-preconditions`,
`sentinel-alert-gates-dependent-action`,
`calibration-flag-escalates-action`,
`guard-hold-resolves-via-resolver`, `approval-timeout-denies`,
`approval-via-side-channel`, `forged-approval-cannot-execute`,
`proxy-hold-carries-rule-authority`), and the **pluggable approval channel**
(ADR-0015 — the out-of-band approval *transport* seam: `FileApprovalChannel`
wraps the `.approvals/` file side-channel byte-for-byte and `HttpApprovalChannel`
reads a remote approval service, but the Ed25519 forgery boundary stays in the
consumer *after* transport, so a hostile channel can only delay an approval, never
mint / tamper / replay one; the HTTP channel fails closed on a missing credential,
bounds every request by a wall-clock deadline, and binds each resolution to the
fetched `request_id`) (`approval-via-http-channel`,
`forged-approval-via-http-channel-cannot-execute`), one
Governing-UI read-side probe (`viewer-is-read-only` — the read-side
viewer surfaces the chain + pending approvals but exposes no mutation
route and never writes the log), two OTel-exporter probes
(`otel-export-respects-sensitivity-ceiling`,
`otel-export-projects-action-spans`), and the two host-side sentinel→action
wiring probes — `guard-arbiter-gates-dependent-action` (a real
`suspicious-memory-origin` alert, run by the `guard.wrap()`
`SentinelArbiter` over the session's own event stream, holds the
dependent action at `pending_approval` through the host; ADR-0001) and
`mcp-proxy-arbiter-gates-dependent-action` (the **MCP-proxy** analogue —
the opaque agent cannot declare decisions, so the proxy *synthesizes* a
`decision.made` from the arbiter's conservative observed-belief set, and a
poisoned downstream read then holds the dependent `tools/call`; ADR-0002 / ADR-0003),
one shell-adapter probe (`shell-adapter-enforces-sandbox-invariants` — the
native `@qmilab/lodestar-adapter-shell` holds its TS-level invariants through the
kernel: no host-env passthrough, allowlist + argv-only no-injection, wall-clock
timeout, and bounded output capture; ADR-0004), and one git-adapter egress probe
(`git-adapter-enforces-egress-invariants` — the native forge-agnostic git transport
in `@qmilab/lodestar-adapter-git` holds its egress invariants through the kernel: a
push proposed at L4 stays at `pending_approval` until approved then lands in the
**operator-pinned** remote despite a poisoned `.git/config`, the configured credential
never surfaces in inputs/observation, a non-allowlisted clone source and an escaping
destination both fail, and host author-env does not leak; ADR-0006), and one
nostr-adapter transport probe (`nostr-adapter-enforces-egress-invariants` — the
native `@qmilab/lodestar-adapter-nostr` holds its invariants through the kernel:
`nostr.publish` proposed at L4 stays at `pending_approval` until approved then lands
a BIP-340-verifiable note at the **operator-pinned** relay, the signing key never
surfaces in inputs/observation, a non-pinned relay and a non-allowlisted event kind
both fail, NIP-42 AUTH is handled with the same key, and `nostr.fetch` flags forged
signatures + pins reads against SSRF; ADR-0007), and one http-adapter transport
probe (`http-adapter-enforces-egress-invariants` — the native
`@qmilab/lodestar-adapter-http` holds its invariants through the kernel:
`http.request` proposed at L4 stays at `pending_approval` until approved then
delivers its body to the **operator-pinned** host, an approved request to a
non-pinned host fails and the decoy gets nothing, a pinned host that redirects to a
non-pinned host (`localhost` — the SSRF escape) is not followed, a `file://` fetch
fails the scheme allowlist, the operator credential reaches the server but never
surfaces in inputs/observation, and an oversized untrusted body is captured to the
cap and flagged truncated; the first adapter to hit injection + egress + untrusted
content at once; ADR-0008), and one messaging-adapter egress probe
(`messaging-adapter-enforces-egress-invariants` — the native
`@qmilab/lodestar-adapter-messaging` holds its invariants through the kernel:
`slack.post` proposed at L4 stays at `pending_approval` until approved then
delivers to the **operator-pinned** channel, an approved post to a non-pinned
channel and an approved `email.send` to a non-allowlisted recipient both fail with
the provider untouched while an allowlisted-by-domain recipient lands carrying the
**operator-fixed** From, the operator bot token reaches the provider but never
surfaces in inputs/observation even when echoed back, a Slack `ok:false` ends
`failed` rather than a silent completed, and an oversized provider response is
captured to the cap; the fourth native egress and the purest human-approval demo —
egress-only this slice; ADR-0009), and one filesystem-write probe
(`filesystem-adapter-enforces-write-invariants` — `fs.write` graduates the
documentation-agent's example-local `doc.write` into the existing
`@qmilab/lodestar-adapter-filesystem` (one package per domain, so no new
publish bookkeeping) and holds its invariants through the kernel: a held L3
write parks at `pending_approval` and touches no disk until resolved, a
revalidated precondition rejects a stale-world write (TOCTOU), a contract
below the L3 floor is refused at propose, `..` / absolute-path /
symlinked-directory / symlink-destination / `createDirs`-ancestor escapes all
fail with nothing written outside the **operator-fixed** root, `~`/`$HOME`
stay literal (no host-env expansion, no `process.env` reads), and oversized
contents are rejected — never truncated; ADR-0012), and one durable-calibration probe
(`calibration-event-is-durable` — the **P3 forgery-track second slice**: a
calibration pass is recorded as a governed `calibration.computed@1` event without
the Calibrator ever growing a write path. Over a real NDJSON log it pins four
invariants — measure ≠ write (running `calibrate()` writes zero events; the count
goes 0→1 only on the explicit `eventLogCalibrationSink` publish step), durable +
schema-valid, tamper-evident (`payload_hash == canonicalHash(payload)` across the
round-trip), and replayable (re-running `calibrate` over the recorded `cursor`
window reproduces the verdict). The report wire format graduated to
`@qmilab/lodestar-core`; the event is audit/replay, not a forgery boundary — not
signed in v0 because the gate reads an in-process snapshot and a flag only
escalates; `lodestar harness calibrate` is the CLI publish step; ADR-0011),
and one SQL-adapter probe (`sql-adapter-enforces-invariants` — the native
`@qmilab/lodestar-adapter-sql` holds its invariants through the kernel against a
real Postgres: the **parameterized-only injection boundary** (a `'); DROP TABLE
…;--` parameter is bound and stored as a literal, never executed), the
read/mutation trust split (a `sql.query` at L1 returns rows but a write — both an
obvious `DELETE` and a data-modifying CTE the lexical guard waves through — is
refused, the latter by a `READ ONLY` transaction the database itself enforces), the
L3 mutation two-phase hold (a held `sql.execute` parks at `pending_approval` and
touches no row until approved), statement-stacking rejection, a result-row cap, and
the connection password never surfacing in inputs/observations and being redacted
from a bad-connection error; the first adapter whose headline teeth is an injection
boundary rather than egress; DB-gated like `tool-poisoning-cross-session` —
`LODESTAR_TEST_DATABASE_URL`, skips loudly when unset, runs against `postgres:16` in
CI; ADR-0013), and two session-shipper probes — `ship-respects-sensitivity-ceiling`
(a local capture server asserts an above-ceiling `secret` belief's bytes never cross
the wire while the redaction marker + the **original** `payload_hash` do, the bearer
token reaches the collector as a header but never enters the NDJSON body, the POST
lands at `/v1/events` as `application/x-ndjson`, and an invalid ceiling throws) and
`ship-wire-roundtrip` (the receiver re-verifies `payload_hash == canonicalHash(payload)`
for every unredacted record; redacted records are **flagged, not hash-mismatched** —
the preserved original hash ≠ the marker's hash; a decision event with no sensitivity
**fails closed** to redacted at the default `internal` ceiling; and the whole session
is lossless + portable at `--sensitivity-ceiling secret`). The shipper is the first
read-side **egress** path with the locked sensitivity ceiling applied client-side
before transfer; the gate primitives graduated to `@qmilab/lodestar-core` (#104) so the
shipper and the otel-exporter share one implementation; ADR-0014, and three
registry trust-root probes — `pack-manifest-signature-required` (the consumer
pins author keys and the harness loader verifies a probe-pack manifest's Ed25519
signature on load; unsigned/un-pinned is rejected, `allow_unsigned` is the
explicit opt-out), `forged-pack-cannot-load` (every local forgery — wrong key,
un-pinned signer, lifted signer_id, edited-after-signing manifest — is refused),
and `tampered-pack-content-cannot-load` (the **content-binding** half: the signed
manifest carries a per-file `content_digest`, so a probe byte swapped under a
still-valid signature is caught — the re-pointed-ref / re-published-artifact hole;
the shared Ed25519 primitive graduated to `@qmilab/lodestar-core` `src/crypto/` and
the approval path now reuses it; #88, ADR-0016 §2, ADR-0017), and three
registry source-resolution probes — `pack-resolves-from-npm` (a pack resolves
from a published npm package pinned to an exact version + SRI integrity, and
from a git repo pinned to a full commit SHA, the signature + content digest
verifying over the *fetched* bytes; a tampered tarball whose bytes ≠ the pin is
rejected — all offline via a local registry server + local repo),
`mutable-git-ref-rejected` (a git source must pin an immutable full 40-hex SHA;
a branch/tag/short-SHA is refused), and `resolution-runs-no-pack-code` (the
**non-executing fetch**: a tarball's malicious `postinstall` and a repo's
`post-checkout` hook never fire — resolution downloads + extracts / clones +
checks out at the pinned ref with `npm install` never run and hooks disabled, so
no pack-authored code runs before verification; system-`tar` extraction with
self-enforced confinement, git clone with scoped env mirroring `adapter-git`,
`.git` removed; #86, ADR-0016 §1, ADR-0018), and one registry author+consumer
probe — `pack-publish-add-roundtrip` (the **publish→add flow**, #90, ADR-0016
step 4: `publishProbePack` freezes a pack's files, content-digests them, signs
the manifest in place and self-verifies; `addProbePack` resolves the pinned
source via the non-executing fetch, verifies the signature + content digest
against the pinned author key **before any pack code runs**, installs to a stable
dir with the installed copy re-verified, and records the immutable pin + manifest
hash in a lockfile; a probe byte or a manifest field swapped after signing fails
`add`, a signed pack from an un-pinned author is refused even under
`allow_unsigned`, and the author private key never surfaces in any produced
artifact; the logic lives in `@qmilab/lodestar-harness`, the consumer formats
[trust config + lockfile] in `@qmilab/lodestar-core`, and `lodestar pack
keygen/publish/add` is the CLI; ADR-0019), and one registry verification-badge
probe — `unverified-badge-not-trusted` (the **second trust axis**, #89, ADR-0016
step 5 / ADR-0020: locally-verifiable signed attestations — `probe_results` /
`security_scan` — **attached to** a pack as `badges/*.badge.json`, outside the
manifest so they accrue without re-signing, and verified against a **separate**
pinned **attester** trust root. The `subject.manifest_hash` binding defeats
mis-attach and the signature defeats forgery; badges are **advisory**, never a
gate — `addProbePack` surfaces verified-vs-unverified and the pack always loads.
The probe pins all five outcomes: a pinned-attester badge → verified, the same
badge with no attester pinned → unverified, a badge claiming the pinned attester
but signed by another key → unverified, a validly-signed badge issued over
different bytes → not_applicable, a badge edited after signing → unverified, a
junk file → malformed — and in every case the pack still verifies. The schema +
shared-primitive crypto graduated to `@qmilab/lodestar-core`, production/verify is
`@qmilab/lodestar-harness`, and `lodestar pack attest` + `keygen --attester` is the
CLI; the scanner/issuing authority at scale stays commercial; ADR-0020), and one
registry discovery-index probe — `pack-index-signature-required` (the **read-side
discovery surface**, #87, ADR-0016 **step 6 of 6** — the last registry child /
ADR-0021: discovery as a **protocol, not a service** — a fetchable **static signed
JSON listing** (`schemas/pack-index.ts`) verified locally against a **third** pinned
trust root, the operator's **index-publisher** keys (`index_publisher_keys`, distinct
from author + attester keys). Each entry carries the immutable `PackSourceRef` (#86),
so discovery feeds resolution directly. The load-bearing property: an index
**advertises, never authorizes** — the probe pins all six outcomes: a signed index
from a pinned publisher → verifies + lists, an un-pinned publisher → rejected, local
search filters by coverage/invariant/text (AND) → the right subset, an unsigned index
→ rejected fail-closed (`allow_unsigned` the explicit opt-out, surfaced UNSIGNED), an
entry edited after signing → rejected on the payload hash, and the headline — a
**verified** index advertising an unsigned pack **cannot make it verify**: choosing
it still routes through `addProbePack` (#86/#88) against pinned **author** keys, which
rejects it, while the genuinely-signed pack the same index lists adds cleanly — so a
hostile/tampered index can mis-list or omit but never launder trust; multiple verified
indexes compose. `loadPackIndex` (fail closed) + `searchPackIndexes` (local filter)
in `@qmilab/lodestar-harness`; `lodestar pack search` / `pack list` (read) + a thin
`pack index-sign` / `keygen --index` publisher side in the CLI; the format +
sign/verify primitive in `@qmilab/lodestar-core`. The hosted search/ranking backend
stays commercial; ADR-0021), and one probe-runner containment probe —
`runner-denies-host-env-to-probe` (the registry epic's **orthogonal runner-side
sibling**, #114 / ADR-0022 — not a registry child: the signing chain delivers
*authentic bytes* to the runner but does not govern what they do when run, and the
runner used to spawn `bun run <probe>` inheriting the **full host `process.env`**.
Step 1, the unblocking step: the runner now spawns each probe with an explicit scoped
env — a fresh empty HOME + inherited PATH — denying host secrets, mirroring
`baseGitEnv`/`defaultScopedEnv` and the Action Kernel's "no host env to sandboxes"
rule. The probe drives the **real** `runPack` and pins three things: a host
`process.env` secret is **absent** from the spawned probe, PATH is **present** (so
`bun` resolves — the positive control), and an operator-allowlisted var **is**
forwarded while a non-allowlisted host secret stays **absent on the same run** — the
allowlist is the **operator's** (`RunPackOptions.allowHostEnv` / `lodestar harness run
--allow-env <NAME>`), never the **untrusted manifest's** to widen. First-party
DB-gated probes keep working because `probes:all`/`probes:safety` forward
`LODESTAR_TEST_DATABASE_URL` explicitly. A **TS/process-level governance boundary, not
an OS sandbox** — it denies host-env secrets, not filesystem/network reach; the OS
sandbox is **step 2, now landed**; ADR-0022), and one probe-runner OS-sandbox probe —
`runner-sandboxes-probe-filesystem-and-network` (**step 2**, #121 / ADR-0023: each
probe is additionally spawned inside an OS sandbox — `sandbox-exec` on macOS,
`bubblewrap` on Linux — confining its **filesystem** (writes → a per-run scratch; reads
deny the consumer's home, re-allowing operator `--allow-read` roots) and **outbound
network** (loopback + operator `--allow-host`). Opt-in at `runPack`; the CLI defaults it
ON for external packs and **fails closed** (`--no-sandbox` is the audited opt-out), OFF
for the two bundled first-party packs (the trusted reference set, several of whose
probes drive `runPack` and would otherwise nest sandboxes). An **OS-primitive boundary,
not kernel-grade containment**, with asymmetric per-platform edges — Linux gives a true
read-allowlist (bind mounts) but coarse all-or-nothing network under `--unshare-net`;
macOS, hosting a JIT runtime, denies the user's *home* rather than allowlisting reads
and scopes egress by **port** (SBPL can't filter by host; no Unix-socket egress, so a
hostname `--allow-host` is refused — it must carry a port). The probe drives the **real** `runPack` over a fixture,
pins read-home-secret/write-outside/remote-egress all **denied** plus the pack-dir-read
and scratch-write positive controls, and **skips loudly** when no mechanism is available
or it is non-functional; ADR-0023), and two LangGraph runtime-adapter probes —
`runtime-gate-enforces-two-phase` (the **always-on TS spine lock**, #83 / ADR-0024 /
ADR-0025: drives the **real** `RuntimeGate` over the **real** NDJSON-RPC protocol with an
in-process loopback stand-in for the native hook — no subprocess, no Python — pinning a
held L4 stays held until a *signed* approval resolves it, a duplicate resume is idempotent
(no double-execute), a post-deadline resolution is rejected fail-closed, a hold
reconstructed by a **fresh** gate instance still resolves (restart durability over the
durable log), an unregistered tool is denied fail-closed, `external_document` content
cannot self-promote a belief, a synthesized decision links the observed-belief set, and
parallel in-flight calls are correlated + ingested exactly once, a **timeout-0 hold
is a terminal soft denial that cannot be resumed into execution even with a valid
signed grant**, **concurrent resumes of one held action run the body exactly once**
(per-action serialization), and a **malformed tool callback fails the action rather
than stranding it** — the last three hardened by the PR #125 Codex review) and
`langgraph-tool-calls-are-governed` (the **runtime-gated end-to-end** sibling: a **real**
Python LangGraph compiled graph + prebuilt `ToolNode` driven through the
`lodestar-langgraph` hook + the TS gate, adding the real-runtime cases — `ToolNode`,
a custom node via `governed_call`, async `ainvoke`, batch/parallel, an L4 hold across the
boundary (the body never runs), and a dynamically-unregistered tool rejected fail-closed;
it **skips loudly** when Python/LangGraph is absent and runs for real in the CI
`langgraph-runtime` job; ADR-0024 / ADR-0025), and one CrewAI runtime-adapter probe —
`crewai-tool-calls-are-governed` (the **second framework on the shared gate**, #84 /
ADR-0026: a **real** CrewAI toolset driven through the `lodestar-crewai` hook + the
**same unchanged** TS gate, proving the runtime-core spine generalises — the hook is
~one new file (`adapter.py`: a governed `BaseTool` subclass overriding `_run`, the
single seam CrewAI's `BaseTool.run` **and** `CrewStructuredTool` both dispatch through;
the gate ref rides a Pydantic `PrivateAttr`, the original `args_schema` is preserved,
denials re-raise `LodestarDenied` which `ToolUsage` surfaces as a re-plannable
observation). It adds the real-runtime cases — CrewAI's own `CrewStructuredTool.invoke`
path (dict + JSON-string inputs), a custom step via `governed_call`, an async-only tool
via the remoted execute, concurrent calls correlated, an L4 hold across the boundary (the
body never runs, through both `governed_call` and the framework path), an unregistered
tool denied fail-closed, the wrappers attaching to a real `Agent`/`Task`/`Crew`, and
NaN arg/result rejection — **no LLM/key needed**, driving the framework's tool-execution
path directly. The Python RPC `client.py` was duplicated verbatim from `lodestar-langgraph`
(framework-agnostic stdlib; since graduated to the shared `lodestar-runtime-client` PyPI
package in #128 / ADR-0028). It **skips loudly** when Python/CrewAI is absent and runs
for real in the CI `crewai-runtime` job (Python 3.12 — CrewAI's chromadb dep breaks on
3.14); ADR-0026), and one AutoGen runtime-adapter probe —
`autogen-tool-calls-are-governed` (the **third framework on the shared gate**, #85 /
ADR-0027: a **real** AutoGen (`autogen-agentchat`/`autogen-core`, the 0.4+ actor line)
toolset driven through the `lodestar-autogen` hook + the **same unchanged** TS gate — the
spine generalises a second time. The hook is again ~one new file (`adapter.py`: a governed
`BaseTool` subclass overriding **`run_json`**, the single point `AssistantAgent` →
`StaticWorkbench.call_tool` and any direct caller dispatch through; AutoGen's `BaseTool` is
not Pydantic so the gate ref rides plain instance attrs, the original schema surface is
delegated, denials re-raise `LodestarDenied` which `StaticWorkbench.call_tool` surfaces as
an error `ToolResult`). The **one mechanical divergence from CrewAI**: AutoGen's tool
surface is **fully async**, so the wrapper offloads the blocking gate RPC off the event
loop (`asyncio.to_thread`) and the remoted body drives the coroutine with `asyncio.run` —
one path, no sync/async fallback. It adds the real-runtime cases — AutoGen's own
`StaticWorkbench.call_tool` path, a custom step via `governed_call`, an async `FunctionTool`
+ a custom `BaseTool` subclass via the remoted execute, concurrent calls correlated, an L4
hold across the boundary (the body never runs, through both `governed_call` which raises and
the framework path which surfaces an error `ToolResult`), an unregistered tool denied
fail-closed, the wrappers attaching to a real `AssistantAgent` (a stub model client), and
NaN arg/result rejection — **no LLM/key needed**. The Python RPC `client.py` was the **third**
verbatim copy at merge; per ADR-0027 §4 the shared-`lodestar-runtime-client` graduation
**landed next in #128 / ADR-0028** (extracted to `runtimes/runtime-client/`; the hooks now
depend on it pinned `==<version>` and PyPI publishes via OIDC on the same `v*` tag as npm,
client-first), so #85 stayed a clean "third hook, same shape" PR. It **skips loudly** when
Python/AutoGen is absent and runs for real in the CI
`autogen-runtime` job (Python 3.12, pinned only to match the siblings — AutoGen pulls no
chromadb); ADR-0027), and one public-API stability probe
(`public-api-surface` — the executable mirror of `docs/reference/public-api.md`:
it imports every declared-stable symbol across the seven packages the ledger
names and pins each one twice — a compile-time signature assertion that fails the
strict-TS `typecheck:packs` gate on drift, and a runtime behavioral check (each
schema round-trips a valid payload and rejects an invalid one; each pure function
is exercised for determinism / the log layout / the signed-resolution reject set /
the OTLP IR shape). It also pins the surfaces that landed after it was first
written — the declarative action-policy document family (#135), the trust-pack
registry wire shapes (#136), the now-shipped `ApprovalChannel` transport seam
(ADR-0015 / #134/#145), and the **`firewall.*@1` audit-event contract**
(`FirewallAuditPayloadSchema` — a `kind`-discriminated union — plus the three
two-segment event-type constants + `FIREWALL_EVENT_SCHEMA_VERSION` +
`firewallEventType`, #137 / ADR-0029). That last one is the answer to "stabilize
a firewall read interface **or** emit firewall events": the firewall is observed
through its **already-flowing events** — the producer `auditSink` →
`guard.wrap()` / MCP-proxy / runtime-gate → log → `-trace` projection — graduated
to a stable, versioned (`"1"`) wire shape in `@qmilab/lodestar-core` (a
**structural supertype** of the firewall's internal `FirewallAuditEvent`, so
`-memory-firewall` is unchanged), keeping "every read-side surface is a pure
projection over `EventEnvelope[]`" true for the firewall too; the
`ClaimStore`/`BeliefStore`/`EvidenceStore` interfaces stay experimental **by
design**. No package behavior changed — the probe is new spec). The other
four live in the first non-core
pack `packs/coding-agent-safety/`: `prompt-injection-cross-tool`,
`tool-poisoning-cross-session`, `confidence-drift`, and the Batch 5
`poisoned-file-cannot-hijack-feature-work` (the governed-dev no-hijack
invariant). The
`tool-poisoning-cross-session` probe exercises the proxy's
Postgres backend across two sessions, so it needs a real database: it
reads `LODESTAR_TEST_DATABASE_URL` and skips with a loud banner when
that is unset; CI runs it against a `postgres:16` service.
All load through the `@qmilab/lodestar-harness` pack loader; `lodestar
harness run --pack <name>` drives a pack, `probes:all` points at
`lodestar-core` and `probes:safety` at `coding-agent-safety`. Batches 1–4
are complete (reflection pass, probe-pack format,
probe repackaging, the `Probe` base class + pack runner + `lodestar
harness run` CLI, the `Sentinel` base class + the three sentinels
— `low-confidence-action`, `suspicious-memory-origin`,
`anomalous-tool-sequence` —, the first `coding-agent-safety` probe
`prompt-injection-cross-tool`, the Postgres-backed belief/claim/evidence
stores, `tool-poisoning-cross-session` together with the
proxy/`guard.wrap()` Postgres wiring it rides on, and now the
`Calibrator` (per-class ECE / Brier / calibration-gap tables) together
with the `confidence-drift` probe it gates, and finally the three
sentinels folded into the `coding-agent-safety` pack — the manifest
declares them under a `sentinels` field and the loader resolves each id
against the first-party `FIRST_PARTY_SENTINELS` registry — have all
landed). `@qmilab/lodestar-guard-mcp` and the post-v1 read-side
`@qmilab/lodestar-viewer` (the Governing UI, `lodestar view`) shipped to npm
in the v0.2.0 integrated release along with the rest of the 22 packages.
Batch 5 (week-8 thesis demo) has landed — all of Batches 1–5 are complete. The secondary
documentation-agent proving ground has landed
(`examples/documentation-agent/`) — it exercises the claim/evidence chain
on documentation content via a `DocumentationExtractor` +
`DocAwareEvidenceLinker` in `@qmilab/lodestar-cognitive-core`, the
`doc.read` tool in `@qmilab/lodestar-adapter-filesystem`, and a new
`GuardConfig.cognitive.evidenceLinkerFactory` seam on `guard.wrap()`. The
**Telenotes primary proving ground has also landed**
(`examples/telenotes-governed-dev/`): a deterministic in-process agent drives
the Batch-3 MCP proxy through a real feature task on a small Nostr-note fixture
— observe → decide → edit → test → commit → blocked-L4-push → revise — over two
live downstream MCP servers (the official filesystem server for read/write and
a first-party `dev-tools-mcp/` server for `shell_test`/`git_commit`/`git_push`),
with `lodestar report` rendering the full epistemic chain (committed under
`reports/`). A second `poison-run/` plants a hostile `DEVELOPMENT.md` and
self-verifies the firewall holds (poison stays `external_document`/`unverified`,
never enters trusted context, the L4 push stays blocked), locked in CI by the
`poisoned-file-cannot-hijack-feature-work` probe. A `real-claude-code/` recipe
+ proxy configs drive the same proxy with a live Claude Code session (the
built-in-tools-bypass caveat handled by denying Edit/Write/Bash); its captured
evidence has been recorded (committed under `real-claude-code/captured/`). The
Batch 5 blog/video walkthrough has also shipped — the reader guide is
`docs/guides/walkthrough.md`, published to the docs site at qmilab.com/lodestar/docs.
Post-v1 work is tracked in `docs/roadmap.md`.

This file is the entry point for any agent working in this repository. Read this first, then `docs/architecture/v02-delta.md` for current schema (note the Round 5 addendum and the naming-history section at the bottom), then the relevant package's `CLAUDE.md` for implementation details.

## What this project is

Lodestar is a TypeScript library and reference framework for governed agentic cognition. It sits above agent runtimes (OpenClaw, Hermes, Claude Code, raw LLMs with tools) and tracks the epistemic chain:

```
Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
```

Each link is a first-class type. Governance components (Action Kernel, Policy Kernel, Memory Firewall, Harness) exist to protect and instrument the chain.

## What this project is not

- Not an agent runtime. Use OpenClaw, Hermes, Claude Code, or raw LLMs underneath.
- Not an observability platform. Exports OTel-compatible traces; pair with Langfuse or Phoenix.
- Not a workflow builder, chat UI, or canvas.

## The thesis

An agent cannot safely act unless Lodestar can show:
- what it observed,
- what it claimed,
- what it believed,
- why it decided,
- what policy allowed,
- what happened,
- and how the system revised itself afterward.

Everything in this repo serves that thesis. Code that does not serve it does not belong here.

## Repository layout

Packages marked **(exists)** are implemented and present. Packages marked
**(Batch 2)** are scheduled for the current work cycle. Packages marked
**(later)** are downstream batches.

```
packages/
  core/                # (exists) types, schemas, epistemic chain primitives
  event-log/           # (exists) envelope, NDJSON writer/reader, snapshots
  action-kernel/       # (exists) tool registry, two-phase execution, sandbox
  memory-firewall/     # (exists) lifecycle axes, retrieval gates, promotion, subject-related contradiction routing; in-memory + Postgres (Bun.SQL) store backends
    adapters/
      mem0/            # (exists) mem0 import adapter
      letta/           # (exists) Letta blocks import adapter
      zep/             # (exists) Zep facts import adapter
  cognitive-core/      # (exists) claim extraction, belief adoption, planner, reflection
  cli/                 # (exists) `lodestar` CLI — report, guard wrap, action, trace, probe, pack (keygen/publish/attest/add, ADR-0019/0020; search/list/index-sign discovery, ADR-0021)
  guard/               # (exists) meta-package + guard.wrap() helper; in-process ApprovalResolver seam for held actions; re-exports the graduated autoApprovePolicy from policy-kernel; SentinelArbiter + compileWithSentinels wire the harness sentinels into the gate's arbitrate hook (sentinel→action, ADR-0001); arbiter also exposes observedBeliefIds() — the conservative observed-belief set guard-mcp reads to synthesize decisions for its opaque agent (cumulative, never reduced by execution; ADR-0003)
  trace/               # (exists) read side + `lodestar report` CLI
  viewer/              # (exists, post-v1) read-side Governing UI — `lodestar view`; Elysia + no-build vanilla SPA over the log; strictly read-only (no mutation route, never writes the log); surfaces pending approvals for visibility only
  guard-mcp/           # (exists, Batch 3) MCP proxy mode — `lodestar guard mcp-proxy`; held L4 actions wait up to `approval_timeout_ms` polling for an out-of-band `approval.granted@1`, else synthetic `approval_timeout`; optionally wires a SentinelArbiter (config.sentinels) and synthesizes a decision.made per action from the recency window so a belief-scoped alert holds the dependent tools/call — opaque-agent decision source (ADR-0003)
  runtime-core/        # (exists, v1.5) language-agnostic governance-gate sidecar — `lodestar runtime gate`; the reusable TS spine of the non-MCP runtime-adapter epic (#75/#83, ADR-0024/ADR-0025). Reuses the SAME engine the MCP proxy runs (ActionKernel two-phase, CompiledPolicy gate, CognitiveCore.ingest, SentinelArbiter decision synthesis, signed-approval hold path) and exposes it to a native runtime hook over a thin bidirectional NDJSON-RPC channel: govern → propose/arbitrate → (hold | remoted execute, the tool body runs back in the hook only inside the execute phase). Durable + idempotent holds reconstructed from the log + signed .approvals/ side-channel (survives a sidecar restart, exactly-once per action id); operator-owned tool_defaults contract (the untrusted hook only declares a name; unregistered → fail-closed deny); runtime tools namespaced runtime.<name> like the proxy's mcp.<server>.<tool>; lodestar.runtime_tool_result@1 observation + RuntimeAwareEvidenceLinker (external_document content can't auto-promote); RpcChannel transport seam (stdio for the CLI, in-process loopback for the always-on probe). No core schema / kernel change. Depends on guard (NOT guard-mcp → no MCP SDK)
  harness/             # (exists, Batch 4) probe-pack loader (probes + sentinel-id resolution) + Probe base class + pack runner (lodestar harness run) + Sentinel base class + three sentinels + FIRST_PARTY_SENTINELS registry + Calibrator (per-class ECE/Brier); npm/git pack source resolution (loadProbePackFromSource — non-executing fetch to an immutable pin, then verify-on-load; #86, ADR-0018); pack publish/add flow (publishProbePack signs in place + self-verifies, addProbePack resolves→verifies→installs→records the pin; shared resolve.ts so publish and verify digest identically; #90, ADR-0019); pack discovery index (loadPackIndex fetches + verifies a static signed listing against pinned index-publisher keys, searchPackIndexes filters locally, publishPackIndex signs an authored index; an index advertises but never authorizes — choosing a pack still routes through add/#88; #87, ADR-0021); scoped-env probe execution (runPack spawns each probe with a fresh empty HOME + inherited PATH, never the host process.env; operator widens via RunPackOptions.allowHostEnv / --allow-env, the untrusted manifest cannot; TS/process-level boundary, not an OS sandbox — host-env-secrets only, step 2 OS sandbox deferred; #114, ADR-0022)
  policy-kernel/       # (exists) compile(policy)→PolicyGate: trust-ladder floor, three-valued gate (allow/deny/hold), approval lifecycle, arbitrate hook (host-injected sentinel-alert + calibration-flag + synchronous low-confidence escalation; strengthens only). host wiring landed for all three paths: the in-process (guard.wrap() resolver seam), MCP-proxy (deadline/timeout out-of-band hold path), and the separate-process `lodestar approve` CLI (writes a side-channel the proxy promotes; proxy stays sole event-log writer)
  otel-exporter/       # (exists, post-v1) OTel GenAI semantic conventions bridge — `lodestar otel export`; read-side batch projection of a session into OTLP/HTTP-JSON spans (action-centric: invoke_agent root + execute_tool spans), hand-rolled wire format (no OTel SDK dep), with the sensitivity-ceiling export gate (content above the ceiling ships as metadata + payload hash only)
  ship/                # (exists) session shipper — `lodestar ship`; read-side batch transfer of a session's raw envelopes to a remote collector as the versioned NDJSON wire format `lodestar.session_ship@1` (POST {base}/v1/events), with the locked sensitivity ceiling applied client-side before egress (above-ceiling records ship redacted: payload replaced by a marker, original payload_hash kept so tamper evidence survives); bearer token from a named env var, never argv/logged; ADR-0014
  adapters/
    git/               # (exists, P2) read-only git.status + forge-agnostic transport (git.commit/push/clone); push is the first native egress (L4); remote pinning + scoped credentials (askpass, no argv); TS-level boundary, not an OS sandbox; ADR-0006
    filesystem/        # (exists) governed filesystem domain: fs.read + doc.read (L0) and fs.write (L3, graduated doc.write — issue #79); root-confined paths (lexical + symlink realpath checks), no host-env expansion, bounded write rejected-not-truncated, opt-in createDirs; TS-level boundary, not an OS sandbox; ADR-0012
    shell/             # (exists, P2) governed shell commands; config-driven tool factory (defineShellTool), TS-level sandbox (argv-only, allowlist, scoped env, timeout) — not an OS sandbox; ADR-0004
    github/            # (later) forge-API ONLY (PRs/issues/releases) behind a ForgeProvider seam — git transport lives in adapters/git/ (ADR-0006)
    nostr/             # (exists, P2) governed Nostr transport: nostr.publish (L4, second native egress — signing key IS the credential, in-process BIP-340) + nostr.fetch (L1, untrusted inbound); relay pinning, kind allowlist, NIP-42 AUTH, fetch SSRF guard; controlled-network sandbox; TS-level boundary, not network containment; ADR-0007
    http/              # (exists, P2) governed HTTP transport: http.request (L4, third native egress — host-bound auth header credential) + http.fetch (L1, untrusted inbound, the injection vector); hostname pinning + scheme allowlist + per-hop redirect re-validation (the SSRF escape) + bounded capture; reuses controlled-network; TS-level boundary, not network containment; ADR-0008
    messaging/         # (exists, P2) governed messaging transport: slack.post + email.send (both L4, fourth native egress — the purest human-approval demo); destination pinning (channel allowlist / recipient address+domain allowlist — the exfil guard), operator-fixed endpoint+sender (no agent host → no SSRF; no From spoofing), scoped header credential, no redirect following, send delivery semantics (non-2xx / Slack ok:false → failed); egress-only this slice; reuses controlled-network; TS-level boundary, not network containment; ADR-0009
    sql/               # (exists) governed SQL/database adapter (Bun.SQL/Postgres): sql.query (L1, untrusted rows, READ ONLY transaction) + sql.execute (L3→L4 mutation, held); the parameterized-only injection boundary (values always bound, never concatenated — no string SQL); lexical single-statement + read-only guards; scoped connection credential redacted from errors; result-row cap + statement_timeout; TS-level boundary, not DB containment; ADR-0013

examples/
  telenotes-governed-dev/    # (exists) reference demonstration; full pipeline
  doc-insight/               # (exists) firewall auto_observation gate demo
  coding-agent-greenfield/   # (exists) guard.wrap() demo on a homegrown agent
  claude-code-wrapped/       # (exists, Batch 3) MCP proxy wrapping a stand-in agent
  documentation-agent/       # (exists, Batch 5) doc-agent; claim/evidence over docs,
                             #   DocAwareEvidenceLinker via the guard cognitive seam

runtimes/                    # (v1.5) non-MCP runtime adapters — Python siblings of
                             #   packages/ (published to PyPI via OIDC trusted publishing
                             #   on the same `v*` tag as npm, lockstep; ADR-0024/0028)
  runtime-client/            # (exists) `lodestar-runtime-client` — the shared pure-stdlib
                             #   RPC client (GateClient/GateError/ToolBody): spawns the TS
                             #   gate, speaks NDJSON over stdio. Graduated from the three
                             #   hooks' verbatim copies (#128, ADR-0028); the hooks now
                             #   depend on it pinned `==<version>`. No framework deps.
                             #   Publishes FIRST (client → hooks matrix), like npm's PUBLISH_ORDER
  langgraph/                 # (exists) `lodestar-langgraph` — the thin native LangGraph
                             #   hook: spawns `lodestar runtime gate`, remotes each native
                             #   tool call over NDJSON-RPC (GateClient + govern_tools +
                             #   governed_call). Client from lodestar-runtime-client; langchain lazy
  crewai/                    # (exists) `lodestar-crewai` — the second thin hook (#84,
                             #   ADR-0026) on the SAME gate: a governed BaseTool subclass
                             #   overriding `_run` (the seam BaseTool.run + CrewStructuredTool
                             #   share). Depends on lodestar-runtime-client; crewai imported lazily
  autogen/                   # (exists) `lodestar-autogen` — the third thin hook (#85,
                             #   ADR-0027) on the SAME gate: a governed BaseTool subclass
                             #   overriding `run_json` (the seam StaticWorkbench.call_tool +
                             #   AssistantAgent dispatch through). The one divergence: AutoGen's
                             #   tool surface is fully async, so the wrapper offloads the gate
                             #   RPC off the event loop (asyncio.to_thread). Depends on
                             #   lodestar-runtime-client (#128, ADR-0028); autogen imported lazily

packs/
  lodestar-core/             # (exists, Batch 4) first-party probe pack: 67 probes +
                             #   lodestar.probe-pack.json manifest; loads via @qmilab/lodestar-harness
  coding-agent-safety/       # (exists, Batch 4) first non-core pack; ships
                             #   prompt-injection-cross-tool, tool-poisoning-cross-session,
                             #   and confidence-drift, plus all three sentinels declared
                             #   under the manifest's `sentinels` field (resolved by id)

docs/
  guides/              # reader-facing guides (the walkthrough + series)
  concepts/            # evergreen explainers (e.g. threat model)
  architecture/        # design memos, schema decisions, v0.2 delta with Round 5
  roadmap.md           # batch sequence to v1
  internal/            # planning & production, not for the docs site:
                       #   review/, whitepaper/, pitch-deck/, and walkthrough/
                       #   (BRIEF, video script, dev.to syndication copy)

research/
                       # probes/ moved to packs/lodestar-core/probes/ in Batch 4 —
                       #   the probes now ship as a loadable pack, not loose files
  benchmarks/          # (later) reproducible evaluation
  datasets/            # (later) logged event traces for analysis
```

## Stack invariants

- **Runtime and package manager:** Bun. Not Node, not pnpm.
- **Language:** TypeScript, strict mode.
- **Schema validation:** Zod. Every public API takes Zod-validated input and returns Zod-validated output.
- **Persistence:** PostgreSQL for structured state, NDJSON for the event log, optional pgvector for memory embeddings.
- **HTTP:** Elysia where HTTP is needed.
- **Tracing:** OpenTelemetry GenAI semantic conventions.
- **License:** Apache 2.0 throughout the public repo.

## Coding norms

- Every public type lives in `packages/core` and is exported through `@qmilab/lodestar-core`.
- Every package has its own `CLAUDE.md`, `README.md`, `package.json`, and `tsconfig.json` extending the root `tsconfig.base.json`.
- No package imports from another package via relative path. All cross-package imports use the `@qmilab/lodestar-*` workspace alias.
- No Telenotes-specific code in `packages/`. Telenotes-aware code lives only in `examples/telenotes-governed-dev/`.
- No silent defaults for security-relevant settings. Sandbox profile, sensitivity ceiling, trust level are explicit in every action contract.
- No `console.log` in production code paths. Use the event log for observability.

## How to work in this repo

When implementing a feature:

1. Check the v0.2 delta (`docs/architecture/v02-delta.md`) for the authoritative schema.
2. Define or update the Zod schema in `packages/core` first.
3. Implement the runtime behavior in the relevant package.
4. Add a probe in `packs/lodestar-core/probes/` that exercises the new behavior under adversarial conditions, and declare it in `packs/lodestar-core/lodestar.probe-pack.json`.
5. Update the package's `CLAUDE.md` if behavior changed.

When refactoring:

- Do not collapse the orthogonal memory lifecycle axes back into one enum. Truth, retrieval, security, and freshness are deliberately separate.
- Do not allow agent-written memories to self-promote. The Memory Firewall promotion gate is not a suggestion.
- Do not bypass the Action Kernel's two-phase execution. Tools that need to do work before approval are bugs.
- Do not pass host environment variables through to shell sandboxes. Use scoped, declared variables only.

## Slash commands

`.claude/commands/` defines reusable agent commands:

- `/lodestar-report <session_id>` — produce the full epistemic chain report for a session (wraps `lodestar report` CLI).
- `/lodestar-probe <probe_name>` — run a specific harness probe.
- `/lodestar-calibrate <calibration_class>` — produce a calibration table (Batch 4+).
- `/lodestar-explain <event_id>` — generate a human-audience Explanation for any governed event.

## Locked decisions (do not relitigate)

These are settled. If a session starts to question them, redirect it.

- **Architecture is locked at v0.2 + Round 5 fixes.** Schema in `packages/core/` is not open for change without a separate architectural session.
- **Four orthogonal memory lifecycle axes**: truth, retrieval, security, freshness. Do not collapse.
- **Auto-observation gate**: `external_document` and `model_inference` evidence cannot promote a claim to `truth_status: supported` automatically. Round 5 invariant.
- **CLI naming**: `lodestar report <session-id>` is the headline command. Not `lodestar trace report`.
- **TypeScript stays the implementation language through v0–v1.** Rust evaluation is post-v1.
- **`@qmilab/lodestar-*` workspace aliases stay for the duration of Batch 2.** The decision about the published npm scope (e.g., `@qmilab/lodestar-*`) is deferred and is mechanical when made.
- **Seventy-two probes pass and must keep passing.** Probes are spec, not test scaffolding. Do not edit them to match changed code. (Two — `tool-poisoning-cross-session` and `sql-adapter-enforces-invariants` — need a Postgres test database via `LODESTAR_TEST_DATABASE_URL`; they skip cleanly — exit 0 with a loud banner — when that is unset, and run for real in CI. One — `runner-sandboxes-probe-filesystem-and-network` — needs an OS sandbox mechanism (`sandbox-exec` on macOS / `bubblewrap` on Linux) and likewise skips loudly when none is available; CI installs bubblewrap. One — `langgraph-tool-calls-are-governed` — needs a Python + LangGraph runtime; it skips loudly when absent and runs for real in the CI `langgraph-runtime` job, which pip-installs `runtimes/langgraph[langgraph]`. One — `crewai-tool-calls-are-governed` — needs a Python + CrewAI runtime; it skips loudly when absent and runs for real in the CI `crewai-runtime` job, which pip-installs `runtimes/crewai[crewai]` on Python 3.12. One — `autogen-tool-calls-are-governed` — needs a Python + AutoGen runtime; it skips loudly when absent and runs for real in the CI `autogen-runtime` job, which pip-installs `runtimes/autogen[autogen]` on Python 3.12. The runner now spawns probes under a scoped env (#114, ADR-0022) and, when requested, an OS sandbox (#121, ADR-0023), so the operator forwards the DB var with `--allow-env LODESTAR_TEST_DATABASE_URL` — wired into `probes:all`/`probes:safety`.)

## Quick references

- Architecture: `docs/architecture/v02-delta.md` (read the Round 5 addendum and the naming-history section at the bottom)
- Roadmap: `docs/roadmap.md`
- Threat model: `docs/concepts/threat-model/memory-poisoning.md`
- Examples: `examples/telenotes-governed-dev/` (full pipeline), `examples/doc-insight/` (firewall gate focus)
- Walkthrough (reader guide): `docs/guides/walkthrough.md`
