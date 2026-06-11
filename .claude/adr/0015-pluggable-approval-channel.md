# ADR-0015: Pluggable approval channel — file or HTTP transport for signed resolutions

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Nandan
- **Related:** ADR-0010 (signed approval resolutions), ADR-0014 (session shipper), `packages/guard-mcp/src/approvals-channel.ts`, `docs/reference/public-api.md`

## Context

A held L4 action is resolved out-of-band today through exactly one
separate-process transport: the file side-channel
(`<log_root>/.approvals/<project_id>/<request_id>.json`), polled by the
proxy and written by `lodestar approve`. That requires the approver to be
on the same filesystem. Remote approval surfaces — an approvals UI, a
notification bot, a phone — need a resolution to arrive over the network.

The non-negotiable constraint is ADR-0010's forgery boundary: the proxy
verifies every resolution's Ed25519 signature against **operator-pinned
approver keys** before promoting it, on both the side-channel and the
sibling log path. Whatever transports a resolution must not move that
boundary. A second constraint is the naming hazard: guard already exports
`ApprovalResolver` — the **trusted in-process seam** that *produces* an
`ApprovalOutcome`. A remote transport is categorically different: it is
**untrusted** and can only *ferry bytes to be verified*. The two must never
be conflatable in types or docs.

## Decision

Extract the side-channel behind an `ApprovalChannel` interface in
`@qmilab/lodestar-guard-mcp`; the file implementation is the default and
reproduces today's behavior byte-for-byte:

```ts
interface ApprovalRef {
  project_id: string
  session_id: string
  request_id: string
  action_id: string
}

interface ApprovalChannel {
  /** Best-effort notify: a hold opened. Failure never blocks or fails the hold. */
  announce?(request: ApprovalRequest): Promise<void>
  /** Poll for a resolution. undefined = not yet. Return value is UNTRUSTED INPUT. */
  fetch(ref: ApprovalRef): Promise<ApprovalResolution | undefined>
  /** Consume after promotion (delete file / ACK). Best-effort, errors swallowed. */
  consume?(ref: ApprovalRef): Promise<void>
}
```

The wire shape stays exactly `ApprovalResolutionSchema` (already carries
the optional Ed25519 `Signature`). The HTTP implementation is config-driven:

```jsonc
"approvals": {
  "authorized_keys": [ … ],                      // REQUIRED for kind: "http"
  "channel": { "kind": "file" }                   // default — today's behavior
  // or
  "channel": {
    "kind": "http",
    "endpoint": "https://…",                      // operator-pinned base URL, config only
    "token_env": "LODESTAR_APPROVALS_TOKEN"       // bearer token via env, never inline
  }
}
```

HTTP wire: `announce` = `POST {endpoint}/v1/approvals` (the
`ApprovalRequest`); `fetch` = `GET {endpoint}/v1/approvals/{project_id}/{request_id}`
→ `200` with an `ApprovalResolution` or `404`; `consume` = `DELETE` on the
same path. v0 rides the existing poll loop; the GET tolerates a future
`?wait_ms=` long-poll parameter.

**The verification pipeline does not move.** On every fetched resolution,
in the proxy, after transport: Zod parse → deadline gate (`at` ≤ deadline)
→ `verifyApprovalSignature` against the pinned keys → request/action
binding → promote into the proxy's own log (sole writer) → consume. A
channel can therefore only **transport** a signed decision; it cannot mint,
upgrade, or redirect one. Adversarial walk for a fully malicious endpoint:

- **Mints a grant** → no pinned private key → signature fails → stays held
  → `approval_timeout` (with the `guard.approval.signature_rejected`
  diagnostic). Fail-safe.
- **Tampers** (e.g. flips `denied`→`granted`) → `payload_hash` mismatch →
  rejected.
- **Replays onto another request/action** → `request_id`/`action_id` are
  inside the signed canonical document, and `ActionKernel.resolve()`
  independently refuses a mismatched binding. Two layers.
- **Replays after the deadline** → the numeric `at ≤ deadline` gate makes
  it a timeout, exactly like a late file.
- **Withholds / returns garbage** → denial of service on approvals only;
  torn or invalid bodies are `undefined` (keep polling) and the hold times
  out to the conservative outcome.

Three hard requirements the HTTP case adds:

1. **`kind: "http"` requires pinned keys and rejects `allow_unsigned`
   outright** (schema `superRefine` + constructor guard). The file
   channel's unsigned dev mode is a same-machine opt-out; an unsigned
   *remote* channel must be unrepresentable.
2. **The channel credential never reaches the event log** — env-sourced,
   excluded from diagnostics, probe-asserted (the adapters' credential
   discipline).
3. **`announce` is egress** — it is gated by the same sensitivity ceiling
   the shipper uses (ADR-0014), and it is best-effort: its failure or
   compromise can change a hold's visibility, never its outcome.

The endpoint URL is **operator-pinned config, never derived from agent or
log content** — dynamic endpoint discovery would reintroduce the SSRF class
the http adapter (ADR-0008) exists to stop.

**Probes:** `approval-via-http-channel` (mirror of
`approval-via-side-channel` against a local stub endpoint, including
sole-writer seq integrity), an HTTP case added to
`forged-approval-cannot-execute` (forged / tampered / replayed / late via
the channel), and a credential-never-in-log assertion. The existing
six-case forged-approval probe must keep passing unmodified.

## Consequences

- A resolution can arrive from any remote approvals surface while the trust
  root stays "holds the approver private key" — a compromised transport can
  only delay, and delay resolves to deny.
- The side-channel file layout and `ApprovalResolutionSchema` become a
  documented public contract (they already were one de facto for external
  resolvers).
- The proxy gains an optional outbound `announce` surface — one new,
  ceiling-gated egress to reason about.
- The two-seam naming (`ApprovalResolver` = trusted in-process producer;
  `ApprovalChannel` = untrusted transport) becomes load-bearing vocabulary.

## Alternatives considered

- **Reuse guard's `ApprovalResolver` type for the remote path** — rejected:
  it *produces* trusted outcomes in-process; a transport ferries untrusted
  bytes. Conflating them invites a host to skip verification.
- **Remote resolver appends the log directly** — rejected long ago
  (ADR-0010 context): cross-process `seq`/`logical_clock` collide; the
  proxy stays the sole writer.
- **Webhook push into the proxy** — rejected: the proxy would grow an
  inbound listening surface; pull-only polling keeps the attack surface
  closed and reuses the existing hold loop.
- **Dynamic endpoint discovery (from env of the wrapped agent, log
  content, or downstream servers)** — rejected: SSRF by construction.
