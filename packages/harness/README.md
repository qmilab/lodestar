# @qmilab/lodestar-harness

The Lodestar Harness. Probe packs, sentinels, and calibrators that
exercise and audit the epistemic chain — the surface that turns
"a folder of probe scripts" into something external authors can package
and share.

Batch 4 lands the harness incrementally. What ships today is the
**probe-pack format and loader**. The `Probe` base class, the runner,
and the `lodestar harness run` CLI follow.

## Probe pack format

A probe pack is a directory (or, later, a published npm package) with a
`lodestar.probe-pack.json` manifest at its root:

```json
{
  "name": "lodestar-core",
  "version": "0.2.0",
  "spec_version": "1",
  "source_type": "local",
  "description": "Core firewall, gate, and guard-contract invariants.",
  "coverage_areas": ["memory_firewall", "auto_observation_gate", "guard_contract"],
  "invariants": ["no_self_promotion", "parallax", "retrieval_gates"],
  "probes": [
    { "name": "memory-poisoning-basic", "file": "probes/memory-poisoning-basic.ts" },
    { "name": "auto-observation-gate", "file": "probes/auto-observation-gate.ts" }
  ]
}
```

The manifest is the contract every pack — first-party and external — is
written against. It is declarative: it names probes and their files but
carries no executable logic. The schema lives in `@qmilab/lodestar-core`
(`ProbePackManifestSchema`); the loader here resolves it.

- `spec_version` is the version of the manifest *format*. The v0 loader
  understands `"1"` only and rejects anything else with a clear error
  rather than guessing.
- `source_type` is `"local"` or `"npm"`. Both are in the schema from day
  one so external authors can target a stable format, but the v0 loader
  resolves `"local"` only. `"npm"` resolution follows the first external
  pack that needs it.
- `coverage_areas` and `invariants` are free-form taxonomy tags. They are
  not validated against a closed list; they drive grouping and the
  "which pack exercises invariant X?" question, not gating.

## Library

```ts
import { loadProbePack, ProbePackError } from "@qmilab/lodestar-harness"

try {
  const pack = await loadProbePack("./packs/lodestar-core")
  // pack.manifest — the validated manifest
  // pack.root — absolute pack directory
  // pack.probes — [{ name, file, path }], each path absolute and verified
} catch (err) {
  if (err instanceof ProbePackError) {
    // a broken pack: missing manifest, bad JSON, schema violation,
    // unsupported source_type, escaping or missing probe file, dup name
  }
  throw err
}
```

`loadProbePack` validates the manifest, resolves every probe file to an
absolute path, and verifies each one exists and lives inside the pack
root. It does **not** run probes — execution is the runner's job.

## What it does not do (yet)

- Run probes (`Probe` base class + runner — next step).
- The `lodestar harness run --pack <name>` CLI (registered under the
  existing `lodestar` binary, not a new bin).
- Resolve `source_type: "npm"` packs.
- Sentinels and calibrators.
