---
title: "Probe packs"
description: "The lodestar.probe-pack.json manifest format, the loader, and the full list of 79 probes and 3 sentinels across the two first-party packs."
---

# Probe packs

A **probe pack** bundles adversarial probes (and optionally runtime sentinels)
behind a manifest so the [harness](../concepts/sentinels-and-calibration.md) can
load and run them as a unit. Probes are Lodestar's executable spec — *not* test
scaffolding. They are not edited to match changed code; the code is expected to keep
satisfying them.

The two first-party packs live in `packs/`:

- **`lodestar-core`** — the core epistemic-chain, memory-firewall, guard,
  event-log, Policy Kernel, sentinel-wiring, adapter, cognitive-core,
  trust-pack-registry, probe-runner, runtime-adapter, and read-side invariants
  (75 probes).
- **`coding-agent-safety`** — the "wrap a coding agent" story: prompt injection,
  tool poisoning, confidence drift, plus the three first-party sentinels (4 probes
  + 3 sentinels).

Run them with [`lodestar harness run --pack <name>`](cli.md#harness-drive-a-whole-pack)
or, for the whole suite, `bun run probes:ci`.

## The manifest

Each pack has a `lodestar.probe-pack.json` at its root, validated against a Zod
schema in `@qmilab/lodestar-core` and resolved by the loader in
`@qmilab/lodestar-harness`.

```json
{
  "name": "coding-agent-safety",
  "version": "0.1.0",
  "spec_version": "1",
  "source_type": "local",
  "description": "Adversarial probes and online sentinels for the 'wrap a coding agent' story…",
  "coverage_areas": ["prompt_injection", "tool_poisoning", "..."],
  "invariants": ["injection_defense", "no_self_promotion", "..."],
  "probes": [
    { "name": "prompt-injection-cross-tool", "file": "probes/prompt-injection-cross-tool.ts" }
  ],
  "sentinels": [
    { "id": "low-confidence-action" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string (kebab-case) | Pack identifier |
| `version` | string (semver) | Pack version |
| `spec_version` | `"1"` | Manifest spec version (fixed at `"1"`) |
| `source_type` | `"local"` \| `"npm"` | v0 loads `local` packs only |
| `description` | string | Optional, human-readable |
| `coverage_areas` | string[] | Free-form tags for what the pack covers |
| `invariants` | string[] | Free-form tags for the invariants it pins |
| `probes` | `{ name, file }[]` | At least one; `name` kebab-case, `file` a pack-relative path |
| `sentinels` | `{ id }[]` | Optional; each `id` resolves against the harness's first-party registry |

The loader resolves each probe `file` to an absolute path within the pack root
(symlink-aware), enforces unique probe names, and resolves each sentinel `id`
against the built-in `FIRST_PARTY_SENTINELS` registry. v0 does not support
third-party sentinels or `npm`-sourced packs — both are reserved for the post-v1
registry.

## The 75 probes in `lodestar-core`

**Firewall, epistemic-chain, guard, and event-log invariants** (Batches 1–5):

| Probe | Pins |
| --- | --- |
| `memory-poisoning-basic` | a planted "successful experience" is not promoted |
| `epistemic-chain-smoke` | the full chain links end to end |
| `external-document-not-normal` | `external_document` evidence can't adopt at `normal` retrieval |
| `quarantined-not-retrievable` | a quarantined belief can't reach the planner |
| `sensitivity-ceiling` | `secret` beliefs stay out of default context |
| `auto-observation-gate` | `external_document` / `model_inference` can't auto-promote |
| `guard-import-no-self-promote` | imported memory can't self-promote |
| `guard-precondition-revalidation` | two-phase execution re-checks preconditions |
| `guard-contract-invariants` | action contracts hold |
| `context-policy-contradiction-routing` | contradictions surface in their own channel |
| `kernel-context-propagation` | real session/project ids propagate (no stub fallback) |
| `event-log-single-writer` | concurrent appends don't tear the log |
| `mcp-proxy-roundtrip` | the proxy round-trips a tool call faithfully |
| `mcp-proxy-injection-defense` | injected tool-result content stays unverified |
| `reflection-cannot-promote-to-normal-alone` | reflection alone can't promote a belief |
| `contradicted-belief-flags-dependent-decisions` | a contradiction cascades to dependents |
| `event-log-canonical-hash` | canonical payload hashing is stable |
| `documentation-evidence-provenance` | doc claims carry their evidence provenance |

**Policy Kernel, the trust ladder, and the approval lifecycle:**

| Probe | Pins |
| --- | --- |
| `l4-action-requires-approval` | an L4 action is held at `pending_approval`, never executed outright |
| `l4-floor-preserves-stricter-rule` | the trust-ladder floor keeps the stricter of rule vs. ladder |
| `pending-approval-cannot-execute` | a held action can't run until it's granted |
| `ladder-floor-overrides-allow-rule` | the ladder floor overrides a too-permissive allow rule |
| `unmatched-action-defaults-to-deny` | an action no rule matches defaults to deny |
| `policy-version-signature-required` | a policy document must carry a valid signature |
| `granted-approval-still-revalidates-preconditions` | a granted approval still re-checks preconditions before running |
| `guard-hold-resolves-via-resolver` | a held action resolves through the in-process approval-resolver seam |
| `approval-timeout-denies` | a hold with no approval times out to a denial |
| `approval-via-side-channel` | a separate-process `lodestar approve` resolution un-parks the hold |
| `forged-approval-cannot-execute` | a forged / unsigned / tampered approval can't un-park a held L4 (Ed25519) |
| `proxy-hold-carries-rule-authority` | a held action carries its matched rule's required authority |
| `approval-via-http-channel` | a hold resolves through the pluggable HTTP approval-transport channel |
| `forged-approval-via-http-channel-cannot-execute` | a hostile channel can delay but never mint/tamper/replay an approval — the Ed25519 boundary holds after transport |
| `pending-queue-excludes-rejected-forgery` | a rejected forged resolution never appears in the pending-approvals queue |

**Sentinel→action and calibration→action wiring:**

| Probe | Pins |
| --- | --- |
| `sentinel-alert-gates-dependent-action` | a sentinel alert holds the dependent action at the gate |
| `calibration-flag-escalates-action` | a calibration flag strengthens the gate decision |
| `guard-arbiter-gates-dependent-action` | a real sentinel → `guard.wrap()` host → the dependent action is held |
| `mcp-proxy-arbiter-gates-dependent-action` | the MCP-proxy analogue — a synthesized decision holds the poisoned dependent call |

**Read side — the viewer and OTel export:**

| Probe | Pins |
| --- | --- |
| `viewer-is-read-only` | the viewer surfaces the chain + pending approvals but never writes the log |
| `otel-export-respects-sensitivity-ceiling` | content above the ceiling exports as metadata + payload hash only |
| `otel-export-projects-action-spans` | a session projects to the action-centric span tree |

**Native governed adapters** (each drives the real adapter through the real kernel):

| Probe | Pins |
| --- | --- |
| `shell-adapter-enforces-sandbox-invariants` | the shell adapter's TS-level sandbox (no host env, argv-only, timeout, bounded capture) |
| `git-adapter-enforces-egress-invariants` | git transport — L4 push held, remote pinning beats a poisoned `.git/config`, no credential leak |
| `nostr-adapter-enforces-egress-invariants` | nostr — relay pinning, in-process BIP-340 signing, the key never on the wire |
| `http-adapter-enforces-egress-invariants` | http — hostname pinning + per-hop redirect re-validation against SSRF, host-bound credential |
| `messaging-adapter-enforces-egress-invariants` | messaging — destination pinning, operator-fixed sender, no redirect following |
| `filesystem-adapter-enforces-write-invariants` | `fs.write` — held L3 write, root-confined + symlink-checked paths, no host-env expansion, bounded-not-truncated |
| `sql-adapter-enforces-invariants` | sql — the parameterized-only injection boundary, read/mutation trust split, held L3 mutation, bounded cursor fetch (needs Postgres) |
| `vector-retrieval-cannot-auto-promote` | retrieved RAG chunks are `external_document`, so the gate keeps them unverified (Parallax across chunks) |
| `vector-adapter-enforces-invariants` | vector — operator-pinned table + namespace allowlist, parameterized values, top-k cap, `READ ONLY` (needs Postgres) |
| `payment-adapter-enforces-send-invariants` | `payment.send` — L4 hold, operator-pinned payee, amount ceiling + currency allowlist, idempotency key, L5 kill-switch |

**Read side — the session shipper:**

| Probe | Pins |
| --- | --- |
| `ship-respects-sensitivity-ceiling` | above-ceiling beliefs ship redacted (marker + original hash); the bearer token never enters the NDJSON body |
| `ship-wire-roundtrip` | the receiver re-verifies `payload_hash`; redacted records are flagged, not hash-mismatched; the session is lossless at `--sensitivity-ceiling secret` |

**Trust-pack registry** (signed, verifiable pack distribution):

| Probe | Pins |
| --- | --- |
| `pack-manifest-signature-required` | a pack manifest's Ed25519 signature is verified against pinned author keys on load |
| `forged-pack-cannot-load` | every local forgery (wrong key, un-pinned signer, lifted signer, edited-after-signing) is refused |
| `tampered-pack-content-cannot-load` | a per-file content digest catches a probe byte swapped under a still-valid signature |
| `pack-resolves-from-npm` | a pack resolves from a version+SRI-pinned npm package or a full-SHA-pinned git repo, verifying over the fetched bytes |
| `mutable-git-ref-rejected` | a git source must pin an immutable 40-hex SHA; a branch/tag/short-SHA is refused |
| `resolution-runs-no-pack-code` | the non-executing fetch: a tarball `postinstall` / repo `post-checkout` hook never fires before verification |
| `pack-publish-add-roundtrip` | the publish→add flow: sign-in-place + self-verify, then resolve→verify→install→record the immutable pin |
| `unverified-badge-not-trusted` | attestation badges are advisory (verified vs. unverified surfaced), never a gate; verified against a separate attester root |
| `pack-index-signature-required` | a static signed discovery index is verified against pinned index-publisher keys; it advertises but never authorizes |

**Probe-runner containment:**

| Probe | Pins |
| --- | --- |
| `runner-denies-host-env-to-probe` | the runner spawns each probe under a scoped env (fresh HOME + inherited PATH), never the host `process.env` |
| `runner-sandboxes-probe-filesystem-and-network` | each probe runs in an OS sandbox (`sandbox-exec` / `bubblewrap`) confining filesystem + outbound network (needs a sandbox mechanism) |

**Non-MCP runtime adapters** (the shared runtime-gate spine):

| Probe | Pins |
| --- | --- |
| `runtime-gate-enforces-two-phase` | the always-on TS spine — a held L4 stays held until a signed approval resolves it, over the real NDJSON-RPC protocol |
| `langgraph-tool-calls-are-governed` | a real Python LangGraph graph is governed through the shared gate (needs Python + LangGraph) |
| `crewai-tool-calls-are-governed` | a real CrewAI toolset is governed through the same unchanged gate (needs Python + CrewAI) |
| `autogen-tool-calls-are-governed` | a real AutoGen toolset is governed through the same unchanged gate (needs Python + AutoGen) |

**Cognitive-core belief enrichment** (#154):

| Probe | Pins |
| --- | --- |
| `evidence-linker-cross-belief-join` | a claim corroborated by an independent higher-quality belief promotes `unverified → supported`; two `external_document` beliefs still can't promote each other |
| `harvest-projection-surfaces-durable-lessons` | a read-side projection surfaces end-of-run `supported` beliefs as advisory memory candidates; a poisoned/quarantined belief never launders through |
| `reflection-derives-supersession-from-conflict` | the reflection DERIVE rule proposes (never auto-applies) a supersession from two conflicting `supported` beliefs |
| `generic-llm-extractor-stays-unverified` | the opt-in generic LLM extractor mints `model_inference`-quality claims that stay `unverified` (Parallax across LLM inferences) |
| `corroboration-strength-rewards-independent-sources` | a separate additive corroboration scalar rises with independent sources while the gate input stays byte-for-byte unmoved |
| `world-model-withholds-gated-current-state` | a positive-but-gated claim is withheld from the world model, not written-and-flagged |

**Public-API stability:**

| Probe | Pins |
| --- | --- |
| `public-api-surface` | the executable mirror of the public-API ledger — every declared-stable symbol pinned by a compile-time signature assertion + a runtime behavioral check |

**Durable calibration:**

| Probe | Pins |
| --- | --- |
| `calibration-event-is-durable` | a calibration pass records a durable, replayable `calibration.computed@1` event |

## The 4 probes + 3 sentinels in `coding-agent-safety`

| Probe | Pins |
| --- | --- |
| `prompt-injection-cross-tool` | a cross-tool injection doesn't promote |
| `tool-poisoning-cross-session` | provenance survives across two sessions (needs Postgres — see below) |
| `confidence-drift` | miscalibration is flagged per class; synthetic beliefs excluded |
| `poisoned-file-cannot-hijack-feature-work` | a poisoned file can't hijack the feature plan |

| Sentinel | Watches for |
| --- | --- |
| `low-confidence-action` | a high-trust action on a weak belief |
| `suspicious-memory-origin` | an `external_document` belief steering a decision |
| `anomalous-tool-sequence` | a tool sequence that deviates from the task shape |

## Probes that need extra infrastructure

All 79 probes pass under strict TypeScript. Seven need extra infrastructure and
**skip with a loud banner** (exit 0) when it is unavailable, so `bun run
probes:ci` stays green on a bare checkout; CI provides all of them:

- **Postgres** (via `LODESTAR_TEST_DATABASE_URL`, run against a `postgres:16` /
  `pgvector` service): `tool-poisoning-cross-session` (the Postgres-backed belief
  store across two sessions), `sql-adapter-enforces-invariants`, and
  `vector-adapter-enforces-invariants`.
- **An OS sandbox mechanism** (`sandbox-exec` on macOS / `bubblewrap` on Linux):
  `runner-sandboxes-probe-filesystem-and-network`.
- **A Python runtime + framework**: `langgraph-tool-calls-are-governed` (Python +
  LangGraph), `crewai-tool-calls-are-governed` (Python + CrewAI), and
  `autogen-tool-calls-are-governed` (Python + AutoGen).

## Related

- [Sentinels and calibration](../concepts/sentinels-and-calibration.md) — what
  sentinels and the calibrator do at runtime.
- [CLI reference](cli.md) — `lodestar probe` and `lodestar harness run`.
- [Get started](../guides/get-started.md#run-the-safety-probes) — run the suite.
