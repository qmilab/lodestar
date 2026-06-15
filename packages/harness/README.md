# @qmilab/lodestar-harness

The Lodestar Harness. Probe packs, sentinels, and calibrators that
exercise and audit the epistemic chain — the surface that turns
"a folder of probe scripts" into something external authors can package
and share.

Batch 4 lands the harness incrementally, and is now complete. What ships
is the **probe-pack format and loader**, the **`Probe` authoring
surface**, the **pack runner**, the **`lodestar harness run` CLI**, the
**`Sentinel` surface** (base class, runner, three first-party sentinels),
the **`Calibrator`** (per-class ECE / Brier / calibration-gap tables), and
the **sentinels folded into an installable pack** — a manifest declares
them by id and the loader resolves them against a first-party registry.

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
- `source_type` is `"local"`, `"npm"`, or `"git"` — the pack's self-declared
  distribution channel. `loadProbePack(path)` loads bytes already on disk
  regardless of `source_type`; `loadProbePackFromSource(ref)` resolves a pinned
  `PackSourceRef` (an exact npm version + SRI integrity, or a full git commit
  SHA) to a confined directory via a **non-executing fetch** (no `npm install`,
  no git hooks) and then loads + verifies it — see "Source resolution" below.
- `coverage_areas` and `invariants` are free-form taxonomy tags. They are
  not validated against a closed list; they drive grouping and the
  "which pack exercises invariant X?" question, not gating.

A pack may also declare **sentinels** — online watchers over the live
event stream, distinct from offline probes:

```json
{
  "probes": [{ "name": "prompt-injection-cross-tool", "file": "probes/prompt-injection-cross-tool.ts" }],
  "sentinels": [
    { "id": "low-confidence-action" },
    { "id": "suspicious-memory-origin" },
    { "id": "anomalous-tool-sequence" }
  ]
}
```

A probe is a `bun run`-able script the pack carries as a `file`; a
sentinel is a stateful in-process class the harness instantiates, so it is
referenced by a stable `id` and resolved against the built-in registry
(`FIRST_PARTY_SENTINELS`). The `sentinels` field is optional and additive
under spec `"1"` — a manifest without it still loads. Per-pack
construction-option overrides and third-party (file-referenced) sentinels
are a later refinement; v0 resolves first-party ids only.

## Signed manifests (verify-on-load)

A pack manifest is the registry trust root. An author signs it with an Ed25519
key; the consumer pins the trusted author keys and the loader verifies the
signature **on load** (ADR-0017). A signed manifest carries three additive
fields:

```json
{
  "author_id": "acme-packs",
  "content_digest": {
    "algorithm": "sha256",
    "files": [{ "path": "probes/p.ts", "sha256": "…64 hex…" }]
  },
  "signature": { "signer_id": "acme-packs", "payload_hash": "…", "algorithm": "ed25519", "signature": "…", "at": "…" }
}
```

The signature covers the canonical manifest (every field except `signature`), so
it binds `content_digest` too — and the loader recomputes that per-file digest
over the resolved probe files, rejecting a swapped byte **even under a valid
signature** (the re-pointed-tag / re-published-artifact hole). Pass the pinned
keys via `loadProbePack(target, { authorizedAuthorKeys })`. An *unsigned* manifest
is rejected unless you pass `{ allowUnsigned: true }` — the explicit opt-out for
trusted first-party in-repo packs / local dev (no silent default). The fields are
additive since spec `"1"`; producing the signature over frozen files is the
publish CLI's job (#90).

## Library

```ts
import { loadProbePack, ProbePackError } from "@qmilab/lodestar-harness"

try {
  // A signed external pack: pin the author's public key.
  const pack = await loadProbePack("./packs/acme", {
    authorizedAuthorKeys: [{ actor_id: "acme-packs", public_key: PINNED_SPKI_PEM }],
  })
  // A trusted first-party in-repo pack that ships unsigned: opt out explicitly.
  // const pack = await loadProbePack("./packs/lodestar-core", { allowUnsigned: true })
  // pack.manifest — the validated manifest
  // pack.root — absolute pack directory
  // pack.probes — [{ name, file, path }], each path absolute and verified
  // pack.sentinels — [{ id, create }], each resolved to its factory;
  //   const runner = new SentinelRunner(pack.sentinels.map((s) => s.create()))
} catch (err) {
  if (err instanceof ProbePackError) {
    // a broken or untrusted pack: missing manifest, bad JSON, schema violation,
    // unsupported source_type, escaping or missing probe file, dup name, an
    // unknown / duplicated sentinel id, or a verify-on-load failure (unsigned
    // without allowUnsigned, tampered manifest, un-pinned / wrong signer,
    // bad signature, or a content-digest mismatch)
  }
  throw err
}
```

`loadProbePack` validates the manifest, verifies its signature against the pinned
author keys (or accepts it unsigned under `allowUnsigned`), resolves every probe
file to an absolute path, verifies each exists and lives inside the pack root,
and — for a signed pack — recomputes the content digest over those files. It does
**not** run probes — execution is the runner's job.

## Source resolution (npm / git)

To load a pack that ships as a published artifact rather than a local directory,
give `loadProbePackFromSource` a pinned, immutable source descriptor. It fetches
to a confined directory via a **non-executing fetch** — no `npm install` lifecycle
scripts, no git hooks run — then delegates to `loadProbePack`, so the signature +
content-digest verify-on-load applies to the fetched bytes.

```ts
import { loadProbePackFromSource } from "@qmilab/lodestar-harness"

// npm: pinned to an exact version + SRI integrity (the registry's advertised
// hash and the downloaded bytes must both match the pin).
const fromNpm = await loadProbePackFromSource(
  { type: "npm", package: "@acme/probes", version: "1.4.2", integrity: "sha512-…" },
  { authorizedAuthorKeys: pinned },
)

// git: pinned to a full 40-hex commit SHA (a branch/tag is rejected).
const fromGit = await loadProbePackFromSource(
  { type: "git", url: "https://github.com/acme/probes.git", commit: "<40-hex SHA>" },
  { authorizedAuthorKeys: pinned },
)

// The loaded pack records the exact pin it resolved:
fromNpm.source?.ref // { type: "npm", version, integrity, … }
```

A swapped artifact under a re-pointed ref fails the content-digest check even if
the old signature still verifies. Resolution delivers *authentic, inert bytes*;
sandboxing what a probe does **when run** is a separate, runner-side concern.

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

## Sentinels

A sentinel is an online tripwire over the event stream — the opposite of a
probe (an offline adversarial test). It is fed events one at a time, watches
for a suspicious shape, and emits a `sentinel.alerted@1` event. Sentinels are
**non-blocking**: they alert, they never stop an action mid-flight. Design
lock: `docs/architecture/sentinels.md`.

```ts
import {
  SentinelRunner,
  LowConfidenceActionSentinel,
  SuspiciousMemoryOriginSentinel,
  AnomalousToolSequenceSentinel,
  eventLogAlertSink,
} from "@qmilab/lodestar-harness"

const runner = new SentinelRunner(
  [
    new LowConfidenceActionSentinel(),
    new SuspiciousMemoryOriginSentinel(),
    new AnomalousToolSequenceSentinel(),
  ],
  // Optional sink — append each alert to the event log as a
  // `sentinel.alerted@1` event, in the triggering event's session slice.
  { sink: eventLogAlertSink({ root: ".lodestar/events" }) },
)

// Live tail: push each event as it lands.
const alerts = await runner.observe(event)
// Or replay an ordered batch:
const all = await runner.sweep(await new EventLogReader(root).readSession(p, s))
```

The three first-party sentinels:

- **`LowConfidenceActionSentinel`** — flags an action at `required_level ≥ 3`
  whose backing belief sits below the confidence floor (default 0.5) or is
  `unverified`.
- **`SuspiciousMemoryOriginSentinel`** — flags a decision that depends on a
  belief whose supporting evidence includes `external_document` content
  (highest poisoning risk). One alert per offending belief.
- **`AnomalousToolSequenceSentinel`** — flags a session whose executed tools
  match a known-suspicious ordered sequence; ships the `read → external-egress
  → write` exfiltration pattern by default. Configurable via `sequences` /
  `watchPhases` / `windowSize`.

A pack declares the sentinels it ships under `sentinels` (by id); the loader
resolves each against the first-party registry, so a host can build a runner
straight from a loaded pack rather than naming the classes by hand:

```ts
const pack = await loadProbePack("./packs/coding-agent-safety")
const runner = new SentinelRunner(pack.sentinels.map((s) => s.create()))
```

To author your own, subclass `Sentinel` (or return a `SentinelFinding[]` from
`inspect`). The runner stamps the alert id, timestamp, and routing.

## Calibrator

The calibrator is an offline read over the event log that asks: *when the
agent said it was p confident, was it right p of the time?* It pairs each
belief's stated `confidence` against the outcome the world later revealed,
groups by `calibration_class`, and returns per-class ECE / Brier /
calibration-gap tables — flagging a class that is materially miscalibrated.
It **measures, it does not enforce**: acting on a flag (downweighting an
overconfident class) is the Policy Kernel's job. Design lock:
`docs/architecture/calibrator.md`.

```ts
import { calibrate, formatCalibrationReport } from "@qmilab/lodestar-harness"
import { EventLogReader } from "@qmilab/lodestar-event-log"

const events = await new EventLogReader(root).readSession(project, session)
const report = calibrate(events)
// report.classes[]   — per-class { metrics, reliability_bins, flagged, flag_reason }
// report.overall     — pooled ECE / Brier / gap
// report.flagged_classes[]

console.log(formatCalibrationReport(report, { title: "Session calibration" }))
```

Two outcome signals feed it, each toggleable via `outcomeSources`: an
**action outcome** (a belief → decision → action chain's terminal phase, or
an explicit `Outcome` event) and a **`truth_status` transition** (the
firewall adjudicating the belief). A class is flagged only with
`n ≥ minSamples` *and* ECE or |gap| over threshold — the `minSamples` guard
keeps thin data from raising a false alarm. `authority: "synthetic"` beliefs
are excluded by default so probe artefacts never pollute a real class.

The pure math (`brierScore`, `expectedCalibrationError`, `reliabilityBins`,
`computeMetrics`) is exported too, for callers that already hold
`(confidence, correct)` points.

## What it does not do (yet)

- Resolve `source_type: "npm"` packs.
- Emit a `calibration.computed@1` event or expose a `lodestar harness
  calibrate` CLI — the calibrator is a library return-value surface in v0;
  both graduate when the Policy Kernel consumes calibration verdicts.
- *Consume* sentinel alerts in the Action Kernel's `arbitrate` step — alerts
  are audit signal until the Policy Kernel lands the (additive) hook.
- Persist sentinel state across sessions (in-memory for now).
- Bundle the three sentinels into an installable pack (the manifest declares
  probes today, not sentinels).
