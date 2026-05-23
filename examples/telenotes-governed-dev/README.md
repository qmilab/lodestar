# Telenotes governed development — reference demonstration

Status: scaffold. Real demo lands in week 8.

This example shows how to use Orrery to govern an agent that performs development work on the Telenotes codebase (or any codebase). It is a *reference demonstration*, not a core package. Nothing here is imported by `@orrery/core` or other workspace packages.

## What this demonstrates

By week 8, this example produces the thesis-validation trace described in `docs/architecture/v01-design.md` §11.1:

1. Agent reads a GitHub issue (`Observation`).
2. Agent inspects repo state (`Claim` → `Belief: supported`).
3. Agent proposes a change (`Decision` over options, with `Explanation`).
4. Policy allows L3 local write to feature branch; blocks L4 push without approval.
5. Agent claims tests pass (`Belief` with `calibration_class`).
6. Calibrator records claim vs eventual outcome.
7. Synthetic poisoned memory is injected; Memory Firewall rejects retrieval.
8. Sentinel halts a synthetic anomalous action mid-execution.
9. PR (L4) opens only after explicit approval.
10. Final report exports the full epistemic chain trace.

## What this is NOT

- Not a Telenotes feature.
- Not part of the Orrery core architecture.
- Not the only example — other Playground projects (AstroLLM research workflows, Machinise governance) get their own demos later.

## Layout

```
telenotes-governed-dev/
├── README.md              # this file
├── index.ts               # entry point for `bun run example:telenotes`
├── policy.orrery.ts       # the trust policy for this project
└── probes/                # Telenotes-specific probes (memory poisoning, etc.)
```

## Running the week-1 stub

```bash
bun run example:telenotes
```

In week 1, this just exercises the CLI with the fs.read and git.status adapters. The full thesis demo arrives in week 8.
