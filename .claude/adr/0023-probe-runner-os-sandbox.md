# ADR-0023: Probe-runner OS sandbox (step 2) — native per-platform filesystem + network confinement

- **Status:** Accepted
- **Date:** 2026-06-17 (proposed); accepted same day after the implementation
  validated the design and the refinements noted below.
- **Deciders:** Nandan, Claude
- **Related:** #121 (this ADR), #114 / ADR-0022 (step 1 — scoped-env execution, the
  prerequisite this builds on), #76 (registry epic — the orthogonal sibling), #91
  (registry threat model), `docs/concepts/threat-model/registry-supply-chain.md`
  (open questions §"Probe-runner containment (step 2)"), ADR-0004 (the "TS-level
  governance boundary, not an OS sandbox" honesty this restates), ADR-0006/0018
  (the `baseGitEnv` / `spawnCaptured` scoped-subprocess discipline), `packages/harness/src/runner.ts`

## Context

ADR-0022 (step 1) closed the **host-env exfiltration hole**: the harness runner now
spawns each probe with an explicit scoped env (a fresh empty `HOME` + inherited
`PATH`, `bun run --no-env-file`), never the host `process.env`. That denies host
*secrets in the environment* to a verified-but-untrusted pack's probe. It explicitly
does **not** contain the probe's **filesystem or network reach** — a probe is still a
subprocess that can read any file the runner's uid can read (`~/.ssh`, `~/.aws`,
source trees, other packs), write/delete what the uid can write, and open arbitrary
outbound sockets to exfiltrate it. ADR-0022 and the threat-model doc both name this as
**step 2, deferred and to-be-filed once step 1 landed**. #121 is that issue; this ADR
is its design pass.

Two facts shape the decision.

**1. The probe-runtime envelope is tight and known.** A sweep of all 61 first-party
probes (`packs/lodestar-core/`, `packs/coding-agent-safety/`) shows the *union* of what
they legitimately need:

- **Network:** loopback TCP **both directions** — many probes bind ephemeral
  `127.0.0.1` servers (http / nostr-ws / messaging / ship-collector / npm-registry
  stand-ins) and connect back to them. The **only** non-loopback need is the two
  DB-gated probes (`sql-adapter-enforces-invariants`, `tool-poisoning-cross-session`)
  reaching the test Postgres host. No probe makes any other external connection.
- **Subprocess:** spawn `git`, `tar`, `bun` (registry-resolution + git-adapter probes).
- **Filesystem write:** read+write under the OS temp dir (`mkdtemp(tmpdir(), …)`
  everywhere); nothing outside it.
- **Filesystem read:** the pack/fixture files, the temp dirs, and — for a few probes
  (`guard-contract-invariants`, the fs/git-adapter probes) — the **repo root**
  (`process.cwd()`), because they register fs/git tools rooted there.

So an OS sandbox can be tight without editing a single probe: **loopback-only network,
a short binary allowlist (read+exec of system runtime paths), read+write a per-run
temp scratch, read a configurable root.**

**2. The repo-read tension.** First-party probes *assume* repo-root read access; for an
**untrusted external pack**, reading the consumer's source tree is exactly what we want
to deny. So the read-root cannot be "always the repo." It defaults to the pack dir +
scratch and is **operator-widened**, mirroring step 1's `--allow-env`. This is the same
load-bearing rule as ADR-0022: the widening lever lives with the operator, never the
untrusted manifest.

**3. Cross-platform.** The primary targets are a macOS dev box (`/usr/bin/sandbox-exec`
present) and Linux CI (bubblewrap). A choice has to cover both honestly.

## Decision

**1. A pluggable sandbox-launcher seam wraps probe execution, composed *outside* the
step-1 scoped env.** A new `src/sandbox/` module in `@qmilab/lodestar-harness` exposes
`pickSandbox(policy)` returning a launcher that rewrites the spawn at
`runner.ts:spawnProbe` from `spawn(bun, ["run","--no-env-file", probe.path], {env})`
into `spawn(sandboxCmd, [...sandboxArgs, bun, "run","--no-env-file", probe.path],
{env})`. The scoped env (step 1) is the **inner** layer and is unchanged; the OS
sandbox is the **outer** layer. Resolution/execution stays in the harness (invariant
1); core gains nothing.

**2. Two native backends in the first cut, selected by platform + capability probe at
runtime — no daemon/container dependency.**
- **macOS:** `sandbox-exec -p <SBPL profile>`. SBPL gives *granular* control:
  `(deny default)`, allow file-read on system runtime paths + the read-root, allow
  file-write on the scratch, `(deny network*)` with per-target
  `(allow network-outbound (remote ip "localhost:*"))` and per-host allows.
- **Linux:** `bubblewrap` (`bwrap`): `--ro-bind` the system + read-root, `--bind` the
  scratch, `--unshare-net` for loopback-only isolation, `--die-with-parent`,
  `--unshare-pid`, drop everything else.
- The seam is built so a **container backend** (`--sandbox=container`, `docker/podman
  run --network=none --read-only …`) can be added later as an opt-in *without
  reworking the seam* — the hybrid endpoint, deferred (see Alternatives). Container is
  **not** the default precisely because requiring a running daemon everywhere defeats
  "easily deployable anywhere."

**3. First cut confines filesystem AND network together** (the chosen scope for #121):
- **Filesystem.** Deny by default. Allow **read+exec** of system runtime paths so
  spawned `git`/`tar`/`bun` resolve and load (PATH dirs, `/usr`, the macOS dyld cache,
  etc.). Allow **read+write** of a **per-run scratch** — the scoped env sets `TMPDIR`
  to that scratch so `os.tmpdir()` *is* the confinement boundary (probes' `mkdtemp`
  lands inside it for free). Allow **read** of the **read-root**, default = the pack
  dir; widened by the operator via `--allow-read <path>` (repeatable). The pack
  manifest cannot widen it.
- **Network.** Deny all outbound by default **except loopback** (`127.0.0.1`/`::1`) —
  which covers every local-test-double probe. A non-loopback host is allowed only via
  the operator's `--allow-host <host[:port]>` (repeatable); the manifest cannot widen
  it.

**4. The CLI defaults sandbox ON for external packs, OFF for the two bundled
first-party packs.** This is the refinement implementation forced (see "Implementation
refinements"): the sandbox is opt-in at the `runPack` *library* level (an explicit
`sandbox` policy), and `lodestar harness run` enables it by default — **except** for the
bundled `lodestar-core` / `coding-agent-safety` packs, which default OFF. Those are the
trusted reference set, and several of their probes *drive `runPack` themselves*
(`runner-denies-host-env-to-probe`, the new locking probe, `guard-contract-invariants`),
so sandboxing them would nest a sandbox inside a sandbox. `--sandbox` / `--no-sandbox`
override the default either way; `--allow-read` / `--allow-host` widen it. So
`probes:all` / `probes:safety` need no change (first-party default-off), and the locking
probe runs unsandboxed while constructing its *own* sandbox over a throwaway fixture — no
nesting. Every grant stays operator-side; the manifest cannot widen anything.

**5. Degradation: fail closed by default, with an ergonomic explicit opt-out.** If no
sandbox mechanism is available on the platform (neither `sandbox-exec` nor `bwrap`;
`bwrap` present but unprivileged user namespaces disabled; Windows), the runner
**refuses to run** and prints an actionable message naming the fix (*"install
bubblewrap, or re-run with `--no-sandbox` to fall back to env-scoping-only (step-1
behaviour)"*). `--no-sandbox` is the audited operator opt-out. This honours "no silent
defaults for security-relevant settings"; on the two real platforms a mechanism is
always present, so the fallback path is rarely hit and the friction is near-zero in
practice. (Trust-tiered auto-fallback for pinned-author packs was considered and
deferred — see Alternatives.)

**6. Honest about the boundary.** This is an **OS-primitive governance boundary**, not
kernel-grade containment. `sandbox-exec` is Apple-**deprecated** (works today, no
supported replacement at this granularity); `bwrap` relies on unprivileged user
namespaces and is not a defence against a kernel-level sandbox escape. We claim:
filesystem-read confinement to an operator-declared root, filesystem-write confinement
to a per-run scratch, and outbound-network deny-by-default to loopback + an operator
allowlist. We do **not** claim namespace/cgroup resource limits, defence against a
kernel 0-day, or per-host network granularity *on Linux* (see known wrinkles). This is
the same honesty every native adapter and step 1 itself practice.

## Implementation refinements (what the build changed)

The design held; four things were sharpened once it ran on a real macOS box (the
Linux path is CI-validated):

- **macOS read confinement is deny-the-home, not a read-allowlist.** `bun` is a JIT
  runtime (JavaScriptCore); a strict SBPL `(deny default)` profile that hosts it
  reliably across macOS versions needs a large, brittle allowlist (executable mmap,
  mach bootstrap, POSIX shm, the dyld shared cache, …) and aborted with `SIGABRT` in
  practice. The robust shape is `(allow default)` then **clamp**: deny writes (except
  the scratch), deny network (except loopback + allow-hosts), and deny **reads of the
  operator's home directory** — where ssh/aws/gcloud/npm credential stores live —
  re-allowing the declared read-roots. This does *not* deny reads of `/etc`, `/var`, or
  other users' files; it denies the running user's home, the actual secret store.
  **Linux (bwrap) keeps the stronger read-allowlist** via a mount namespace that binds
  only the declared roots. So the filesystem guarantee is asymmetric (Linux stronger),
  the mirror of the network granularity (macOS stronger) — both close the primary
  threats, documented honestly.
- **Canonicalise every path the profile references.** `tmpdir()` and `$HOME` are
  symlinks on macOS (`/var` → `/private/var`), and SBPL matches the *real* path — an
  un-canonicalised scratch made a probe's own writes fail, and an un-canonicalised home
  deny silently *let a secret read through* (caught by the locking probe under the CLI's
  scoped HOME). The runner `realpathSync`-es the scratch + read-roots; the macOS backend
  canonicalises the home it denies.
- **macOS treats the host's own addresses as local.** A sandboxed connect to the
  machine's *own* LAN IP succeeds (delivered locally); only genuine **remote** egress is
  reliably blocked. The locking probe therefore targets a real remote and gates the
  assertion on an unsandboxed baseline so it is meaningful, never a false pass offline.
- **`pack attest --kind probe_results` is not sandboxed yet.** It runs a pack's probes
  to mint a badge; sandboxing it (with the same first-party caveat) is a follow-up. The
  routine-external-execution surface this ADR is about is `lodestar harness run`.

## Known wrinkles to validate in implementation

These are real and are why this is a design pass, not a one-line restatement of step 1:

- **Linux per-host network granularity.** `bwrap --unshare-net` is all-or-nothing: an
  isolated net namespace has only its *own* loopback, with no route to an external host
  *or to the host's `127.0.0.1`*. So `--allow-host` cannot be honoured per-host under a
  plain `--unshare-net`. macOS SBPL *can* allow a specific remote. v0 plan: with no
  `--allow-host`, fully isolate the network (the common case — all local-double
  probes). With `--allow-host`, on Linux fall back to a **coarser** policy for that run
  (do not unshare the network; net allowed) with a banner; macOS stays granular.
  Granular Linux egress (slirp/pasta, an allowlist proxy) is a documented follow-up.
- **CI Postgres over the host's loopback.** A GitHub Actions `postgres:16` service maps
  to the runner's `localhost:5432`, which is *outside* a `--unshare-net` namespace's
  loopback. So the DB-gated probes on Linux CI must run under the `--allow-host`
  coarser-net path above (or share the host net namespace). The implementation must
  wire this so the two DB-gated probes still run for real in CI.
- **Temp-scratch coarseness.** Confining writes to the run's `TMPDIR` lets a probe read
  *other* files under that scratch, not arbitrary host temp. A per-probe scratch is a
  later tightening, not v0.
- **Linux loopback is down under `--unshare-net`.** A fresh net namespace has only its
  own `lo`, and bwrap leaves it *down*. So a probe that binds a loopback **server** (and
  expects to reach it) needs the operator to `--allow-host` (which shares the host net),
  or to run unsandboxed. First-party probes that bind loopback servers run unsandboxed
  (first-party default-off), so this does not bite CI; it is a documented limit for
  external packs. Bringing `lo` up inside the namespace is a follow-up.

## Locking probe

A new probe (working name `runner-sandboxes-probe-filesystem-and-network`, lodestar-core)
drives the **real** `runPack` over a throwaway fixture pack whose probe is an
"escape attempt", and pins, with positive controls:

- **Filesystem read denied:** a host file planted outside the sandbox (e.g. under the
  real `$HOME` / an absolute system path) is **unreadable** from the probe.
- **Filesystem write denied:** a write outside the run scratch **fails**.
- **Network egress denied:** an outbound connection to a genuine **remote** host
  **fails** — asserted only when an unsandboxed baseline first proves the host could
  otherwise reach it (so it is never a false pass on a network-less run), since macOS
  blocks remote egress but treats the host's own addresses as local.
- **Positive controls:** a read of the pack dir succeeds and a write under the scratch
  succeeds — proving the sandbox is scoping, not breaking, execution. (The loopback
  positive control is omitted: `lo` is down under Linux `--unshare-net`, so it is not a
  cross-platform invariant; the two filesystem positive controls suffice.)

Like the Postgres-gated probes, it **skips loudly** (exit 0 + banner) when no sandbox
mechanism is available *or is present but non-functional* (a preflight trivial run
detects e.g. bwrap-with-userns-disabled), so CI on Linux exercises it for real while a
mechanism-less or misconfigured box does not spuriously fail. Unit tests in
`runner.test.ts` cover the `env`+`sandbox` mutual exclusion, the confined env, a denied
home-secret read, and the fail-closed throw (conditional on no mechanism); CLI tests
cover `--allow-read` / `--allow-host` / `--no-sandbox` parsing, default-on for external
packs, and the fail-closed exit.

## Consequences

- The probe runner becomes a genuine execution-containment boundary: running a
  verified-but-untrusted external pack's probes no longer exposes the consumer's
  filesystem or grants outbound network. Combined with step 1, this turns "safe to run
  *without leaking host env secrets*" into "safe to run as a routine surface" on the
  supported platforms — the property the registry epic ultimately needs.
- New operator surface (`--allow-read`, `--allow-host`, `--no-sandbox`) parallel to
  step 1's `--allow-env`. Intended friction: widening the sandbox is an explicit,
  auditable act, always operator-side, never manifest-declarable.
- A platform-specific maintenance burden: two profiles (SBPL + bwrap flags) and a
  capability probe to keep green across macOS + Linux CI.
- The honesty boundary is preserved and made precise: OS-primitive confinement, not
  kernel-grade containment; granular per-host egress is macOS-only in v0.
- Done in this change: `docs/concepts/threat-model/registry-supply-chain.md` (the "step
  2 not built" notes → built, with the documented limits), ADR-0022's "step 2 deferred"
  consequence, `packages/harness/CLAUDE.md` invariant 6, and the CI workflow (install
  bubblewrap). This ADR is Accepted.
- Out of scope (unchanged): the registry verification chain (#88/#86/#90/#89/#87) and
  the *resolver's* own `git`/`tar` subprocesses in `pack/run.ts` (those fetch pack
  bytes and are already scoped; this ADR governs probe *execution*, not pack
  *resolution*).

## Alternatives considered

- **Container as the default (Docker/Podman `--network=none`).** Strongest blast-radius
  story, one profile. Rejected as the default: it requires a running container daemon
  on every machine that runs probes — the heaviest dependency and the opposite of the
  stated "easily deployable anywhere" goal — plus per-probe startup cost and
  Docker-in-CI nesting friction. Kept as a *future opt-in* the seam is built to accept.
- **Bun-native permissions only.** Bun has no Deno-style `--allow-read`/`--allow-net`
  permission model that confines fs/net comprehensively, so it cannot deliver step 2 on
  its own. Noted, not used.
- **Linux Landlock + seccomp instead of bwrap.** Landlock (fs, kernel ≥5.13) +
  seccomp (block `socket()`) is in-process and dependency-free, but it's more moving
  parts, seccomp's network block is all-or-nothing (worse than the loopback split), and
  it needs an N-API/FFI shim from Bun. `bwrap` is a single well-understood binary that
  does fs + net in one tool. Revisit if the bwrap dependency proves a problem.
- **Trust-tiered degradation** (pinned-author packs auto-fall-back to step 1 when no
  sandbox is available; untrusted packs refused). Rejected for v0: it adds an
  execution-mode-keyed-on-trust concept to serve a niche (first-party packs on a
  mechanism-less platform — rare, since the real platforms all have a mechanism). Plain
  fail-closed + `--no-sandbox` is simpler and the message makes it ergonomic.
- **Step 2 as network-only or filesystem-only first.** Rejected (operator chose
  both-together): doing only one leaves the obvious complementary hole — confine the
  filesystem but a probe still beacons, or deny egress but a probe still reads
  `~/.ssh`. Both-together is the coherent "OS sandbox" slice.
