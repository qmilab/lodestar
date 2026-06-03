# Lodestar — v0.2 Delta

*Implementation-readiness revisions over v0.1*

This document captures the seven required revisions from round-4 review. It is a delta, not a full rewrite — read v0.1 first, then this.

> **Status (current as of 2026-06-03).** This delta plus its Round 5 addendum
> (below) is the **authoritative schema** and remains current — Batches 1–5 have
> landed against it without schema changes (the architecture is locked at
> v0.2 + Round 5; see `CLAUDE.md`). The repo-layout sketch in §9 is the *original
> plan*; for what actually shipped see `docs/roadmap.md` and the per-surface
> design locks in this directory (`reflection-pass.md`, `sentinels.md`,
> `calibrator.md`). The reader-facing overview of how the packages fit together
> is [reference/architecture.md](../reference/architecture.md); the project's
> naming history is in the section at the bottom of this file.

---

## 1. Telenotes is a reference demonstration, not a pilot

**Change.** Section 10 of v0.1 ("Telenotes pilot implementation") is renamed to **"Reference demonstration: Telenotes governed development"** and moved out of the core architecture sections into a demonstration appendix.

**Implementation consequence.** No Telenotes-specific types, policies, or assumptions enter `packages/core`. Telenotes-specific code lives in `examples/telenotes-governed-dev/`. The example imports from `@qmilab/lodestar-core` and registers its own adapters, policies, and probes — it does not extend them.

**Why this matters.** v0.1 unintentionally coupled the architecture to Telenotes. Other Playground projects (AstroLLM research workflows, MachineCraft governance, multi-agent adversarial review) need the same primitives without inheriting Nostr-specific or Telenotes-specific assumptions.

## 2. ContextPolicy as a first-class primitive

**Change.** Add `ContextPolicy` to the core types. The cognitive core consults it whenever it assembles model context for claim extraction, planning, decision generation, or explanation.

```typescript
type ContextPolicy = {
  // Which lifecycle states may be loaded into context
  allowed_truth_statuses: TruthStatus[]
  allowed_retrieval_statuses: RetrievalStatus[]
  allowed_security_statuses: SecurityStatus[]

  // Freshness gate
  freshness_max_age?: string                // ISO 8601 duration

  // Sensitivity ceiling for what can enter context
  sensitivity_ceiling: Sensitivity

  // What the planner sees
  include_contradictions: boolean           // surface contradicting beliefs?
  include_uncertainties: boolean            // surface low-confidence beliefs?
  require_evidence_for_decisions: boolean   // reject decisions without belief_dependencies?

  // Authority handling
  user_asserted_takes_priority: boolean
  policy_asserted_takes_priority: boolean
}
```

**Why this matters.** In LLM systems, what enters context often matters more than what is stored. Without an explicit ContextPolicy, "the planner used a stale belief" or "the explanation leaked a secret claim" become invisible bugs. With it, those become testable invariants.

**v0 default.** Conservative: `allowed_truth_statuses: ["supported"]`, `allowed_retrieval_statuses: ["normal"]`, `allowed_security_statuses: ["clean"]`, `freshness_max_age: "P30D"`, `sensitivity_ceiling: "internal"`, `include_contradictions: true`, `include_uncertainties: true`, `require_evidence_for_decisions: true`.

## 3. Sensitivity as a content attribute

**Change.** Add `sensitivity` as an attribute on `Claim`, `Belief`, `Memory`, and `Observation`. It is *not* a fifth lifecycle axis — the four orthogonal axes describe the *state* of a belief; sensitivity describes its *content*.

```typescript
type Sensitivity = "public" | "internal" | "confidential" | "secret"
```

**Effects of sensitivity.**

- Retrieval: gated by `ContextPolicy.sensitivity_ceiling`.
- Explanation generation: explanations targeting `audience: "human"` redact content above the recipient's sensitivity level.
- OTel export: events above a configured sensitivity threshold are not exported by default; spans are emitted with metadata but payload is dropped or hashed.
- Final reports: sensitivity-filtered.

**v0 default.** Observations from public sources start `"public"`. Tool outputs default to `"internal"`. Anything touching keys, secrets, or credentials is `"secret"`. The signing service refuses to handle payloads above the actor's clearance.

**Why this matters.** A belief can be true, fresh, clean, and supported, but still secret. v0.1 had no way to express "this is fine to know but not fine to surface."

## 4. EvidenceSet simplified for v0

**Change.** Replace v0.1's scalar `strength: number` with an explicit list of evidence items. Computed strength can come later, once enough data exists to validate the scoring function.

```typescript
type EvidenceItem = {
  source_id: string                         // observation_id, belief_id, or external ref
  relation: "supports" | "contradicts" | "contextualizes"
  quality: "direct_observation"
         | "tool_result"
         | "human_assertion"
         | "model_inference"
         | "external_document"
         | "synthetic_probe"
  independence_group?: string               // sources in the same group are not independent
  freshness: "fresh" | "stale" | "unknown"
  notes?: string
}

type EvidenceSet = {
  id: string
  claim_id: string
  items: EvidenceItem[]
  assessed_by: string                       // actor_id
  assessed_at: string
  // strength: computed lazily by an evidence aggregator; not stored as authoritative
}
```

**Why this matters.** A scalar strength suggests precision the system doesn't yet have. The item list keeps the underlying structure and lets the scoring algorithm evolve based on empirical results, without baking false precision into the schema.

## 5. Signing scope reduced

**Change.** v0.1 implied "sign every internal event in week 1." That's overkill. In v0:

- **Required signatures (Ed25519).** Skills, policy versions, external imports, secret-signing events (e.g. Nostr event signatures), release artifacts.
- **Required content hashes (sha-256).** All event envelopes carry `payload_hash`. This gives tamper-evidence for the append-only log.
- **Not signed in v0.** Routine internal observations, claim extractions, belief promotions, decisions, action proposals.

Actor identity is recorded on every event (`actor_id` is mandatory), but cryptographic attestation is reserved for the cases where forgery is a real threat.

**Why this matters.** Signing every internal event adds real implementation cost and key-management overhead without proportionate security benefit. The threats signatures defend against (skill tampering, policy substitution, external import provenance) are the ones that get signatures; the internal pipeline relies on the append-only log and content hashes.

## 6. Shell safety made explicit

**Change.** The `controlled-shell` sandbox profile in v0.1 was under-specified. Concrete v0 invariants:

- **Locked dependency state.** Shell commands run against a frozen lockfile. No `bun install`, `npm install`, `pip install` unless explicitly approved as a separate L4 action.
- **No host secrets in env.** The shell environment receives only declared, scoped variables. `process.env` is not passed through.
- **Network disabled by default.** Shell containers run with `--network none` unless the action contract explicitly requests network with allowlisted destinations.
- **Timeout.** Every shell invocation has a wall-clock timeout in the contract; the kernel kills the process at the deadline.
- **Scoped filesystem.** The shell sees a bind-mounted view of the project root only; no access to home, system directories, or other projects.
- **Output capture.** stdout, stderr, exit code, and duration are captured as a typed observation. Truncation rules are explicit.
- **No lifecycle scripts.** `npm test` / `bun test` are run with flags that disable lifecycle and pre/post scripts unless the action contract explicitly approves them.

These invariants are enforced at the Action Kernel layer, not by tool authors. Tools that need shell access declare what they need; the kernel constructs the sandbox accordingly.

**Why this matters.** "Run tests" looks safe but isn't. Lifecycle scripts, dependency installs, and ambient env vars are how a poisoned dependency or a malicious patch turns a routine action into an exfiltration path.

## 7. Signed skills deferred from critical path

**Change.** Skill provenance remains in the v0 schema, but full signature verification of skills is moved from week 4 to a week-8 stretch goal. v0 ships with skill content hashes and review status; cryptographic signatures are added in v0.2 if time permits.

**Why this matters.** Signed skills are the right end state, but they're not on the critical path for proving the thesis. The first vertical slice can demonstrate governed knowledge formation without exercising the full skill-signing flow. Defer to keep weeks 4–5 honest.

## 8. Demo target: week 8 without real Nostr publish

**Change.** v0.1 §11.1 demo step about "signed Nostr publish" is removed from the week-8 critical path. The signing service is plumbed as a capability pattern and exercised through a synthetic probe (a proposed Nostr event that the policy kernel approves; another that it rejects). Real relay publication moves to v0.2 / week 9.

**Why this matters.** Nostr publication is meaningful but it's not what proves the thesis. The thesis is governed knowledge formation, demonstrated by the epistemic chain and the final report. Real publication adds a week of relay handling, retry logic, and NIP handling that distracts from the core demo.

## 9. Repo layout (library-first, no premature hosted/)

```
lodestar/
├── packages/
│   ├── core/                       # types, schemas, epistemic chain primitives
│   ├── event-log/                  # envelope, NDJSON writer/reader, snapshots
│   ├── action-kernel/              # tool registry, two-phase execution, sandbox
│   ├── policy-kernel/              # trust ladder, action contracts, approvals
│   ├── memory-firewall/            # lifecycle axes, retrieval gates, promotion
│   ├── cognitive-core/             # claim extraction, belief adoption, planner, reflection
│   ├── harness/                    # probes, sentinels, calibrators, replay-lite
│   ├── otel-exporter/              # OTel GenAI semantic conventions bridge
│   ├── cli/                        # lodestar command-line interface
│   └── adapters/
│       ├── git/
│       ├── github/
│       ├── filesystem/
│       ├── shell/
│       └── nostr/
├── examples/
│   └── telenotes-governed-dev/
│       ├── policy.lodestar.ts
│       ├── probes/
│       └── README.md
├── docs/
│   ├── architecture/
│   ├── patterns/
│   └── threat-model/
├── research/
│   ├── benchmarks/
│   ├── probes/
│   └── datasets/
├── .claude/
│   ├── agents/
│   └── commands/
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.base.json
└── biome.json
```

No `hosted/` package. If a commercial hosted control plane is ever built, it lives in a separate private repository that imports from `@qmilab/lodestar-core` and the other public packages.

---

## What the v0.2 schema looks like, consolidated

```typescript
// Identity
type Actor = {
  id: string
  kind: "human" | "agent" | "tool" | "probe" | "sentinel" | "system" | "imported"
  display_name: string
  authority_scope: ResourceScope[]
  signing_key_id?: string
  trust_baseline: number
  sensitivity_clearance: Sensitivity         // NEW: max sensitivity this actor can handle
}

// Epistemic chain
type Observation = {
  id: string
  schema: string
  payload: unknown
  source: { tool: string; invocation_id: string; captured_at: string }
  context: { session_id: string; project_id: string; actor_id: string }
  trust: "raw" | "validated" | "synthetic"
  sensitivity: Sensitivity                   // NEW
}

type Claim = {
  id: string
  statement: string
  structured_predicate?: Predicate
  source_observation_ids: string[]
  extraction_method: "tool" | "llm" | "human" | "import"
  extracted_by: string
  status: "extracted" | "contested" | "accepted" | "rejected"
  scope: ResourceScope
  sensitivity: Sensitivity                   // NEW
  authors: string[]
  dissent?: Dissent[]
}

type EvidenceItem = {                        // CHANGED: replaces scalar strength
  source_id: string
  relation: "supports" | "contradicts" | "contextualizes"
  quality: "direct_observation" | "tool_result" | "human_assertion"
         | "model_inference" | "external_document" | "synthetic_probe"
  independence_group?: string
  freshness: "fresh" | "stale" | "unknown"
  notes?: string
}

type EvidenceSet = {
  id: string
  claim_id: string
  items: EvidenceItem[]                      // CHANGED
  assessed_by: string
  assessed_at: string
}

type Belief = {
  id: string
  claim_id: string
  confidence: number
  calibration_class: string
  scope: ResourceScope
  authority: BeliefAuthority
  sensitivity: Sensitivity                   // NEW

  truth_status: "unverified" | "supported" | "contradicted" | "superseded"
  retrieval_status: "hidden" | "restricted" | "normal" | "privileged_only" | "blocked"
  security_status: "clean" | "suspicious" | "quarantined" | "malicious"
  freshness_status: "fresh" | "stale" | "expired"

  observed_at: string
  last_verified_at?: string
  expires_at?: string
  superseded_by?: string
}

// Context policy (NEW first-class)
type ContextPolicy = {
  allowed_truth_statuses: TruthStatus[]
  allowed_retrieval_statuses: RetrievalStatus[]
  allowed_security_statuses: SecurityStatus[]
  freshness_max_age?: string
  sensitivity_ceiling: Sensitivity
  include_contradictions: boolean
  include_uncertainties: boolean
  require_evidence_for_decisions: boolean
  user_asserted_takes_priority: boolean
  policy_asserted_takes_priority: boolean
}

// Decision, Action, Outcome, Revision, Explanation: unchanged from v0.1
// Memory: gains `sensitivity` attribute
// Skill: signature deferred to v0.2 stretch
```

---

## Implementation cost adjustment

Net effect of v0.2 revisions on the eight-week roadmap:

| Change                          | Cost adjustment |
| ------------------------------- | --------------- |
| Telenotes-as-example            | Neutral (cleaner separation, same code volume) |
| ContextPolicy                   | +0.5 week (week 2 or 3) |
| Sensitivity attribute           | +0.25 week (mostly schema and retrieval gating) |
| EvidenceSet simplification      | −0.25 week (less to build) |
| Signing scope reduced           | −1 week (real cost savings in weeks 1–5) |
| Shell safety made explicit      | +0.5 week (week 5) |
| Signed skills deferred          | −0.5 week from week 4 |
| Demo without Nostr publish      | −0.5 week from week 8 |

Net: roughly the same eight weeks, with implementation shifted from cryptography toward the epistemic primitives and context policy. The thesis demo gets cleaner because it's not fighting Nostr relay code.

---

*v0.2 delta complete. Next: week-1 scaffold artifacts (CLAUDE.md, root package.json, tsconfig, core types, event-log, action-kernel skeleton, CLI stub, two adapter stubs).*

---

# Post-implementation positioning shift (added after week 2 scaffold completed)

The architecture in this memo remains correct. The strategic framing around it has been refined based on a product-strategy review with ChatGPT (May 23, 2026) that asked four questions:

1. Is "epistemic governance framework" too abstract for a developer audience?
2. Can a widely-deployable product be created out of this?
3. Should the larger part be open source?
4. Should there be a marketplace?

The conclusion (recorded in the project's positioning notes):

- **External voice changes**, internal voice stays. "Epistemic governance framework" remains the correct technical phrase in this memo and in research artifacts. The homepage and developer-facing surfaces use "trust layer for AI agents" because it is concretely actionable.

- **Architecture stays as-is**, but the surface is re-presented through four developer-facing packages:
  - `@qmilab/lodestar-guard` — wraps tool calls (write side)
  - `@qmilab/lodestar-trace` — produces audit reports (read side)
  - `@qmilab/lodestar-memory-firewall` — works alongside mem0/Letta/Zep (horizontal)
  - `@qmilab/lodestar-harness` — probes, sentinels, calibrators (marketplace surface)

- **Open-source strategy** follows Langfuse's Model A. Apache 2.0 for primitives, Guard, Trace, Memory Firewall, Harness, adapters, and basic replay. Reserved for future commercial offering: hosted dashboard, team approvals, compliance exports, advanced replay UI, enterprise policy packs, managed marketplace.

- **Marketplace is trust packs, not skill packs**. Policy packs, probe packs, sentinel packs, adapter packs, signed manifests. Sequenced v0 (local examples) → v0.2 (curated packs in repo) → v1 (public registry) → v1.5 (signed manifests) → v2 (paid enterprise packs).

- **First headline use case is coding agents**, not Telenotes. Telenotes remains the first proving ground, but the marketing story is "wrap your coding agent (Claude Code, Cursor, OpenClaw, etc.) and get a trust report." The Telenotes demo *is* a coding agent building Telenotes — same demo, different framing.

- **Organizational home is QMI Lab** for the research arc and the open-source primary. Commercial extensions follow later.

None of these decisions change the schemas, the firewall rules, the calibration framework, or the threat model. They change how the architecture is presented and which developer-facing entry points it offers.

The implementation roadmap that flows from this is in `docs/roadmap.md`. Five batches: positioning (now), package cleanup, harness infrastructure, MCP proxy, week-8 demo.

---

# Round 5: ChatGPT scaffold sanity check (added after Batch 1 positioning sent for review)

After Batch 1's positioning docs were sent to ChatGPT alongside the working scaffold, the review returned a 10-point critique. The architecture itself was validated; the concerns were positioning honesty, additional firewall invariants, and roadmap sequencing.

## Changes accepted

1. **Removed the mem0 CVSS 8.1 claim from positioning.md**. The source (theaiagentindex.com) was secondary, not a primary CVE advisory. Closest verifiable hit was for usememos/memos, a different project. Replaced with a neutral statement about the gap memory layers leave open: continuity vs governance.

2. **Added explicit "does not replace" line in README**. The complementary positioning was implied; now it's stated.

3. **Renamed "four open-source surfaces" → "four developer entry points"** in public copy. "Surface" remains internal-architecture vocabulary; user-facing material uses "entry point".

4. **`lodestar report` as the primary user-facing CLI command**. The package stays `@qmilab/lodestar-trace`, but the command becomes `lodestar report` to avoid the LangSmith/Langfuse "trace" collision and to focus on what users get (explanation) rather than the mechanism (tracing).

5. **Reordered Batches 3 and 4**. Original sequence put Harness infrastructure (Batch 3) before MCP proxy (Batch 4). Revised: MCP proxy moves to Batch 3 because the headline use case ("wrap a coding agent") must land before the project spends more time on internal machinery. Harness moves to Batch 4. A minimum-viable probe runner ships with Batch 3 to back the safety story until the full Harness lands.

6. **Added four firewall invariant probes to Batch 2** (working with the current scaffold):
   - External-document evidence cannot directly adopt at `retrieval_status: normal`
   - Quarantined belief cannot be retrieved by the standard planner path
   - Sensitivity ceiling blocks `secret` beliefs from default context
   - `auto_observation` cannot promote `external_document` or `model_inference` evidence

   Two additional probes deferred to Batch 4 because they need infrastructure that doesn't yet exist (reflection pass, Decision dependency pipeline).

7. **Documentation-agent example as a second proving ground in Batch 5**. Lightweight, exercises claim/evidence beyond schema-bound extractors, no PII/policy complexity. Customer-support and data-analysis examples explicitly deferred to v1.x.

8. **Walked back research paper timeline**. Position paper and threat-model notes are reasonable to draft in 2026. Empirical memory-poisoning, calibration, and evaluation-methodology papers move to 2027+ — they need accumulated session data that doesn't exist yet.

## Code fixes scheduled for Batch 2 (called out by the review)

- **ContextPolicy contradiction routing bug**: the current filter excludes contradicted beliefs before the contradiction surface can return them. Fix: separate `retrieveContradictions(query, policy)` method that returns related contradicted beliefs in a dedicated channel.
- **Kernel context propagation**: `session_id`/`project_id` defaults of `"session-stub"`/`"project-stub"` must accept real values from the host before MCP proxy ships.
- **Event log single-writer enforcement**: process-local writer must be made concurrency-safe (file lock or single-process invariant) before MCP proxy introduces parallel tool calls.
- **`auto_observation` evidence-quality gate**: the cognitive core currently allows `auto_observation` transition based on evidence strength alone. Add a check: if highest-quality evidence is `external_document` or `model_inference`, downgrade authority to `reflection`.

## Where I pushed back

One stylistic disagreement: ChatGPT recommended softening "whether it was right" in the tagline to "how the outcome compared to its claims." I kept the punchy tagline because slogans can be aspirational; the explanatory body text is where precision matters. The body copy has been softened; the tagline has not.

## What's untouched

The architecture itself. The four orthogonal lifecycle axes, the no-self-promotion rule, the BeliefAuthority/TransitionAuthority separation, the two-phase action execution, the replay-grade event log, the trust ladder — all validated by the review and unchanged. ChatGPT confirmed that the data axes are holding up, the package boundaries are sensible, and the BeliefAuthority/TransitionAuthority separation is "one of the best design corrections."

## Bottom line

The project's next regret risk is sequencing, not architecture. The instruction from this round is unambiguous: get to `lodestar guard mcp-proxy && claude code && lodestar report` as quickly as possible. That moment is when Lodestar becomes legible to anyone outside the design conversation.

---

## Batch 3 — MCP proxy threat model

The Batch 3 MCP proxy (`@qmilab/lodestar-guard-mcp`) introduces a
new trust boundary: between the wrapped agent's MCP client and the
downstream MCP servers it talks to. This section documents the
threat model the v0 proxy explicitly covers and the threats deferred
to later batches.

### Trust topology

```
       (wrapped agent)        (proxy)            (downstream server)
            client  ── stdio ──▶ server ─ stdio ─▶ server
                                  │
                                  ▼
                           Lodestar Action Kernel
                           Lodestar Cognitive Core
                           Append-only event log
```

The proxy is single-process per session. There is exactly one
wrapped agent, one Action Kernel, one Memory Firewall, one event log
per proxy lifetime. Multi-tenancy is intentionally out of scope; a
hosted multi-tenant control plane would sit above the open-source
core, not inside it.

### Trust boundaries

| Boundary | What crosses it | Trust posture |
| --- | --- | --- |
| Agent ↔ proxy | `tools/call` requests; `CallToolResult` responses | The agent's tool requests are inputs to be governed; the proxy's responses are the proxy's own statement about what was allowed and what the downstream returned. |
| Proxy ↔ kernel | Proposed actions; arbitration decisions; precondition revalidation | Internal to Lodestar; not a security boundary, but Round 5 invariants still apply (real session/project IDs, no stub fallback, two-phase execution). |
| Proxy ↔ downstream | `tools/call` requests; `CallToolResult` responses | The downstream is **untrusted**. Its tool annotations are not honoured by the proxy's policy gate; its result contents are recorded as `external_document` evidence quality. |
| Proxy ↔ disk | Event log NDJSON writes | Internal; per-partition append serialization (PR #2) protects against torn writes within the process. |

### Threats the v0 proxy covers

1. **Memory poisoning via tool result content.** The downstream
   returns text containing prompt-injection payloads (fake "[SYSTEM]"
   directives, planted instructions, hostile suggestions). The
   `MCPToolResultExtractor` separates the tool-call envelope claim
   (`tool_result` quality) from per-text-block content claims
   (`external_document` quality). The `MCPAwareEvidenceLinker` flags
   the content claim's source evidence as `external_document`,
   tripping the Round 5 auto-observation gate. The poisoned content
   stays at `truth_status: unverified` regardless of apparent
   strength. Probe: `mcp-proxy-injection-defense`.

2. **Untrusted tool annotations.** The MCP spec marks tool
   annotations (e.g., `destructive_hint`, `read_only_hint`) as
   untrusted unless from a trusted server. The proxy ignores them
   entirely. Action-contract values (reversibility, blast radius,
   sandbox profile, required trust level) come from operator-
   controlled `tool_defaults` or from a conservative fallback
   (irreversible, controlled-shell sandbox, L3 trust). The bias is
   toward "refuse unless explicitly approved" rather than "approve
   unless caught."

3. **Stub-session leak.** PR #2 removed the `session-stub` /
   `project-stub` defaults from `ActionKernel`; the proxy enforces
   that real session/project IDs propagate to every observation,
   claim, belief, action, and event-log envelope. Probes:
   `kernel-context-propagation`, `mcp-proxy-roundtrip`.

4. **Concurrent writers tearing the log.** PR #2's per-partition
   `sharedAppendLocks` mutex serialises concurrent appends to the
   same `${rootDir, project_id}` partition. The proxy adds no new
   concurrency mechanism; it hooks into the existing writer. Probe:
   `event-log-single-writer`.

5. **Unknown content block kinds.** The MCP spec is evolving; new
   content block types (beyond text/image/audio/resource) may appear
   in future protocol versions. The proxy records unknown kinds
   under a `{ type: "unknown", original_type, raw }` discriminated
   variant rather than crashing on parse — the audit trail
   preserves verbatim what arrived even when Lodestar's schema can't
   classify it.

6. **Policy denial without aborting the agent.** When the policy
   gate refuses a tool call, the proxy returns a synthetic
   `CallToolResult` with `isError: true` and a structured
   `_meta._lodestar` payload, instead of an MCP-level protocol
   error. The wrapped agent reads the denial as a normal tool
   response and can revise its plan, rather than treating the
   denial as a transport-level failure that aborts the session.

### Threats deferred to later batches

These are real attack surfaces the v0 proxy does NOT cover. Each
ships with the explicit acknowledgement that operators relying on
the proxy in production should know what's missing.

- **Sandbox enforcement at the OS level.** The proxy declares
  `sandbox: SandboxProfile` in each tool's action contract, but the
  declaration is informational — no namespace/cgroup/container layer
  enforces it in v0. A compromised downstream that the operator
  intended to confine to `read` could still issue `fs.write` or
  `shell.exec` calls; Lodestar would record them faithfully but not
  prevent them. Real sandbox enforcement lands with the Policy
  Kernel (Batch 4+).

- **Multi-process event-log coordination.** The per-partition mutex
  serialises appends within a single process. Two proxies pointed
  at the same log root would race. The MCP proxy is documented as
  single-process per session; a file-lock layer on top of the
  existing interface would add multi-process safety without
  changing the writer API.

- **Subscription to downstream `tools/list_changed` notifications.**
  The proxy snapshots the downstream tool catalog at startup and
  does not refresh it. A downstream that adds or removes tools at
  runtime would not be picked up until proxy restart. Capability
  is declared off (`listChanged: false`) on the upstream face so
  agents do not expect change notifications.

- **HTTP/SSE upstream transport.** v0 is stdio only. HTTP/SSE
  enables more sophisticated deployment patterns (multiple agents
  sharing a proxy, remote operation) but expands the surface
  meaningfully. Deferred.

- **Reflection authority promoting `external_document` content
  claims.** The auto-observation gate downgrades to `reflection`
  authority for these claims. Reflection landed in Batch 4
  (`@qmilab/lodestar-cognitive-core/reflection`; the
  `reflection-cannot-promote-to-normal-alone` probe pins the
  invariant that reflection alone cannot move a belief to `normal`
  retrieval). The v0 reflection pass is rule-based, so a content
  claim still stays at `truth_status: unverified` unless an
  independent corroborating source arrives or a user explicitly
  promotes it — LLM-driven, reflection-led corroboration that would
  promote such a claim on its own is the remaining deferred piece.

- **Cross-session contradiction propagation.** Contradiction
  routing within a single session is wired (PR #2's
  subject-relation join). Contradictions across sessions — e.g., an
  earlier session adopted belief X, the current session sees
  evidence against X — require a persistent belief store that v0's
  in-memory stores don't provide. Postgres-backed stores land in a
  later batch.

### Operator guidance

Until the deferred items land, operators wrapping a coding agent
with the v0 MCP proxy should:

- Treat `auto_approve_ceiling` as the real policy. There is no
  approval UI in v0; everything above the ceiling is denied
  outright (with a synthetic policy_denied response).
- Be explicit in `tool_defaults`. Every downstream tool that should
  run at trust level < L3 needs a per-tool override; otherwise the
  conservative default refuses to auto-approve.
- Run downstream MCP servers inside an OS-level sandbox of your
  own (chroot, container, restricted user). Lodestar's `sandbox`
  declaration is *intent*, not *enforcement*, in v0.
- Pipe the event log to durable storage. `.ndjson` works locally;
  for any non-throwaway session, tail to a real log store.

---

## Naming history

The project was originally developed under the codename **Orrery**.
Before public launch, the name was changed to **Lodestar** following
diligence on GitHub/npm namespace collisions and brand-positioning
review.

The architecture vocabulary continues to use astronomy-adjacent terms
where they carry semantic weight:

- **Lodestar** — the product. A guiding star; a fixed reference point
  for navigation. Externally: the trust layer for AI agents.
- **Parallax** — the architectural principle that single-source
  claims (especially LLM judgments) cannot auto-promote to settled
  beliefs. Belief promotion requires evidence from independent
  sources, in the same sense that astronomical parallax requires
  observation from independent vantage points.
- **Ephemeris** — the conceptual role of the event log. An ephemeris
  is a table of positions over time; the Lodestar event log records
  the position of the agent's epistemic state over time, supporting
  replay and post-hoc audit.

The original codename Orrery is preserved in references to early architectural
decisions.
