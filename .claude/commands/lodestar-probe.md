---
description: Run a specific harness probe and report the outcome
---

You are operating inside the Lodestar monorepo. The user has requested probe execution: `$ARGUMENTS`.

Your job is to:

1. Locate the probe under `research/probes/` matching the name (case-insensitive, with or without `.ts` extension).
2. If multiple match, list them and ask which one.
3. If none match, list available probes and ask.
4. Read the probe's setup, trigger, and assertion.
5. Execute the probe (use `bun run research/probes/<name>.ts`).
6. Capture the probe's output and any events it emitted to the log.
7. Report:
   - What the probe was testing.
   - The setup it created.
   - The trigger condition it injected.
   - The assertion result (passed / failed).
   - Any side observations worth noting.

If the probe failed, do not skip past it. Explain what was expected, what was observed, and what the failure implies for the architecture. A probe failure is data, not noise.

If the probe modifies persistent state, ensure the demo runs in an isolated sandbox or with a cleanup step.
