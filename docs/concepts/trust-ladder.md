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

Today the gate is the Policy Kernel's **three-valued gate** — `allow`, `deny`, or
`hold`. The `autoApprovePolicy` preset auto-approves actions up to a configured
rung (the CLI exposes this as `--auto-approve-up-to <0..3>`); above the ceiling an
action is **denied** — except **L4** (external/shared: push, deploy, spend,
publish), which the trust-ladder floor always **holds for approval**, and **L5**,
which is prohibited. L4 and L5 are not expressible auto-approve ceilings, which is
why the ceiling caps at L3. Through the [MCP proxy](../reference/architecture.md),
a denial isn't a transport error — the proxy returns a synthetic tool result with
`isError: true` and a structured `_lodestar` payload, so the wrapped agent reads
the refusal (or a held action's `approval_required`) as a normal response and can
revise its plan rather than crashing.

In the demos, the ceiling sits at **L3**: the agent's reads, edits, tests, and
commits auto-approve, and the L4 `git_push` is held at the gate. That is the
`firewall verdict: HELD` you see in the
[poison run](../guides/get-started.md#run-the-poison-demo-watch-the-firewall-hold) —
the irreversible action the injection was steering toward never runs.

## What the Policy Kernel adds

The **Policy Kernel** turns the declared ladder into enforced decisions: a
signed, declarative `Policy` document, the three-valued gate above, the approval
lifecycle, and the arbitrate hook that lets sentinel alerts and calibration flags
gate an action. It has landed, with both hold-resolution paths wired:

- **In-process (`guard.wrap()`):** a held L4 action opens an `ApprovalRequest`
  that an injected resolver (a human, an auto-rule, a test stub) answers,
  un-parking the action so it executes (or rejecting it).
- **MCP proxy:** a held action waits up to a configured `approval_timeout_ms`,
  polling the event log for an out-of-band `approval.granted@1` /
  `approval.denied@1`. On a grant it un-parks and runs the tool; on a deny or a
  deadline pass it returns a synthetic result (`approval_denied` /
  `approval_timeout`) the agent re-plans around. A timed-out hold is a soft
  denial to re-propose — durable resume of the same call is deferred.

Two honest caveats for anyone running the **proxy** today:

- **No reference resolver ships yet.** Until the `lodestar approve` CLI lands,
  *something* must write the out-of-band `approval.granted@1` (your own script,
  an approval UI). With `approval_timeout_ms` left at its default of 0 the proxy
  doesn't wait at all — it surfaces the hold as `approval_required` immediately.
- **The `sandbox` declaration is intent, not enforcement.** The contract declares a
  sandbox profile, but in v0 no namespace/cgroup/container layer enforces it. Run
  downstream tools inside your own OS-level sandbox until the sandbox runtime
  lands (it graduates with the shell adapter).

The ladder, the contract schema, the gate, the approval lifecycle, and both
hold-resolution paths exist now; what remains is the `lodestar approve` reference
resolver, the team approval surface, and OS-level sandbox enforcement.

## Related

- [The epistemic chain](epistemic-chain.md) — where actions and outcomes sit.
- [Sentinels and calibration](sentinels-and-calibration.md) — runtime monitors
  that observe; the Policy Kernel's arbitrate hook is what gives their alerts teeth.
- [Architecture reference](../reference/architecture.md) — the Action Kernel and
  the proxy topology.
