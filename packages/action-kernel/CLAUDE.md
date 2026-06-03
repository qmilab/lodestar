# @qmilab/lodestar-action-kernel — CLAUDE.md

The runtime gate every tool call passes through. Separates *describing* an intended action (the `ActionContract`) from *executing* it, so a `PolicyGate` and `PreconditionChecker` can refuse the action before it touches the world.

## What lives here

- **Registry** (`src/registry.ts`) — `registerTool()` / `lookupTool()`. Tools are pure data plus an `execute` function; the kernel validates inputs at propose time and outputs against the registered output schema after execute.
- **Kernel** (`src/kernel.ts`) — the two-phase `propose → arbitrate → execute` flow, TOCTOU defense via precondition revalidation, and the `KernelContext` that supplies `session_id` / `project_id` to tools and observations. `arbitrate()` is three-valued: a gate that returns `requires_human_approval` parks the action at `pending_approval` (no `ApprovalEvent` yet), and `resolve(action, outcome)` un-parks it to `approved`/`rejected`. The kernel applies the outcome; the Policy Kernel decides it (`ApprovalOutcome`). `sensitivityForContract` (the 3→4-value action-sensitivity map) is exported for the Policy Kernel to build an `ApprovalRequest`.

## Invariants

1. **No tool runs without a contract.** `propose()` is mandatory and validates inputs against the tool's Zod schema exactly once. Re-parsing inputs downstream is forbidden — Zod schemas with `.transform` / `.preprocess` are not necessarily idempotent.

2. **Two-phase execution is enforced by phase.** `arbitrate()` only runs from `proposed`; `execute()` only runs from `approved`; `resolve()` only runs from `pending_approval`. The kernel throws on out-of-order transitions rather than silently re-routing. A `pending_approval` action is a *pre-execution* wait — `execute()` refuses it exactly as it refuses `proposed`, so a held action cannot touch the world until `resolve()` un-parks it to `approved`.

3. **Tool-declared preconditions cannot be dropped.** The kernel merges tool preconditions with the caller's contract; the caller can only add, not remove. Otherwise a caller could submit an action with a stripped-down contract and bypass safety checks the tool intended.

4. **Preconditions are re-validated at execution time.** Any precondition with `must_revalidate_at_execution: true` is re-checked immediately before `tool.execute` runs. If it no longer holds, the action is rejected even if it was previously approved (TOCTOU defense).

5. **Outputs are validated against the registered schema.** A tool returning a value that doesn't match its `output_schema_key` raises a structural error rather than entering cognition.

6. **No silent stub fallback for session/project (Round 5, pre-Batch 3).** The kernel takes a required `KernelContext` argument: either a `ToolContextResolver` function, a static `{ session_id, project_id }` pair, or `{ useStubsForTests: true }`. The old behavior — silently substituting `"session-stub"` / `"project-stub"` when no resolver was supplied — was a real bug for any host scoping side effects by session, and an unconditional bug for the MCP proxy (Batch 3) where every action must tie back to the real MCP-client session. Tests opt in to the stubs explicitly; production cannot reach them.

## What does not live here

- Policy semantics: see `@qmilab/lodestar-policy-kernel` — it ships a real `PolicyGate` via `compile(policy)` (ladder floor, ordered rules, deny default, signature checks) and produces the `ApprovalOutcome` that `resolve()` applies. The kernel still only sees the function; it never imports the Policy Kernel.
- Cognitive ingestion of observations: see `@qmilab/lodestar-cognitive-core`.
- Sandbox enforcement at the OS level: see the eventual sandbox runtime in the proxy.

## When you add a new tool

1. Define the Zod input + output schemas in the tool's package, plus register the output schema in `@qmilab/lodestar-core`'s schema registry.
2. Call `registerTool({...})` with the explicit `sandbox`, `permissions`, `effects`, `reversibility`, and `required_trust_level`. Silent defaults for security-relevant settings are forbidden.
3. Construct the kernel in the host (Guard / MCP proxy / example) with an explicit `KernelContext` — never rely on `useStubsForTests` outside of probe scaffolding.
