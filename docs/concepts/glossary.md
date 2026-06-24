# Glossary

Short definitions for the recurring terms and acronyms used across
Lodestar's issues, ADRs, commit messages, and docs. If a term keeps
showing up and you have to pause to remember what it means, it belongs
here.

## AC — Acceptance Criteria

The checklist of concrete, testable conditions a piece of work must
satisfy before it can be considered **done and correct**. In a Lodestar
issue, the AC is the `- [ ]` list under an `## Acceptance criteria`
heading: each box is a single, verifiable statement — for example
*"Claims without a `structured_predicate` are excluded from the join"* —
that the implementation **and its probe** must demonstrably meet.

The AC is the contract between *what we said we'd build* and *what we can
prove we built*. We refer to individual items by number: **AC#1** is the
first box in that list, **AC#2** the second, and so on.

Two working rules:

- **An AC must be satisfiable and observable.** If, while scoping, an AC
  turns out to be impossible to satisfy as written (e.g. it asks a
  normalized score to do something normalization forbids), that is a
  scoping finding: surface it, propose a reframing, and fix the AC before
  writing code — don't quietly build something that can't meet it. (See
  ADR-0032 for a worked instance of exactly this.)
- **Probes are how AC are proven.** A probe in `packs/lodestar-core/`
  (or another pack) is the executable form of one or more AC. See
  [Probes are spec](../../CONTRIBUTING.md#probes-are-spec-not-test-scaffolding).

## ADR — Architecture Decision Record

A short, durable record of an **agent-facing** decision: how a piece of
work is being approached, what was deliberately deferred, and why. ADRs
live in [`.claude/adr/`](../../.claude/adr/) (numbered, Nygard-style:
context → decision → consequences → alternatives). They capture the
*how/when/why-this-order* of the work — the kind of reasoning that would
otherwise survive only in a chat transcript. They complement the
contributor-facing design locks in `docs/architecture/`, which describe
the *what* of the system (schemas, invariants). See
[`.claude/adr/README.md`](../../.claude/adr/README.md).

## Probe

An adversarial, executable specification of a security or correctness
invariant. Probes ship in packs (the first-party ones in
`packs/lodestar-core/` and `packs/coding-agent-safety/`) and run via the
harness (`lodestar harness run`). **A probe is spec, not test
scaffolding:** if a probe fails, the change is wrong — not the probe.
Each one should fail against the regression it guards and pass against
the fix. See
[Probes are spec](../../CONTRIBUTING.md#probes-are-spec-not-test-scaffolding).

## Parallax (auto-observation gate)

The Round 5 invariant that a claim sourced from a single piece of
`external_document` or `model_inference` evidence **cannot auto-promote**
to `truth_status: supported`. Promotion requires either independent
corroboration (multiple sources with genuinely different
`independence_group` values, at least one of a higher quality) or
explicit reflection/user authority. Implemented in
`packages/cognitive-core/src/core.ts` and preserved by every evidence
linker. Originally codenamed Orrery; see
`docs/architecture/v02-delta.md`.
