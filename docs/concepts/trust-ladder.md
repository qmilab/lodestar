---
title: "The trust ladder"
description: "How Lodestar rates an action's risk on a six-rung ladder, gates it through a typed contract and two-phase execution, and what enforces that today versus what the Policy Kernel will add."
---

# The trust ladder

Reading a file and pushing to `main` are not the same kind of act, and a trust
layer shouldn't treat them the same. Lodestar rates every
[action](epistemic-chain.md) on a **six-rung trust ladder** by how much of the
world it can disturb and how reversible it is.

## The six rungs

| Rung | Meaning | Examples |
| --- | --- | --- |
| **L0** | observe only — read state; never write or execute | `read_text_file`, `list_directory` |
| **L1** | suggest only — produce proposals; nothing reaches the world | draft a plan |
| **L2** | isolated artifact — generate in tempfs; no effect on project state | scratch output |
| **L3** | local reversible — modify project state with notification | `write_file`, `shell_test`, `git_commit` |
| **L4** | external / shared — requires approval | `git_push`, network calls, credentials, deploy |
| **L5** | prohibited — cannot run in this context, ever | — |

The jump from **L3 to L4** is the important one. L3 actions change local,
recoverable state. L4 actions reach outside the project — they push code, hit the
network, use credentials, deploy. They are the actions you cannot quietly undo,
and they are the ones an injected instruction most wants to trigger.

## The action contract

An action's rung isn't a loose label — it lives in a typed **action contract**
(`@qmilab/lodestar-core`) that the gate evaluates:

- `required_level` — the rung (L0–L5),
- `blast_radius` — `self` / `session` / `project` / `external`,
- `reversibility` — `reversible` / `compensable` / `irreversible`,
- `scope` — what resources it touches,
- `data_sensitivity` — `public` / `private` / `secret`,
- `preconditions` — checks that must hold for it to run safely.

The bias is conservative: anything with network effect, credential use,
publication, deploy, push, or signing defaults to **L4**. A tool's own minimum
trust level acts as a floor — a contract can't ask for *less* trust than the tool
it invokes requires.

## Two-phase execution

The Action Kernel never approves and runs in one motion. Execution is **two
phases**: preconditions are recorded at proposal time
(`expected_at_approval`) and **re-checked at execution time**
(`must_revalidate_at_execution`). If the world changed between approval and
execution — the git HEAD moved, a file was rewritten — the kernel re-arbitrates or
refuses. This closes the time-of-check/time-of-use gap that plain
approve-then-execute leaves open. (Tools that try to do work *before* approval are
bugs, not features.)

## What enforces the ladder today

This is where it's worth being precise about current state.

Today the gate is a **single auto-approve ceiling**. The `autoApprovePolicy`
preset auto-approves actions up to a configured rung (the CLI exposes this as
`--auto-approve-up-to <0..4>`); anything above the ceiling is **denied outright**.
Through the [MCP proxy](../reference/architecture.md), a denial isn't a transport
error — the proxy returns a synthetic tool result with `isError: true` and a
structured `_lodestar` payload, so the wrapped agent reads the refusal as a normal
response and can revise its plan rather than crashing.

In the demos, the ceiling sits at **L3**: the agent's reads, edits, tests, and
commits auto-approve, and the L4 `git_push` is held at the gate. That is the
`firewall verdict: HELD` you see in the
[poison run](../guides/get-started.md#run-the-poison-demo-watch-the-firewall-hold) —
the irreversible action the injection was steering toward never runs.

## What the Policy Kernel will add

The full trust ladder — graduated **action contracts**, an interactive
**human-in-the-loop approval workflow** for L4 actions, and OS-level **sandbox
enforcement** of the contract's declared profile — is the job of the **Policy
Kernel**, which is on the post-v1 roadmap and not yet built. Two honest caveats
for anyone running the proxy today:

- **There is no approval UI yet.** "Requires approval" means "denied at the
  ceiling." Treat `auto_approve_ceiling` as the real policy.
- **The `sandbox` declaration is intent, not enforcement.** The contract declares a
  sandbox profile, but in v0 no namespace/cgroup/container layer enforces it. Run
  downstream tools inside your own OS-level sandbox until the Policy Kernel lands.

The ladder, the contract schema, and the gate exist now; what the Policy Kernel
adds is the graduated enforcement and the approval surface on top of them.

## Related

- [The epistemic chain](epistemic-chain.md) — where actions and outcomes sit.
- [Sentinels and calibration](sentinels-and-calibration.md) — runtime monitors
  that observe (and, once the Policy Kernel lands, will gate).
- [Architecture reference](../reference/architecture.md) — the Action Kernel and
  the proxy topology.
