---
title: "Probe packs"
description: "The lodestar.probe-pack.json manifest format, the loader, and the full list of 22 probes and 3 sentinels across the two first-party packs."
---

# Probe packs

A **probe pack** bundles adversarial probes (and optionally runtime sentinels)
behind a manifest so the [harness](../concepts/sentinels-and-calibration.md) can
load and run them as a unit. Probes are Lodestar's executable spec — *not* test
scaffolding. They are not edited to match changed code; the code is expected to keep
satisfying them.

The two first-party packs live in `packs/`:

- **`lodestar-core`** — the core epistemic-chain, memory-firewall, guard, and
  event-log invariants (18 probes).
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

## The 18 probes in `lodestar-core`

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

## The Postgres-backed probe

All 22 probes pass under strict TypeScript. One —
**`tool-poisoning-cross-session`** — exercises the Postgres-backed belief store
across two sessions, so it reads `LODESTAR_TEST_DATABASE_URL` and **skips with a
loud banner** (exit 0) when that variable is unset. CI runs it for real against a
`postgres:16` service.

## Related

- [Sentinels and calibration](../concepts/sentinels-and-calibration.md) — what
  sentinels and the calibrator do at runtime.
- [CLI reference](cli.md) — `lodestar probe` and `lodestar harness run`.
- [Get started](../guides/get-started.md#run-the-safety-probes) — run the suite.
