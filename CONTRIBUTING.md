# Contributing to Lodestar

Thanks for thinking about contributing. Lodestar is a small project
that takes correctness seriously, so this guide is short and concrete.

## Before opening a PR

1. Open an issue first for anything beyond a typo or one-line fix. The
   architecture is locked at v0.2 + Round 5 fixes; the locked decisions
   are listed in [`CLAUDE.md`](./CLAUDE.md). If your change touches one
   of those, surface it as a design discussion before writing code.
2. Make sure you've read the relevant package's `CLAUDE.md` — every
   package has its own. They state the local invariants more precisely
   than this file can.

## Stack and conventions

- **Runtime / package manager**: [Bun](https://bun.sh). Not Node, not
  pnpm.
- **Language**: TypeScript, strict mode, `noUncheckedIndexedAccess` on.
  No `any`. No `as unknown as`. Use Zod's `safeParse` at every
  package boundary.
- **Schema validation**: Zod. Every public API takes Zod-validated input
  and returns Zod-validated output.
- **No `console.log` in production code paths.** The append-only event
  log is the observability channel.
- **No silent defaults for security-relevant settings.** Sandbox profile,
  sensitivity ceiling, trust level, policy gate, precondition checker —
  all explicit at the call site.

## Probes are spec, not test scaffolding

The probes in `packs/lodestar-core/probes/` describe the security and
correctness invariants Lodestar is built to defend. **If a probe fails, the change
is wrong — not the probe.** Do not edit a probe to match changed code;
either the change is broken, or the invariant has shifted (in which
case raise it as a design discussion before touching the probe).

When you add new behavior, add a probe that exercises it under
adversarial conditions. The `guard_contract_invariants` probe is a good
shape to mimic — it bundles related sub-cases A, B, C... and each one
must be verified to fail against its specific regression before passing
against the fix.

## Local development

```sh
bun install                       # workspace install
bun run typecheck                 # strict-TS check across all packages
bun run probes:all                # all 17 probes must stay green
bun run example:telenotes         # 11-event audit trail (regression check)
bun run examples/coding-agent-greenfield/index.ts
                                  # guard.wrap() demo end-to-end
bun run lodestar help             # CLI surface
```

## PR expectations

- One concept per PR. A bug fix doesn't need surrounding cleanup; a
  rename doesn't need a refactor.
- The branch must pass `bun run typecheck` and `bun run probes:all`.
  CI will run both once it's wired up; until then, run them locally.
- Commit messages: imperative subject, short body explaining the *why*
  rather than the *what*. Match the style of recent commits on `main`.
- Don't rewrite published history. Don't force-push to `main`.

## What's in scope vs. out of scope

In scope for this repository:

- The epistemic chain primitives, governance components, adapters,
  probes, and examples — anything that serves the thesis "what did
  the agent observe / believe / decide / do."
- Open-source under Apache 2.0.

Out of scope (handled elsewhere):

- Hosted dashboards, team approval workflows, compliance exports,
  enterprise policy packs, managed marketplace — reserved for a
  future commercial offering from Machinise, in a separate private
  repository. See [`docs/positioning.md`](./docs/positioning.md) §4.
- Telenotes-specific code — lives in
  `examples/telenotes-governed-dev/`, not in `packages/`.

## Reporting security issues

Memory poisoning, prompt-injection bypasses of the firewall, ways to
trick the Action Kernel into running outside its sandbox — anything
that breaks an invariant a probe defends — please report privately to
the maintainer (see the contact info in the project's GitHub profile)
before opening a public issue. Lodestar's whole point is to be the
layer that catches these, so finding one is genuinely useful.

## License

Lodestar is licensed under [Apache 2.0](./LICENSE). By contributing,
you agree your contributions are licensed under the same terms.
