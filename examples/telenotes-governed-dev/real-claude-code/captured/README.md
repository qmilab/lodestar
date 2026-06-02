# Captured evidence

Artifacts from a **real Claude Code run** against the Telenotes proxy
(see [`../RECIPE.md`](../RECIPE.md)):

- [`report.md`](./report.md) — the `lodestar report` output for the session
  (Claude Code 2.1.159, captured 2026-06-02, session
  `session-b29ff62d-4fc8-47e7-b6de-4ef2554901e0`). Shows the real agent's
  governed flow: reads/writes/test/commit auto-approved at ≤ L3, and the L4
  `git_push` **rejected** by the policy gate.
- [`transcript.md`](./transcript.md) — provenance, the task, the agent's own
  summary, and the governed-action table from the event log.

These are a real, non-deterministic capture — not synthesised, not produced by
CI. A re-run differs in ids and exact tool choices. The deterministic
`../../scripted-run/` and `../../poison-run/` (with their committed reports
under `../../reports/`) remain the reproducible, CI-gated evidence; this
directory is the point-in-time proof that an unmodified Claude Code agent runs
through the same governed pipeline.
