# @qmilab/lodestar-adapter-http

Governed HTTP transport tools for the Lodestar Action Kernel — part of
**Lodestar**, the trust layer for AI agents.

Two tools, host-agnostic (they speak HTTP to any operator-pinned host):

| Tool | Trust | Direction | What it does |
|------|-------|-----------|--------------|
| `http.request` | **L4** | egress | Send a body (POST/PUT/PATCH/DELETE) to a pinned host. Held until a human approves. |
| `http.fetch` | L1 | inbound | GET/HEAD a pinned host and return the body as **untrusted** external content. |

`http.request` is the third native egress in Lodestar after `git.push` and
`nostr.publish`, and `http` is the first adapter to hit all three governance
surfaces at once: an injection vector (untrusted fetched content), egress (a body
leaving to an external host), and an irreversible action.

## Install

```sh
bun add @qmilab/lodestar-adapter-http
```

## Use

```ts
import { registerHttpTools } from "@qmilab/lodestar-adapter-http"

registerHttpTools({
  fetch: {
    // The operator pins the allowed hosts. The agent can target only a pinned
    // host — never an arbitrary or internal one (the SSRF guard).
    allowedHosts: ["api.example.com", "docs.example.com"],
    // Host-bound auth header. A function is resolved at request time so a host
    // can fetch it from a secret store. Never the agent's; redacted from output.
    credentials: [
      { host: "api.example.com", header: "Authorization", value: () => secrets.get("API_TOKEN") },
    ],
    maxBytes: 1024 * 1024, // cap on the captured (untrusted) body
  },
  request: {
    allowedHosts: ["api.example.com"],
    allowedMethods: ["POST"], // default is all of POST/PUT/PATCH/DELETE
  },
})
```

The tools register into the Action Kernel's tool registry. Drive them through the
kernel (`propose → arbitrate → execute`) like any governed tool; a host (Guard,
the MCP proxy, an example) supplies the policy gate and `KernelContext`. The L4
`http.request` parks at `pending_approval` until a human resolves it.

### The agent's inputs

```ts
// http.fetch
{ url: "https://api.example.com/v1/things", method?: "GET", headers?: { Accept: "application/json" } }

// http.request
{ url: "https://api.example.com/v1/things", method?: "POST", body?: "{...}", content_type?: "application/json", headers?: {} }
```

`url`'s host must be in the operator-pinned set over an allowed scheme (HTTPS
unless `allowHttp` is set); anything else fails the action. Reserved and
operator-credential header names supplied by the agent are dropped (the
operator's value wins), and the attempt stays auditable in the recorded inputs.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (the same honesty as
the shell / git / Nostr adapters, ADR-0004/0006/0007). It enforces, in-process:

1. **Host pinning + scheme allowlist.** The agent can reach only operator-pinned
   hosts over an allowed scheme. A non-pinned host or a `file://`/other scheme
   fails the action.
2. **Per-hop redirect re-validation.** Redirects are followed manually and every
   hop's host is re-checked against the pin — a pinned host that 3xx-redirects to
   `localhost`, a cloud metadata endpoint, or any non-pinned host is stopped (the
   classic SSRF escalation). A redirect to a still-pinned host is followed.
3. **Host-bound credentials.** Operator-supplied (no silent default), bound to a
   host, re-resolved per hop (host A's token is never carried to host B), never in
   the agent's inputs, and redacted from all captured output.
4. **Bounded capture.** A wall-clock timeout and a response-body byte cap stop an
   untrusted server from hanging the call or inflating an observation.
5. **Untrusted inbound.** A fetched body is untrusted external content — treat it
   as `external_document`; it must not self-promote to a supported belief.

**What it does NOT claim:** it does not OS-sandbox the network, and it does not
resolve DNS to block private address ranges (a network sandbox we do not claim).
`fetch`/`request` reach the real host by design — that is the governed action.
The governance is host pinning + redirect re-validation + host-bound credentials
+ the **L4 human-approval gate** + treating inbound content as untrusted.

## License

Apache-2.0
