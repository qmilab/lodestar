# ADR-0028: PyPI trusted publishing for the runtime hooks + `lodestar-runtime-client` graduation

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Nandan, Claude
- **Related:** ADR-0024 (the runtime-adapter seam + the RPC client this extracts),
  ADR-0025 (runtime-core gate), ADR-0026 §3 (named the third hook as the
  graduation trigger), ADR-0027 §4 (deferred the graduation to here), epic #75,
  issue #128, `runtimes/runtime-client/`, `runtimes/langgraph/`,
  `runtimes/crewai/`, `runtimes/autogen/`, `.github/workflows/publish-pypi.yml`,
  `.github/workflows/publish.yml` (the npm analogue this mirrors)

## Context

Epic #75 shipped three Python runtime hooks — `lodestar-langgraph` (#83,
ADR-0024), `lodestar-crewai` (#84, ADR-0026), `lodestar-autogen` (#85, ADR-0027) —
each a thin native binding on the shared TypeScript governance gate
(`@qmilab/lodestar-runtime-core`). Two facts were left open by design, both routed
to this slice (#128), to be settled once against the now-settled three-hook set:

1. **Publishing.** None of the hooks is auto-published. `publish.yml` fires on
   `v*` tags and already grants OIDC (`id-token: write`) for npm trusted
   publishing, but contains **zero Python**. The hooks ship manually or not at all.
2. **The duplicated client.** Each hook vendors a byte-identical
   `client.py` — the pure-stdlib NDJSON-RPC `GateClient` that spawns the gate and
   remotes tool calls — differing only in one docstring sentence. ADR-0026 §3 named
   the **third** hook as the trigger to decide whether to extract a shared
   `lodestar-runtime-client` PyPI package; ADR-0027 §4 deferred that extraction to
   #128 precisely because its shape is coupled to the publish workflow (a shared
   client must publish **before** its dependents — a publish-ordering constraint
   that only exists once there is a workflow).

Both are now decidable against a fixed package set, so this ADR settles them
together. The guiding constraint throughout: **mirror the npm machinery** rather
than invent a parallel Python idiom — the repo already runs a lockstep, tag-driven,
OIDC, maintainer-gated monorepo release, and the Python side should read as the
same release with more packages, not a second release with its own rules.

## Decision

### 1. Graduate the shared client to `lodestar-runtime-client` (4th package)

Extract the three verbatim copies into a new pure-stdlib package
`runtimes/runtime-client/` (`lodestar_runtime_client`), exporting `GateClient`,
`GateError`, `ToolBody`. The graduated `client.py` is **byte-identical below the
docstring** to the three copies (verified by `diff`); only the docstring is
rewritten framework-neutral. Each hook then:

- drops its local `client.py`,
- repoints its two internal imports (`adapter.py`, `__init__.py`) from
  `.client` to `lodestar_runtime_client`,
- adds `dependencies = ["lodestar-runtime-client==<version>"]`.

The graduation is **purely internal**: every hook's public surface
(`from lodestar_langgraph import GateClient, GateError, govern_tools,
governed_call, LodestarDenied`) is unchanged because `__init__.py` re-exports, so
no consumer code or README example changes. We chose **graduate** over
keep-duplicated (ADR-0027 §4 left both live) because the third copy made the drift
risk real and the publish-ordering cost is now a one-time, mechanically-verified
workflow edge rather than an open-ended worry.

**Exact-version pin (`==`), in lockstep.** The hooks pin the client exactly, not a
floor (`>=`), mirroring npm's exact-pin lockstep rationale (`workspace:*` → exact
pin at publish): version N of a hook was tested against version N of the client,
and we do not want install-time drift to an untested client patch. The cost — the
pin must move with every release — is covered by the guard (decision 3).

### 2. PyPI trusted publishing, piggybacked on the `v*` tag (lockstep cadence)

A new workflow `.github/workflows/publish-pypi.yml` fires on the **same `v*` tag**
as the npm release — one version line across the whole repo, every package
(npm + Python) bumped together at release. We chose this over a separate `py-v*`
tag (independent cadence) to match the repo's existing lockstep-monorepo
philosophy and keep one mental model; the accepted cost is that a Python-hook-only
fix waits for (or forces) a repo-wide version bump. Publishing uses
`pypa/gh-action-pypi-publish@release/v1` over OIDC (`id-token: write`, no
long-lived tokens), with `skip-existing: true` for idempotent re-runs — the PyPI
analogue of `publish.yml`'s `npm view` live-skip.

A **new workflow file** (not a job bolted onto `publish.yml`) was chosen so the
working npm release path is untouched, and because a PyPI trusted publisher binds
to one workflow *filename* — all four projects reference `publish-pypi.yml`.

**Maintainer gate.** The publish jobs run in a GitHub `environment: pypi`, the
PyPI analogue of npm's `environment: production` staged-and-approved gate; the
trusted-publisher rule is scoped to that environment.

### 3. Manual version bumps with a tag-match guard (mirrors npm)

Versions stay hardcoded in each `pyproject.toml` + `__init__.py` (no `hatch-vcs`
tag derivation — the npm side hardcodes too, and explicit beats magic here). A
`guard` job fails the release **before any build/publish** unless, for all four
packages: `pyproject` version == tag, `__init__.__version__` == tag, and (for the
three hooks) the `lodestar-runtime-client==` pin == tag. This is the direct
analogue of `publish.yml`'s "Verify package versions match the release tag" +
"Verify no workspace: strings remain" steps, extended to cover the internal pin.

### 4. Publish order: client first, then the hooks (matrix)

`guard` → `publish-client` → `publish-hooks` (a `langgraph`/`crewai`/`autogen`
matrix, `needs: publish-client`). The client publishes first because the hooks pin
it exactly; a hook landing on PyPI before its client would point at a version that
does not yet exist. This is the Python analogue of `publish.yml`'s `PUBLISH_ORDER`.
There is no *build*-time dependency (hatchling just packages files), so ordering is
a consumer-consistency guarantee, not a build requirement.

### 5. CI installs the local client first

The three `*-runtime` CI jobs install the shared client from its **local path
first**, then the hook (`pip install ./runtimes/runtime-client
"./runtimes/<hook>[<hook>]"`), because the hook's `==<version>` pin is not yet on
PyPI in those jobs. The e2e tests' no-install source fallback adds
`runtimes/runtime-client` to `sys.path` alongside the hook dir for the same reason,
so a local run with nothing installed still resolves the client (and still skips
loudly when the framework itself is absent).

### 6. First-publish bootstrap (one-time, manual, operator-only)

Before the first release tag, register a PyPI **pending publisher** at
`pypi.org/manage/account/publishing/` for each of the four projects
(`lodestar-runtime-client`, `lodestar-langgraph`, `lodestar-crewai`,
`lodestar-autogen`) with Owner `qmilab`, Repository `lodestar`, Workflow
`publish-pypi.yml`, Environment `pypi`. The first run then creates the project.
This is the PyPI analogue of the npm new-name trusted-publisher bootstrap and is
the **only** step CI cannot perform — it is documented in the workflow header.

## Consequences

- **One verbatim copy now, governed by a workflow, instead of three watched by
  `diff`.** The deferred-from-ADR-0027 graduation is paid off; the drift surface is
  gone. Adding a fourth framework hook is now "depend on the client," not "copy the
  client."
- **One repo-wide version line.** A `v*` tag releases npm **and** PyPI in lockstep;
  the guard makes a half-aligned release impossible (it red-fails before any
  upload). The release runbook gains four Python version strings + three pins to
  bump alongside the npm `package.json` set — all checked by the guard.
- **No new long-lived secrets.** PyPI publishing is OIDC trusted publishing,
  consistent with npm; the only manual step is the one-time pending-publisher
  registration per project.
- **Honest boundary, unchanged.** The graduated client is the same pure-stdlib
  process-spawning RPC client; this slice is packaging and release plumbing, with
  no change to the gate, the protocol, or any enforcement behavior.

## Alternatives considered

- **Keep the client vendored (3 standalone packages, no publish ordering).**
  Rejected: ADR-0026/0027 explicitly scheduled the graduation for here, and the
  third copy made drift a live risk; the publish-ordering cost is a single,
  guard-checked workflow edge.
- **Separate `py-v*` tag (independent Python cadence).** Rejected for lockstep
  `v*`: it adds a second version line and tag convention for marginal benefit while
  the hooks still move with the core; revisit only if the Python hooks start
  releasing on a genuinely independent schedule.
- **Tag-derived versions via `hatch-vcs`.** Rejected: the npm side hardcodes
  versions with a tag guard, and matching that keeps one release model; `hatch-vcs`
  would introduce a Python-only mechanism for no gain.
- **Floor pin (`lodestar-runtime-client>=<version>`).** Rejected for `==`: lockstep
  exact pins match npm and prevent install-time drift onto an untested client; the
  bump cost is covered by the guard.
- **One PyPI job appended to `publish.yml`.** Rejected: a separate file keeps the
  proven npm path untouched and gives the four PyPI trusted publishers a single,
  stable workflow filename to bind to.
