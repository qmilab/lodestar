# Threat model — registry supply chain

## What it is

The trust-pack registry is where governance packs come from — policy packs, probe
packs, sentinel packs, adapter packs. Pulling a third-party pack into your project
is a *supply-chain* decision: you are deciding to trust bytes that someone else
wrote, fetched over a network you don't control, from a name that someone else
could squat. Every plugin ecosystem that got this wrong got it wrong the same way —
the marketplace object was *executable capability with unknown effects*, and the
registry became an attack distribution channel (the ClawHub supply-chain incident
is the cautionary precedent).

Lodestar's registry is built to *not* be that. Its design rule, set in
[ADR-0016](https://github.com/qmilab/lodestar/blob/main/.claude/adr/0016-trust-pack-registry-architecture.md),
is one sentence:

> **A pack is a trust artifact, not a capability artifact.**

A pack is a *signed manifest* that declares what it carries (probes, sentinels) and
binds the bytes it ships. It is never raw code that runs on install. Adopting one is
a verifiable, inspectable act, not an act of faith in a hostname. This document is
the attacker model that design holds against, and — honestly — the parts it does
not yet hold against.

It is the supply-chain sibling of the [memory-poisoning threat
model](memory-poisoning.md): that one defends the beliefs an agent *reads in*; this
one defends the governance packs an operator *installs*.

## Trust artifacts, not capability artifacts

The distinction is the whole design, so it's worth being precise about it:

- A **capability artifact** is something you run. A plugin, a skill, an `npm install`
  with a `postinstall` script. Installing it *is* executing it; its trust model is
  "I hope the author and everyone in their dependency chain is honest and uncompromised."
- A **trust artifact** is something you *verify*. A signed manifest with a content
  digest. Installing it is fetching bytes, checking a signature against a key you
  pinned, and checking the bytes against the digest the signature covers. Nothing the
  pack author wrote runs at install time.

Note the boundary line carefully: registry verification governs *which bytes you
trust*, not *what those bytes may do once a probe runs*. A pack's probes are still
executable code, and **running** an untrusted pack's probes is governed by the
harness runner, not by anything on this page. The runner now spawns each probe with
a **scoped environment** (no host `process.env` passthrough — ADR-0022, step 1), so a
probe cannot read host secrets out of the environment; full filesystem/network
containment (an OS sandbox) is step 2 and is **not yet built** (see ["what we don't
defend against"](#what-we-dont-defend-against-yet)). So this page's guarantees end at
"the bytes are authentic"; the host-env exfiltration hole is closed, but do not run a
*fully* untrusted pack's probes today on the assumption that execution is otherwise
contained.

Everything below is in service of keeping packs on the trust-artifact side of that line.

## Attacker model

| Attacker / surface | What they try | What holds the line |
| --- | --- | --- |
| **Hostile pack author** | Publish a pack that does something malicious | The signature attests *authorship*, not safety — see "what we don't defend against". Defence is the operator pinning *which* authors they trust, plus probe/scan badges as advisory signal. |
| **Compromised author key** | Sign a malicious pack as a trusted author | Out of scope to *prevent*; mitigated by pinning specific keys and (future) revocation. The blast radius is bounded to packs the operator already chose to trust from that author. |
| **Compromised / hostile index** | Advertise a malicious pack, hide a good one, swap a listing | An index can only *mis-advertise*. It cannot vouch: verification is local against operator-pinned keys, so a listing the index serves still has to carry a signature that verifies and a digest that matches. A tampered index entry fails its own signature (`pack-index-signature-required`). |
| **Re-pointed git tag / re-published npm artifact** | Serve different bytes under a name whose old manifest signature still verifies | The signed manifest **binds a content digest over the files**, and sources must resolve to **immutable bytes** (git commit SHA; npm version + integrity). A swapped artifact fails the post-resolution digest check (`tampered-pack-content-cannot-load`); a mutable branch/tag is rejected outright (`mutable-git-ref-rejected`). |
| **Pre-verification code execution** | Get code to run via `preinstall` / `postinstall` lifecycle scripts or git hooks during resolution, *before* anything is verified | Resolution is a **non-executing fetch**: tarball download + integrity check + extraction with scripts ignored (npm), `archive`/checkout at the pinned SHA with hooks disabled (git). No pack code runs until after the signature and digest verify (`resolution-runs-no-pack-code`). |
| **MITM on fetch** | Tamper with bytes in transit | Transport integrity (npm integrity hash, git SHA) plus the signed content digest — the trust is in the signature/digest, never in the transport. A tampered stream fails the digest check. |
| **Typosquatting** | Register `lodestar-prboes` and hope for a fat-fingered `pack add` | Not solved by signing alone — a squatted name carries its *own* valid author signature. Mitigated by the operator pinning author keys (a squat is a *different* key) and by reading the declared manifest before install; full namespace/name-reputation defence is a registry-curation concern (commercial). |
| **Malicious probe at run time** | A pack whose probe, when *run*, reads host secrets out of `process.env` or escapes | **Partially held (runner-side, registry-orthogonal).** Step 1 has landed (ADR-0022): the runner spawns each probe with a **scoped env** (a fresh empty HOME + inherited PATH, no host `process.env`), so a probe cannot read host secrets out of the environment — the operator widens it only via an explicit `--allow-env` allowlist, never the untrusted manifest (`packages/harness/src/runner.ts`; probe `runner-denies-host-env-to-probe`). **Not yet held:** filesystem/network containment — a probe can still read files and open sockets the process can. That is step 2 (an OS sandbox), filed separately. Do not run a *fully* untrusted pack's probes until it lands. See ["what we don't defend against"](#what-we-dont-defend-against-yet). |

## Architectural responses

### 1. The signed manifest is the trust root

Every external pack carries an Ed25519 signature over its canonical manifest, made
with the **pack author's key** and verified **on load** against a set of author keys
the *consumer* pins. This reuses the same `node:crypto` Ed25519 primitive that backs
[signed approval resolutions](../policy-kernel.md) (ADR-0010) — one audited
sign/verify path, factored to a shared helper rather than copied. The reject set is
deliberately strict: a missing signature (unless an explicit `allow_unsigned` opt-out
for local first-party dev), a hash mismatch, a signer that isn't the declared author,
a signer not in the pinned set, a non-ed25519 algorithm, or bad signature bytes all
fail the load. Probes `pack-manifest-signature-required` and `forged-pack-cannot-load`
lock this.

### 2. The signature binds the bytes, not just the declaration

Signing a manifest that only named files would authenticate the *promise* while
leaving the *delivery* unauthenticated — a re-pointed tag could swap the actual
files under a still-valid signature. So the canonical manifest **includes a content
digest** over the pack's resolved files (a sorted `path → sha256` list, or a tree
digest over it), and the loader **recomputes that digest after fetching and rejects
any mismatch**. This is the invariant that makes "a compromised index can
mis-advertise but never launder a malicious pack" actually true. `pack publish`
computes the digest and signs *after* the files are frozen, so author tooling can't
sign-then-mutate. Probe `tampered-pack-content-cannot-load`.

### 3. Sources resolve to immutable bytes, fetched without executing

Two requirements travel together. **Immutability:** a git source pins a full commit
SHA (a branch or tag is rejected unless accompanied by a pinned digest, because a tag
can be force-moved); an npm source pins an exact version plus its registry integrity
hash. **Non-execution:** resolution is a fetch-and-extract, never an install — npm
tarball + integrity + extraction with scripts ignored, git `archive`/checkout with
hooks disabled. No `preinstall`/`postinstall` script and no git hook ever runs,
because nothing pack-authored runs until the signature and digest have verified.
Probes `mutable-git-ref-rejected`, `resolution-runs-no-pack-code`.

### 4. Verification is local; the index can never vouch

There is no hosted authority whose word you take. Discovery in the open layer is a
**static signed index** — a plain JSON listing an author or community can host
anywhere — and choosing a pack from it still routes the chosen pack through the
signature + digest checks above. A hostile index can omit, reorder, or mislabel; it
cannot make an unsigned or forged pack verify. This is the decentralized,
protocol-not-service stance: the registry is a way to *find* packs, never a reason to
*trust* them. Probe `pack-index-signature-required`.

### 5. Badges are locally-verifiable attestations, not registry claims

A "this pack passed its probes" or "this pack was scanned clean" badge is itself a
small signed document, issued by an attesting authority over the pack at a pinned
version, and **verified locally against pinned attester keys** — a separate trust
root from the author keys. A badge is *advisory trust signal*, surfaced before
install; an unverified or unpinned-attester badge is shown as exactly that and never
counted as trusted. A compromised index can strip or mis-attach badges but cannot
forge one that verifies. Probe `unverified-badge-not-trusted`.

## The open/commercial line

The open registry is a **protocol**. What ships in this repository is the *format and
the local checks*: signed manifests + content binding, npm/git resolution, the
`lodestar pack publish` / `pack add` CLI, the badge format + local verification, and
the static signed-index format. None of it depends on a Lodestar-hosted service, and
none of it gates the solo-developer workflow.

What is deliberately *not* here is the managed surface: a hosted search/discovery
backend, the scanner that actually *runs* security scans and *issues* the trusted
badges at scale, organisation-scoped private packs, and the human curation pipeline.
That is the commercial layer. The security point is that the commercial layer makes
discovery and attestation *convenient and trustworthy at scale* — it never becomes a
*required* trust intermediary, because every consumer still verifies locally against
keys it pinned.

## What we don't defend against (yet)

- **A malicious pack that is honestly signed by a trusted author.** A signature
  attests *who authored* the bytes, not that the bytes are *safe* — the same
  "signature ≠ truth" honesty Lodestar applies to fetched Nostr/HTTP content. A pack
  you've chosen to trust, signed by a key you've pinned, can still ship a probe that
  does something you didn't want. The defences against this are *outside* the
  signing boundary: probe/scan badges as advisory signal, reading the manifest's
  declarations before install, and — once it exists — runner-side execution
  containment (see the next bullet). It is *not* defended by anything on this page.
- **A compromised author private key.** If an attacker holds a pinned author's
  private key, they can sign malicious packs as that author. v0 has no revocation
  list or key-rotation protocol; the blast radius is bounded to that author's packs,
  and recovery is the operator un-pinning the key by hand. Key rotation/revocation is
  an open question below.
- **Probe execution containment — step 1 done, step 2 not built yet.** Be precise
  about the current state. **Step 1 (scoped-env execution) has landed** (ADR-0022): the
  harness runner now spawns each probe with an explicit scoped environment — a fresh
  empty HOME + inherited PATH — and **never the host `process.env`**, so a probe cannot
  read host secrets (API keys, cloud credentials, tokens) out of the environment. The
  operator forwards a specific host var only via an explicit `--allow-env <NAME>`
  allowlist (`RunPackOptions.allowHostEnv`); the **untrusted manifest cannot** widen it,
  so a hostile pack cannot declare its way to a secret (`packages/harness/src/runner.ts`;
  probe `runner-denies-host-env-to-probe`). This mirrors the Action Kernel's "no host env
  to sandboxes" rule and the native adapters' `baseGitEnv`/`defaultScopedEnv`. The spawn
  also passes `--no-env-file` so `bun run` cannot auto-load a working-directory `.env`
  back into the probe's `process.env` (a back-door that would otherwise re-introduce host
  secrets past the scoped env whenever the harness runs from a project holding a `.env`). **Step 2 (a
  real OS sandbox) is not built.** Scoped env denies host-environment secrets; it does
  **not** contain a probe's filesystem or network reach — a probe can still read files and
  open sockets the runner process can. Closing that is step 2, and even *that* would be a
  TS/process-level boundary, not namespace/cgroup/network containment, consistent with the
  native adapters' "TS-level governance boundary, not an OS sandbox" honesty. **The
  host-env exfiltration hole is closed; until step 2 lands, still do not run probes from a
  pack you do not trust the author of as a routine execution surface.**
- **Registry availability and censorship.** A decentralized index is resilient to a
  single bad actor but offers no availability guarantee — an index host can simply go
  away, and there is no built-in mirroring/quorum in v0.
- **Dependency-chain compromise of a pack's *own* dependencies.** v1.5 packs are
  self-contained probe/sentinel files under a content digest; once packs are allowed
  to declare their own dependency trees, transitive supply-chain risk re-enters and
  needs its own treatment.

## Operator guidance

- **Pin author keys deliberately.** The trust root is *your* pinned set, not the
  registry's. Add an author key only after you've decided to trust that author.
- **Prefer pinned, immutable sources.** A git commit SHA or an exact npm
  version + integrity, never a moving branch/tag. The loader enforces this, but
  prefer it in how you *reference* packs too.
- **Read the manifest before `pack add`.** It declares coverage areas, the invariants
  it claims to exercise, and its trust floor. `pack add` surfaces this (and any
  badges) *before* installing — read it.
- **Treat badges as advisory, weight verified ones.** A locally-verified
  `probe_results` or `security_scan` badge from a pinned attester is signal; an
  unverified badge is decoration.
- **Keep the log directory sensitive.** As with the rest of Lodestar, the NDJSON log
  is tamper-evident (payload hashes) but not encrypted at rest in v0.

## Open questions

- **Key rotation and revocation.** How does a consumer learn a pinned author or
  attester key was compromised, and roll it, without a central authority? A signed
  revocation record distributed like the index is the likely shape; not designed yet.
- **Bootstrapping attester trust.** Author-key pinning is a clear act; pinning
  *attester* keys (whose badges you'll weight) needs an equally clear bootstrapping
  story, especially once a commercial attester exists.
- **Generalising the pack format.** v1.5 signs the existing probe-pack (+sentinels)
  format. Extending the same trust plumbing to policy-pack and adapter-pack kinds —
  a `kind` discriminant behind the spec version (ADR-0016 §5) — is where adapter
  packs, the riskiest category, will need this threat model revisited.
- **Probe-runner containment (step 2).** Step 1 (scoped-env execution, deny host
  `process.env`) has landed (ADR-0022); the open step is a real OS sandbox bounding a
  probe's filesystem and network reach. Scoped env turned "verified third-party pack"
  into "safe-to-run *without leaking host env secrets*"; the OS sandbox is what would
  make external packs a *routine* execution surface. It will still be a TS/process-level
  boundary, not namespace/cgroup/network containment — file it separately when picked up.
