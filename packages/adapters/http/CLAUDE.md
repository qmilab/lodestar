# @qmilab/lodestar-adapter-http — CLAUDE.md

Governed HTTP transport tools for the Action Kernel — P2 slice 4 (ADR-0008).
The third native egress after `git.push` and `nostr.publish`, and the first
adapter that exercises all three governance surfaces at once (ADR-0005's bar):
an **injection vector** (untrusted fetched content), **egress** (an
agent-authored request body leaving to an external host), and a **consequential
action** (an irreversible send).

- **`http.fetch`** — L1 inbound. Read a URL over HTTP; the body comes back as
  UNTRUSTED external content.
- **`http.request`** — L4 egress. Send a body (POST/PUT/PATCH/DELETE) to a pinned
  host. Held until approved; lights the `anomalous-tool-sequence` exfil pattern.

## What lives here

- `src/url.ts` — the URL guard: scheme allowlist (HTTPS only unless `allowHttp`)
  + operator-pinned host allowlist (`assertAllowedUrl`). The HTTP analogue of
  git's remote pinning / Nostr's `resolveTargets`. Checked on the initial target
  AND every redirect hop.
- `src/credentials.ts` — the `HttpCredential` model (a host-bound auth header) +
  `prepareCredentials`. Resolves the value only at request time (honours a
  `() => Promise<string>` resolver), binds it to a host, and exposes the
  redaction set. `applyRedactions` strips it from captured output.
- `src/client.ts` — the bounded `fetch` wrapper (`performRequest`): a wall-clock
  timeout (AbortController), a streamed response-body byte cap, and **manual
  redirect following with per-hop host re-validation**. The HTTP sibling of the
  Nostr adapter's `relay.ts` — same posture, an HTTP request instead of a relay
  WebSocket.
- `src/tools.ts` — the `http.fetch@1` / `http.request@1` output schema, the two
  `Tool`s, the `make*Tool` builders, the agent-header bounding, and the
  `defineHttpTools` / `registerHttpTools` config factory.
- `src/http.test.ts` — mechanism-level Bun tests against in-process `Bun.serve`
  fakes.

The headline invariants are locked by the harness probe
`packs/lodestar-core/probes/http-adapter-enforces-egress-invariants.ts`, which
drives the real tools through the real kernel.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (same framing as
ADR-0004/0006/0007). It enforces, in-process:

1. **Host pinning + scheme allowlist.** The operator pins the allowed hosts; the
   agent may only target a pinned host over an allowed scheme (HTTPS unless
   `allowHttp`). `assertAllowedUrl` is the chokepoint; a non-pinned host or a
   non-allowed scheme (e.g. `file://`) throws.
2. **Per-hop redirect re-validation.** Redirects are followed manually and every
   hop's host is re-checked against the pin. A pinned host that 3xx-redirects to
   a non-pinned host (the canonical SSRF escalation — e.g. to `localhost` or a
   cloud metadata endpoint) is stopped. 307/308 preserve method+body; 301/302/303
   degrade an unsafe method to GET (browser behaviour).
3. **Credentials are host-bound and never leave the adapter to the agent.**
   Operator-supplied (no silent default), **bound to the host the agent originally
   targeted** — a cross-host redirect (even to another pinned host) carries no
   credential, so a server cannot steer the adapter into making host B's
   authenticated request (a confused-deputy). Never in the agent's inputs, and
   redacted from all captured output, including the final URL and redirect chain.
4. **A no-approval read is not an arbitrary-header egress channel.** On `http.fetch`
   (L1) the agent may set only operator-allowlisted header NAMES
   (`allowedRequestHeaders`, default none) — otherwise a Cookie/`X-*` value would
   be agent data leaving to an external host below the L4 gate. `http.request` (L4)
   is human-approved, so its headers are unrestricted. (The intrinsic read channel
   is the URL alone — the analogue of `nostr.fetch` bounding its REQ filter.)
5. **Bounded capture.** A wall-clock timeout and a response-body byte cap stop an
   untrusted (possibly hostile) server from hanging the call or inflating an
   observation.
6. **Untrusted inbound.** A fetched body is UNTRUSTED external content — treat it
   as `external_document`; it must not self-promote to a supported belief. Deeper
   firewall integration (an HTML/JSON-aware evidence linker, à la the doc-agent's
   `DocAwareEvidenceLinker`) is the natural follow-up, not built here.

**What it does NOT claim:** it does not OS-sandbox the network, and it does not
resolve DNS to block private address ranges (that would be a network sandbox we
do not claim — and DNS rebinding can defeat a naive IP check). `fetch`/`request`
reach the real host *by design*; the pinned host allowlist is the destination
control. Keep this honest in docs and tool descriptions.

## Trust contracts

| Tool | Trust | blast_radius | reversibility | sandbox | permissions |
|------|-------|--------------|---------------|---------|-------------|
| `http.request` | **L4** | `external` | `irreversible` | `controlled-network` | `network.egress` |
| `http.fetch` | L1 | `project` | `reversible` | `controlled-network` | `network.egress` |

`blast_radius` is set by the proposer's `ActionContract`, not the `Tool`; the
egress tool declares a `publication` effect (like `git.push` / `nostr.publish`)
so a host building the contract knows to mark it `external`. `http.request` @ L4
is the headline: it parks at `pending_approval` until a human resolves it. Do
**not** lower the floor to make a demo pass. Neither tool spawns a subprocess, so
the honest sandbox is `controlled-network` (added in ADR-0007).

## When you extend this

- Keep destinations pinned and credentials operator-supplied. An agent-chosen
  host is an SSRF/exfil vector; an agent-supplied credential header is dropped
  (the operator's injected value wins) and the attempt stays auditable in the
  recorded inputs.
- Re-validate every redirect hop. The single most important HTTP-specific teeth
  is that destination pinning is re-checked after a 3xx — never follow a redirect
  blind.
- Declare real `effects` / `reversibility` / `required_trust_level` / `sandbox`.
  No silent defaults for security-relevant settings; HTTPS-only unless `allowHttp`
  is set explicitly.
- The `http-adapter-enforces-egress-invariants` probe is spec. If a change makes
  it pass without exercising host pinning, the L4 hold, redirect re-validation,
  the scheme allowlist, credential redaction, or bounded capture, that's a probe
  bug, not an improvement.
