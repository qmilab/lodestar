# @qmilab/lodestar-harness

The Lodestar Harness. Probe packs, sentinels, and calibrators that
exercise and audit the epistemic chain — the surface that turns
"a folder of probe scripts" into something external authors can package
and share.

Batch 4 lands the harness incrementally. What ships today is the
**probe-pack format and loader**, the **`Probe` authoring surface**, the
**pack runner**, and the **`lodestar harness run` CLI**. Sentinels and
the calibrator follow.

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

## Running a pack

```ts
import { eventLogRecorder, loadProbePack, runPack } from "@qmilab/lodestar-harness"

const pack = await loadProbePack("./packs/lodestar-core")
const result = await runPack(pack, {
  // Optional: record each run as a synthetic observation in the event log
  record: eventLogRecorder({
    root: ".lodestar/events",
    project_id: "harness",
    session_id: "harness-run-1",
    actor_id: "lodestar-harness",
  }),
})
// result.ok, result.passed, result.failed, result.outcomes[]
```

The runner is a **subprocess driver**: each probe is run as `bun run
<file>` and its exit code is the verdict (0 passes, anything else
fails). This is why the first-party probes are plain scripts and stay
that way — probes are spec, not scaffolding. A failing probe does not
abort the run; every probe executes so you see the full picture.

When a `record` sink is supplied, every probe run is written as a
`trust: "synthetic"` `observation.recorded` event (schema
`harness.probe_run@1`) so the run is itself auditable through
`lodestar report`.

From the CLI:

```
lodestar harness run  [--pack <name|path>] [--log-root <path>] [--no-record]
lodestar harness list [--pack <name|path>]
```

`--pack` accepts a first-party pack name (e.g. `lodestar-core`, the
default), a pack directory, or a manifest file. `run` executes the pack
and records runs by default; `list` inspects the manifest without
executing anything.

## Authoring a new probe

The first-party probes predate the `Probe` surface and are intentionally
left as standalone scripts. New probes can declare themselves once and
get the banner-and-exit-code contract for free:

```ts
import { type ProbeSpec, runProbeAsScript } from "@qmilab/lodestar-harness"

const probe: ProbeSpec = {
  name: "my-probe",
  description: "What invariant this defends and the attack it models.",
  async run() {
    // ...assertions...
    return { passed: true, details: ["checked X", "checked Y"] }
  },
}

await runProbeAsScript(probe) // prints the banner, exits 0 / 1
```

## What it does not do (yet)

- Resolve `source_type: "npm"` packs.
- Sentinels and the calibrator.
