---
title: "Wrap your own agent: guard.wrap(), the MCP proxy, policies, and probes"
description: "Part 3 — a hands-on guide to putting Lodestar around your own coding agent: the library path, the proxy path, writing a policy, and locking an invariant with a probe."
date: 2026-06-10
canonical_url: "https://qmilab.com/lodestar/docs/guides/part-3-wrap-your-own-agent/"
tags: [ai, llm, security, opensource, ai-agents, mcp]
series: "Lodestar: the trust layer for AI agents"
series_part: 3
---

<!--
Syndication note (for whoever publishes this). Front-matter MUST stay at the top
of the file or MkDocs/Jekyll render it as visible text instead of parsing it.
- Canonical home is the docs-site URL in `canonical_url` above. Every syndicated
  copy (dev.to, Hashnode) must set its canonical_url back to it.
- Self-contained markdown; code references use absolute GitHub links. No Mermaid
  in this part — it's code-block-heavy by design.
- Suggested syndication tags: #ai #llm #security #opensource
-->

# Wrap your own agent: guard.wrap(), the MCP proxy, policies, and probes

[Part 1](./walkthrough.md) showed the demos. [Part 2](./part-2-the-threat-model.md)
made the case to your security team. This part is the wiring guide: putting
Lodestar around **your** agent, today, with snippets that run as written.

Everything below works from a clone with [Bun](https://bun.sh):

```sh
git clone https://github.com/qmilab/lodestar
cd lodestar
bun install
```

(The packages are also on npm as `@qmilab/lodestar-*` at v0.2.0 — the clone
path is used here because it gives you the examples and probes to crib from.)

> **TL;DR** — Two ways in. Own the loop? `guard.wrap()` is a function call
> around your agent code. Don't own the agent (Claude Code, Cursor, Aider)?
> `lodestar guard mcp-proxy` sits between it and its MCP tools — no agent
> changes, but you must deny the agent's built-in tools so the governed path
> is the only path. Either way you grade your tools on the trust ladder, set
> an auto-approve ceiling (L4 *cannot* be auto-approved — the floor is not
> negotiable), resolve held actions with `lodestar approve` from a second
> terminal, and lock the invariant you care about with a probe that fails CI
> if it ever regresses.

---

## Two ways in

The decision is one question: **do you own the agent's loop?**

- **You wrote the loop** (a homegrown agent, a script that calls an LLM with
  tools): use **`guard.wrap()`**. It's a library call; your loop runs inside a
  governed context and every tool call flows through the kernel.
- **You don't own the agent** (Claude Code, Cursor, Aider — anything that
  speaks MCP): use the **MCP proxy**. The agent's MCP config points at the
  proxy; the proxy owns the real downstream servers and governs every
  `tools/call` in between. No changes to the agent.

The two paths produce the same thing: an append-only event log you can render
with `lodestar report <session-id>`, with the same policy gate and the same
memory-firewall semantics from part 2.

---

## Path 1: the greenfield loop — `guard.wrap()`

Here is the minimal real shape, as used by the
[`coding-agent-greenfield`](https://github.com/qmilab/lodestar/tree/main/examples/coding-agent-greenfield)
example:

```ts
import {
  wrap,
  autoApprovePolicy,
  alwaysHoldsChecker,
  type GuardContext,
} from "@qmilab/lodestar-guard"

// Your agent loop, unchanged except that tool calls go through ctx.
const agentLoop = async (ctx: GuardContext) => {
  // ctx.callTool(...)         — every tool call, routed through the Action Kernel
  // ctx.ingestObservation(...) — feed an observation through the Cognitive Core
  // ctx.recordDecision(...)   — declare a decision + the beliefs it depends on
  // ctx.emit(...)             — debug events (recorded, but never trusted for gating)
  return { done: true }
}

const run = wrap(agentLoop)

const { result, session_id, log_root } = await run({
  project_id: "my-agent",
  actor_id: "agent:mine",
  default_scope: { level: "project", identifier: "my-agent" },
  default_sensitivity: "internal",
  policy_gate: autoApprovePolicy({
    auto_approve_up_to: 2, // L0–L2 sail through; L4 always holds, L5 always denies
    approver_id: "policy-decider",
  }),
  precondition_checker: alwaysHoldsChecker,
})

console.log(`report: bun run lodestar report ${session_id}`)
```

Things to notice, because they're deliberate:

- **There are no silent defaults for the security-relevant settings.** Scope,
  sensitivity, the policy gate, the precondition checker — all explicit. If
  your policy can *hold* an action, you must also supply an
  `approval_resolver`; a hold with no resolver is a hard error at
  `callTool` time, not a silent auto-deny.
- **`ctx.emit()` is honest about its own trust level.** Raw agent emits are
  recorded for debugging but are *not* trusted to drive sentinel arbitration —
  an agent cannot talk its way past a belief-scoped alert by emitting noise.
  The trusted way to declare "this plan rests on these beliefs" is
  `ctx.recordDecision()`.
- **The result hands you the session.** `session_id` is exactly what
  `lodestar report` takes; `log_root` is where the NDJSON event log landed
  (default `.lodestar/events`).

### The extension seam: teaching the guard about your evidence

The [`documentation-agent`](https://github.com/qmilab/lodestar/tree/main/examples/documentation-agent)
example (part 1's warm-up demo) adds exactly one thing to the config above — a
custom evidence linker, through the `cognitive` seam:

```ts
const { result, session_id } = await run({
  // ... same required fields as above ...
  policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "doc-agent-policy" }),
  precondition_checker: alwaysHoldsChecker,
  cognitive: {
    evidenceLinkerFactory: ({ evidence, beliefs }) =>
      new DocAwareEvidenceLinker(evidence, beliefs),
  },
})
```

That one factory is what makes file *content* land as `external_document`
evidence (stamped with its source file, kept `unverified`) instead of being
quietly trusted — and it's the exact seam the
`documentation-evidence-provenance` probe from part 2 pins in CI. The same
seam takes an MCP-aware linker, or your own: anything that decides what
*quality* of evidence a claim's source amounts to.

If you want durable, cross-session state, the sibling `stores` seam injects
Postgres-backed claim/belief/evidence stores — that's the seam the
cross-session poisoning probe rides.

---

## Path 2: the agent you don't own — the MCP proxy

The proxy is a config file plus one command. Here's the shape of the real
config that drove the live Claude Code run in part 1
([`real-claude-code/proxy.config.json`](https://github.com/qmilab/lodestar/blob/main/examples/telenotes-governed-dev/real-claude-code/proxy.config.json),
trimmed):

```json
{
  "project_id": "telenotes-governed-dev-claude-code",
  "actor_id": "agent:claude-code",
  "session_id": "auto",
  "log_root": ".lodestar/events",
  "default_scope": { "level": "project", "identifier": "telenotes-governed-dev-claude-code" },
  "default_sensitivity": "internal",
  "auto_approve_ceiling": 3,
  "downstream_servers": [
    {
      "name": "fs",
      "command": "bunx",
      "args": ["@modelcontextprotocol/server-filesystem", "/absolute/path/to/workspace"]
    },
    {
      "name": "devtools",
      "command": "bun",
      "args": ["run", "/path/to/dev-tools-mcp/bin.ts", "/absolute/path/to/workspace"]
    }
  ],
  "tool_defaults": {
    "mcp.fs.read_text_file": {
      "reversibility": "reversible",
      "permissions": ["fs.read"],
      "sandbox": "read",
      "required_trust_level": 0,
      "blast_radius": "self"
    },
    "mcp.fs.write_file": {
      "reversibility": "compensable",
      "permissions": ["fs.write"],
      "sandbox": "write-local",
      "required_trust_level": 3,
      "blast_radius": "project"
    },
    "mcp.devtools.git_push": {
      "reversibility": "irreversible",
      "permissions": ["network.egress"],
      "sandbox": "controlled-shell",
      "required_trust_level": 4,
      "blast_radius": "external"
    }
  }
}
```

Read it top to bottom and you've read the governance story:

- **`downstream_servers`** — the proxy spawns these as child processes and
  re-exposes their tools upstream under namespaced names
  (`mcp.<server>.<tool>`). The agent sees one MCP server; the proxy sees
  everything.
- **`tool_defaults`** — *you* grade each tool: trust level, blast radius,
  reversibility, sandbox profile. The proxy deliberately ignores MCP
  annotations as a trust source — per the MCP spec they're untrusted unless
  the server is — so the grading is operator-authored, not taken from the
  wire. Any tool you didn't enumerate falls to a **conservative default**
  (L3, irreversible, controlled-shell), which you'll see in your report as a
  nudge to grade it explicitly.
- **`auto_approve_ceiling: 3`** — the gate from part 1: L0–L3 auto-approve,
  the L4 `git_push` is rejected (or held, once you add approvals — next
  section).

Start it, point your agent at it:

```sh
bun run lodestar guard mcp-proxy --config ./proxy.config.json
```

For Claude Code, the project's `.mcp.json` declares the proxy as the one MCP
server ([the committed example](https://github.com/qmilab/lodestar/blob/main/examples/telenotes-governed-dev/real-claude-code/.mcp.json)):

```json
{
  "mcpServers": {
    "lodestar": {
      "command": "bun",
      "args": [
        "run", "/path/to/lodestar/packages/cli/src/index.ts",
        "guard", "mcp-proxy",
        "--config", "/path/to/proxy.config.json"
      ]
    }
  }
}
```

### The caveat that matters: deny the built-ins

A real coding agent ships its own file and shell tools, and **those never
touch MCP** — if they stay enabled, the agent edits files directly and your
trust report comes back empty of write actions. The proxy can only govern
what flows through it. So launch the agent with built-ins denied and the
proxy allowed, exactly as part 1's live run did:

```sh
claude -p "<your task>" \
  --mcp-config .mcp.json --strict-mcp-config \
  --disallowedTools Edit Write MultiEdit NotebookEdit Bash Read Glob Grep LS WebFetch WebSearch \
  --allowedTools "mcp__lodestar__*" \
  --output-format text
```

This is stated as a caveat in the repo's own
[recipe](https://github.com/qmilab/lodestar/blob/main/examples/telenotes-governed-dev/real-claude-code/RECIPE.md),
and in part 2's honest-limits list, because it's the kind of thing a wrapper
should say out loud: **the governed path only governs if it's the only
path.**

---

## Writing a policy with real teeth

Both paths grade actions on the same six-rung **trust ladder**:

```
L0  observe only        — read state; never write or execute
L1  suggest only        — produce proposals; nothing reaches the world
L2  isolated artifact   — generate in tempfs; no effect on project state
L3  local reversible    — modify project state, with notification
L4  external / shared   — network, credentials, deploy, push — needs approval
L5  prohibited          — cannot run in this context, ever
```

The simple preset you've seen — `autoApprovePolicy` /
`auto_approve_ceiling` — is genuinely a one-rule policy document under the
hood ("allow at or below N" over a structural deny default). Two properties
are worth knowing before you write a bigger one:

- **The ceiling caps at L3.** Auto-approving L4 is *not expressible* — the
  trust-ladder floor always holds L4 for approval and always denies L5,
  regardless of any rule you write. A config asking for a ceiling of 4 fails
  at parse time. This is the floor part 2 leaned on: the block on the
  poisoned push never depended on a well-written rule.
- **Unmatched actions deny.** The structural default is deny, and a probe
  (`unmatched-action-defaults-to-deny`) pins it.

A fuller policy is a JSON document with ordered rules — first decisive match
wins, over the deny default:

```json
{
  "id": "my-team-policy",
  "version": "v1",
  "rules": [
    {
      "match": { "required_level_lte": 2 },
      "effect": "allow",
      "reason": "Reads, suggestions, isolated artifacts: free"
    },
    {
      "match": { "tool": "mcp.fs.write_file" },
      "effect": "allow",
      "reason": "Workspace writes are compensable here"
    },
    {
      "match": { "tool": "mcp.devtools.git_push" },
      "effect": "require_approval",
      "approval": {
        "required_authority": { "min_trust_baseline": 0.8 }
      },
      "reason": "Pushes need a human with sufficient standing"
    }
  ]
}
```

Wire it into the proxy with the `policy` block instead of the bare ceiling:

```json
"policy": { "file": "./my-team-policy.json", "allow_unsigned": true }
```

`allow_unsigned: true` is the development mode. For production the policy
document is **signed** (Ed25519 over the canonical hash of
`{id, version, rules}`), the proxy verifies it at load, and a
`require_approval` rule's `required_authority` travels with the held action —
so the eventual approver must actually clear the bar the rule set.

### Resolving a held action from a second terminal

With approvals configured, an L4 action doesn't just bounce — it parks at
`pending_approval` while the proxy polls for an out-of-band resolution:

```json
"approval_timeout_ms": 120000,
"approvals": {
  "authorized_keys": [
    { "actor_id": "nandan", "public_key": "-----BEGIN PUBLIC KEY----- …" }
  ]
}
```

Mint your approver key once, then resolve holds from any other terminal:

```sh
# one-time: mint an Ed25519 keypair; prints the authorized_keys pin to paste above
bun run lodestar approve keygen --approver nandan --out ~/.lodestar/nandan

# see what's parked
bun run lodestar approve list --project my-project

# let it through (or: approve deny <request-id> ... --reason "not today")
bun run lodestar approve grant <request-id> --approver nandan \
  --key ~/.lodestar/nandan.key --project my-project
```

The mechanics are worth one sentence each, because they're load-bearing: the
`approve` CLI runs in a **separate process** and never writes the event log —
it drops a signed resolution into a side-channel the proxy polls, and the
proxy (the log's single writer) promotes it to the canonical
`approval.granted@1` event. The signature is verified against the
operator-pinned keys before anything un-parks — a forged, unsigned, or
tampered grant is rejected, and the `forged-approval-cannot-execute` probe
holds that boundary in CI. And a granted approval still **revalidates the
action's preconditions** before execution; approval is not a skip-the-checks
pass.

If you time out instead (`approval_timeout_ms` elapses with no resolution),
the held action fails closed with a synthetic `approval_timeout` — the agent
sees a normal tool error, not a hung session.

---

## Locking your invariant with a probe

Everything above gives you governance at runtime. The last step is making
your guarantee **survive your own refactors**: write a probe — an adversarial
script that fails loudly if the invariant ever regresses — and run it in CI.
In Lodestar's own development, probes are treated as spec: 48 of them gate
every change, and the rule is you fix the code, never the probe.

A probe is a small class with a name, a description, and a `run()` that
returns pass/fail plus human-readable detail lines:

```ts
import { Probe, runProbeAsScript, type ProbeResult } from "@qmilab/lodestar-harness"

class MyInvariantProbe extends Probe {
  readonly name = "my-agent-cannot-exfiltrate-secrets"
  readonly description =
    "A belief sourced from .env content must never reach truth_status: supported"

  async run(): Promise<ProbeResult> {
    // Arrange: run your wrapped agent over a fixture with a planted marker.
    // Act:     query the belief store / event log it produced.
    // Assert:  no supported belief carries the marker.
    const breached = false // your real check here
    return breached
      ? { passed: false, details: ["MARKER found in a supported belief"] }
      : { passed: true, details: ["marker stayed unverified everywhere"] }
  }
}

runProbeAsScript(new MyInvariantProbe())
```

`runProbeAsScript` prints the banner and exits 0 on pass, non-zero on fail —
which is all CI needs. Group probes into a **pack** with a manifest:

```json
{
  "name": "my-agent-safety",
  "version": "0.1.0",
  "spec_version": "1",
  "source_type": "local",
  "description": "Invariants my agent's governance must never lose",
  "coverage_areas": ["memory_firewall"],
  "invariants": ["secrets_never_supported"],
  "probes": [
    { "name": "my-agent-cannot-exfiltrate-secrets", "file": "probes/no-exfil.ts" }
  ]
}
```

…and run the pack (the `--pack` flag takes a first-party pack name, a pack
directory, or a manifest path):

```sh
bun run lodestar harness run --pack ./my-agent-safety
```

For a template with real assertions against a real store, the four probes in
[`packs/coding-agent-safety/`](https://github.com/qmilab/lodestar/tree/main/packs/coding-agent-safety)
are the reference — each one is a standalone, readable script whose header
comment states the scenario, the assertions, and the non-claims. Start from
the one closest to your invariant and swap in your fixture.

Probe runs are themselves recorded as `synthetic`-trust observations in the
event log, so even your safety checks show up in the audit trail — honestly
labelled, like everything else.

---

## The whole loop, end to end

Putting it together, the integration checklist:

1. **Pick your path** — `guard.wrap()` if you own the loop, the MCP proxy if
   you don't.
2. **Grade your tools** — `tool_defaults` (or action contracts in code): trust
   level, blast radius, reversibility. Be honest; ungraded tools fall to a
   conservative default, visibly.
3. **Set the policy** — start with the ceiling preset; graduate to a rule
   document when you need per-tool nuance. L4 holds no matter what you write.
4. **Wire approvals** — `keygen` once, pin the public key, resolve holds with
   `approve grant/deny` from a second terminal.
5. **Read your first report** — `bun run lodestar report <session-id>`. Check
   the Beliefs section for the `supported`/`unverified` split doing its job on
   your own tools' output.
6. **Lock it** — write the probe for the one invariant you'd be embarrassed to
   lose, and put it in CI.

That's the series: part 1 showed it working, part 2 showed where the line
holds and where it honestly doesn't, and this part handed you the wiring. If
you wrap something real with it, [open an issue or discussion](https://github.com/qmilab/lodestar)
— the probe packs especially are designed to grow beyond first-party.
