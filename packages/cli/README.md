# @qmilab/lodestar-cli

The `lodestar` command-line interface.

## Commands

### `lodestar report <session-id>` — headline command

Render a markdown trust report for a session. Resolves the project
directory under the log root automatically; pass `--project` to
disambiguate when multiple projects share a session id.

```sh
lodestar report session-1779551238212
lodestar report session-1779551238212 --out trust.md
lodestar report session-1779551238212 --raw-events 25
```

### `lodestar otel export <session-id>` — OpenTelemetry bridge

Project a session's event log into OpenTelemetry GenAI spans and emit them
as OTLP/HTTP JSON, so the epistemic chain shows up in Langfuse, Phoenix,
Jaeger, or Tempo. With `--endpoint`, the trace is POSTed to a collector;
with `--out`, it is written to a file; with neither (or `--stdout`), it is
printed to stdout — a dry run that needs no collector. Content above
`--sensitivity-ceiling` (default `internal`) is withheld: the span ships
with structural metadata and the payload hash only.

```sh
lodestar otel export session-1779551238212 --stdout
lodestar otel export session-1779551238212 --endpoint http://localhost:4318
lodestar otel export session-1779551238212 \
  --sensitivity-ceiling confidential \
  --header "authorization=Bearer $TOKEN" --out trace.json
```

### `lodestar guard wrap --target <module>` — programmatic surface

Import a TS module that default-exports an `AgentLoop` and run it
under a guarded session. The CLI prints the session id so you can
immediately render the report.

```sh
lodestar guard wrap --target ./my-agent.ts --actor alice
lodestar report <session-id>
```

The target module must `export default` an `async (ctx) => Promise<T>`
function. It is responsible for registering any tools it needs.

### `lodestar action list` / `lodestar action describe <action-id>`

Introspect the registered tool catalogue. `fs.read` and `git.status`
are registered automatically against the current working directory so
the catalogue is non-empty without launching a session.

```sh
lodestar action list
lodestar action describe fs.read
```

### `lodestar trace inspect <event-id>` — debug

Look up a single event envelope by id. Debug-grade output (raw JSON);
prefer `lodestar report` for anything user-facing.

```sh
lodestar trace inspect <event-id>
lodestar trace inspect <event-id> --session session-... --project my-proj
```

### `lodestar probe <name>`

Run one of the probes in `packs/lodestar-core/probes/`. Probes are spec,
not test scaffolding — when they fail, the change is wrong, not the
probe.

```sh
lodestar probe poison
lodestar probe guard-import
```

### `lodestar harness run` / `lodestar harness list`

Drive a whole probe pack instead of a single probe. `run` executes every
probe in the pack and prints an aggregate summary (a failing probe does
not abort the run); `list` inspects the pack's manifest without executing
anything. By default `run` records each probe run as a synthetic
observation in the event log so the run is itself auditable via
`lodestar report`.

```sh
lodestar harness run                       # the first-party lodestar-core pack
lodestar harness run --pack ./packs/mine   # a local pack directory
lodestar harness run --no-record           # skip event-log recording (CI)
lodestar harness run --pack ./packs/mine --allow-unsigned   # load an unsigned local pack
lodestar harness run --pack ./packs/acme \
  --author-key acme-packs=./keys/acme.pub  # load a signed pack, author key pinned
lodestar harness list
```

`run` exits non-zero if any probe fails, so it works as a CI gate.

A pack manifest is verified on load (ADR-0017). A **bundled first-party** pack
(`lodestar-core` / `coding-agent-safety`), when the CLI runs from its own source
tree, ships unsigned and loads automatically. Every other case — a `--pack
<path>`, an arbitrarily-named bare pack, or *any* bare pack when the CLI is
installed under a project's `node_modules` (where a name could otherwise collide
with the project's own `./packs/<name>`) — must either:

- carry a valid Ed25519 author signature whose author you pin with `--author-key
  <author-id>=<spki-pem-file>` (repeatable), or
- be loaded with `--allow-unsigned` (the explicit opt-out — no silent default).

Trust keys off the resolved location, not the argument syntax, so an unsigned
local `packs/acme` cannot masquerade as first-party. A signed pack is always fully
verified against the pinned keys, and a content-digest mismatch (probe bytes
swapped under a still-valid signature) is rejected.

### `lodestar harness calibrate <session-id>`

Score a session's stated belief confidence against realised outcome per
`calibration_class` (ECE / Brier / calibration-gap, flagged classes), print
the markdown report, and — unless `--no-emit` — record the verdict as a
durable `calibration.computed@1` governed event so calibration drift is
auditable and replayable. The calibrator only measures; emitting the event is
this separate publish step (ADR-0011). The recorded `cursor` is a replay key:
re-running over the same window reproduces the verdict.

```sh
lodestar harness calibrate session-1779551238212               # print + record
lodestar harness calibrate session-… --no-emit                 # preview only
lodestar harness calibrate session-… --out calibration.md      # also write md
```

### `lodestar pack keygen` / `publish` / `attest` / `add` / `search` / `index-sign`

The trust-pack author + consumer + attestation + discovery flow
(ADR-0019 / ADR-0020 / ADR-0021).
`keygen` mints an Ed25519 keypair for one role — `--author` (signs manifests),
`--attester` (signs badges), or `--index` (signs discovery indexes) — private key
written 0600, never on argv. `publish`
freezes a pack's probe files, computes a content digest over them, signs the
manifest in place, and self-verifies (the signing key comes from `--key` or
`LODESTAR_AUTHOR_KEY`, never argv). `attest` issues a locally-verifiable signed
**badge** into the pack's `badges/` directory — a `probe_results` summary of a real
run, or a `security_scan` verdict from `--scan <file>` — bound to the pack's
manifest hash (the attester key comes from `--key` or `LODESTAR_ATTESTER_KEY`).
`add` resolves a **pinned** source via a non-executing fetch — no `npm install`
lifecycle script or git hook runs — and verifies the signature + content digest
against operator-pinned author keys **before any pack code could run**, then
installs the verified bytes, records the immutable pin in a lockfile, and
**surfaces** the pack's badges verified against pinned **attester** keys. An
unsigned or content-mismatched pack is rejected unless `--allow-unsigned` is
explicit; badges are advisory and never gate the add.

`search` / `list` are the read-side **discovery** surface: fetch one or more pinned
static discovery indexes (`--index <source>`: a path, `file:`, or https URL), verify
each against pinned **index-publisher** keys (`--index-key` + the config's
`index_publisher_keys`; fail closed unless `--allow-unsigned-index`), and filter the
listings locally by `--coverage` / `--invariant` / a text arg (`--json` for raw
hits). An index **advertises but never authorizes** — choosing a listed pack still
routes through `pack add` (re-verified against your pinned author keys) before
anything installs, so a hostile or tampered index can mis-list or omit but never make
a forged pack verify. A single bad index is skipped, not fatal. `index-sign` is the
thin publisher side: sign an authored index file in place + self-verify.

```sh
lodestar pack keygen --author acme --out acme-author            # mint an author keypair
lodestar pack keygen --attester acme-ci --out acme-ci           # mint an attester keypair
lodestar pack keygen --index acme-index --out acme-index        # mint an index-publisher keypair
lodestar pack publish --pack ./packs/mine --author acme --key acme-author.key
lodestar pack attest  --pack ./packs/mine --kind probe_results \
  --attester acme-ci --key acme-ci.key --author-key acme=acme-author.pub   # run + sign a badge
lodestar pack add npm:@acme/safety-pack@1.2.0 \
  --integrity sha512-… --author-key acme=acme-author.pub \
  --attester-key acme-ci=acme-ci.pub                            # pinned + verified, badges surfaced
lodestar pack add git:https://github.com/acme/packs.git#<40-hex-sha> \
  --author-key acme=acme-author.pub
lodestar pack add local:./packs/mine --author-key acme=acme-author.pub
lodestar pack index-sign --index-file ./pack-index.json \
  --publisher acme-index --key acme-index.key                   # sign an authored discovery index
lodestar pack search --index https://acme.example/pack-index.json \
  --index-key acme-index=acme-index.pub --coverage egress       # verify + filter listings locally
```

Consumers pin author keys (and, separately, attester keys, and index-publisher keys)
in `.lodestar/pack-trust.json` (or `--trust-config`), the same shape as the proxy's
`approvals.authorized_keys`. The recorded pins live in `.lodestar/packs.lock.json`.

## Exit codes

- `0` — success
- `1` — operational failure (loop threw, event-log write failed, …)
- `2` — usage error
- `3` — resource not found (no events for session, no event with id, …)
