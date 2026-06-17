# ADR-0022: Probe-runner scoped-env execution — the safe-to-run prerequisite

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Nandan, Claude
- **Related:** #114 (this ADR), epic #76 (registry, the *orthogonal sibling* — runner-side,
  not a registry child), #91 (registry threat model),
  `docs/concepts/threat-model/registry-supply-chain.md` §"what we don't defend against",
  ADR-0016 (registry architecture), ADR-0004 (shell adapter's "TS-level governance
  boundary, not an OS sandbox"), ADR-0006/0018 (the scoped-env discipline this mirrors —
  `baseGitEnv`, `spawnCaptured`), `packages/harness/src/runner.ts`,
  `packs/lodestar-core/probes/runner-denies-host-env-to-probe.ts`

## Context

The registry epic's six children (#88 → #86 → #90 → #89 → #87) build a complete
signing/verification chain: an operator pins author keys, and only **authentic,
content-bound bytes** reach the harness runner. That chain governs *which bytes you
trust*. It says nothing about *what those bytes do once a probe runs*.

A pack's probes are executable code. The threat model (#91) named this honestly as the
seventh work item the registry surfaces but does not itself close — a **runner-side
gap**, not a registry one:

> **Malicious probe at run time** — A pack whose probe, when *run*, reads host secrets
> out of `process.env` or escapes. Not yet held — registry verification only gets
> *trusted bytes* to the runner; what those bytes do when executed is the runner's job.

Confirmed in code: `runner.ts` spawned `bun run <probe>` with **no `env` option**, so
each probe inherited the parent's full `process.env` — host secrets (API keys, cloud
credentials, tokens) included. This is fine for the first-party `lodestar-core` pack we
wrote; it is **not** a safe execution surface for an external pack, even one whose
signature and content digest verify. Until it is closed, the operator guidance is: *do
not run probes from a pack you do not trust the author of.*

Every other subprocess boundary in Lodestar already solved this: the Action Kernel's "no
host env to sandboxes" rule, the shell adapter's `defaultScopedEnv` (ADR-0004), the git
adapter's `baseGitEnv` (ADR-0006), and the pack-source resolver's `spawnCaptured`
(ADR-0018) all spawn with an explicit scoped env, never the host's. The probe runner was
the one subprocess path that had not.

The threat-model doc scopes the fix in two steps, and this ADR takes **step 1 — the
unblocking step**:

1. **Scoped-env execution.** Deny host `process.env`; the allowed env is explicit and
   declared.
2. **OS sandbox** (filesystem/network containment) — a separate, longer-term step, filed
   when step 1 lands.

## Decision

**1. The runner spawns every probe with an explicit, minimal scoped env — never the host
`process.env`.** The default is a fresh empty `HOME` (so a probe reads no host dotfiles
or per-user credential stores) plus inherited `PATH` (so `bun`, and anything a probe
shells to, resolves). Nothing else passes through. This is exactly `baseGitEnv` /
`defaultScopedEnv` restated for the runner. `spawnProbe` now receives a complete `env`
and passes it to `spawn({ env })`; the host environment is never spread in. There is **no
silent default**: a var a probe does not see is a var it was not granted. The spawn also
passes **`--no-env-file`** (Codex review): `bun run` otherwise auto-loads a
working-directory `.env` / `.env.local` and merges it into the probe's `process.env`,
which would repopulate it with host secrets *outside* the scoped env / allowlist — a
back-door around the whole boundary whenever the harness runs from a directory holding a
`.env` (common in real projects). With `--no-env-file`, the scoped `env` is authoritative
and the operator's only widening path stays `allowHostEnv`.

**2. The operator widens the env via an explicit allowlist; the manifest cannot.** This
is the load-bearing distinction. `RunPackOptions.allowHostEnv: string[]` names host vars
the **operator** permits a probe to receive (each forwarded only if set on the host),
layered on top of the default scoped env. The CLI exposes it as `lodestar harness run
--allow-env <NAME>` (repeatable). The pack **manifest** — which the loader treats as
untrusted input (harness invariant 3) — has **no** say in the env. A hostile pack
therefore cannot declare its way to a host secret: it can ask for nothing, because the
mechanism that grants env lives entirely on the operator's side of the call. A complete
`RunPackOptions.env` override is also available for hermetic callers/tests (used verbatim;
host env still never merged); when set it wins over `allowHostEnv`.

**3. First-party DB-gated probes keep working because the operator forwards their one
declared var.** `sql-adapter-enforces-invariants` and `tool-poisoning-cross-session` read
`LODESTAR_TEST_DATABASE_URL`. The repo's own `probes:all` / `probes:safety` scripts now
pass `--allow-env LODESTAR_TEST_DATABASE_URL` — an explicit, in-repo, operator-controlled
declaration. CI sets that var on the probe step exactly as before, so the DB path is still
exercised for real; with the var unset the two probes skip loudly, unchanged. No probe was
edited (invariant 4).

**4. The runner owns the scoped HOME lifecycle.** `runPack` resolves the env **once** per
pack run (one temp HOME shared by every probe) and removes it in a `finally`; `runProbe`
does the same for a single probe. A complete `env` override has nothing to clean up
(operator-owned). A failed cleanup is swallowed — a leaked temp HOME is harmless.

**5. Honest about the boundary.** This is a **TS/process-level governance boundary, not an
OS sandbox**, the same framing as every native adapter. It denies host-environment
*secrets*; it does **not** contain a probe's filesystem or network reach. A probe can
still read files the process can read and open sockets. Closing *that* is step 2 (a real
process/OS sandbox), and even that will be a TS/process-level boundary, not
namespace/cgroup/network containment. So this step closes the host-env exfiltration hole —
the most direct and highest-value leak — and meaningfully shrinks the blast radius of a
verified-but-untrusted pack, but routine execution of a *fully* untrusted pack still waits
on step 2. The operator guidance softens, it does not disappear.

## Locking probe

`runner-denies-host-env-to-probe` (lodestar-core, the 57th probe) drives the **real**
`runPack` over a throwaway fixture pack whose probe reports its own environment, and pins
four things: a host `process.env` secret is **absent** from the spawned probe under the
default scoped env; `PATH` is **present** (the positive control that the runner is scoping,
not breaking, execution); an `allowHostEnv`-named var **is** forwarded while a
non-allowlisted host secret stays **absent on the same run** (the allowlist is additive and
scoped, never host-env-on); and a secret living **only in a working-directory `.env`** does
**not** reach the probe (the `--no-env-file` defense). Unit tests in `runner.test.ts` cover
the same cases plus the complete `env` override; CLI tests cover `--allow-env` parsing and
that `pack attest --kind probe_results` threads the allowlist into its run.

## Consequences

- The probe runner joins every other Lodestar subprocess boundary in refusing host env by
  default. The "do not run untrusted packs' probes" guidance becomes "the host-env leak is
  closed; full filesystem/network containment is step 2" — external packs are safer to run
  but not yet a routine execution surface.
- A new option surface (`allowHostEnv` / `--allow-env`) the operator must use to forward
  any host var a probe legitimately needs (a test DB URL, a registry token for a probe
  that exercises resolution). This is intended friction: forwarding a secret to a probe is
  now an explicit, auditable act.
- **Step 2 (OS sandbox) is deferred and will be filed separately**, per the threat-model
  doc. This ADR explicitly does not claim filesystem/network containment.

## Alternatives considered

- **Manifest-declared `allowed_env`.** Let the pack list the env it needs. Rejected: the
  manifest is untrusted (invariant 3), so a hostile pack would declare
  `AWS_SECRET_ACCESS_KEY` and the runner would hand it over — the exact hole, re-opened.
  The allowlist must live with the operator.
- **Inherit host env but redact a denylist of known-secret names.** Rejected: a denylist
  is unbounded and fails open — any secret not on the list leaks. Deny-by-default with an
  explicit allowlist is the only posture consistent with "no silent defaults for
  security-relevant settings."
- **Switch the runner to in-process import + a VM/realm sandbox.** Rejected: it would
  force every probe to export a `Probe` (rewriting the 56 first-party spec probes, against
  invariant 6), and a JS-level realm is weaker containment than a process boundary anyway.
  The subprocess model stays; the env is what we scope.
- **Build the OS sandbox now (steps 1+2 together).** Rejected: step 1 is the small,
  high-value, fully-shippable unblocker; coupling it to a real OS sandbox (the larger,
  platform-specific effort) would delay closing the host-env leak for no reason.
