# @orrery/core — CLAUDE.md

This package defines the epistemic chain primitives. Everything else in the monorepo depends on it.

## What lives here

- **Types** (`src/types/`) — TypeScript type definitions, organised by domain.
- **Schemas** (`src/schemas/`) — Zod runtime schemas matching the types.
- **Schema registry** (`src/registry.ts`) — runtime registration and lookup of observation schemas.

## Invariants

1. **No runtime behavior.** This package is types and schemas only. No I/O, no database, no HTTP.
2. **Zod and TypeScript types stay in sync.** When you add a type, add the Zod schema, and use `z.infer<typeof schema>` to derive the type from the schema. Never define them separately.
3. **No package-local imports.** This is the dependency root. Nothing in `@orrery/core` imports from `@orrery/*`.
4. **Backwards-compatible additions only after v0.2.** Until then, schema changes are free. Once we declare v0.2 stable, every schema change ships with a `schema_version` bump and a migration note.

## What does not live here

- Persistence: see `@orrery/event-log` and the Postgres adapters in respective packages.
- Tool registry: see `@orrery/action-kernel`.
- Policy evaluation: see `@orrery/policy-kernel`.
- Telenotes-specific extensions: see `examples/telenotes-governed-dev/`.

## File layout

```
src/
├── index.ts                  # public exports
├── registry.ts               # schema registry
├── types/
│   ├── index.ts
│   ├── actor.ts              # Actor, Signature, ResourceScope
│   ├── observation.ts        # Observation
│   ├── claim.ts              # Claim, EvidenceItem, EvidenceSet
│   ├── belief.ts             # Belief, lifecycle axes, ContextPolicy
│   ├── decision.ts           # Decision, DecisionOption
│   ├── action.ts             # Action, ActionContract, ActionPrecondition, Outcome
│   ├── revision.ts           # Revision
│   ├── explanation.ts        # Explanation
│   ├── memory.ts             # Memory, transfer_policy
│   ├── skill.ts              # Skill, SkillBody, ReviewEvent
│   ├── incident.ts           # Incident
│   ├── event.ts              # EventEnvelope
│   └── common.ts             # Sensitivity, Predicate, etc.
└── schemas/
    └── (parallel to types/)
```

## When adding a new type

1. Add the Zod schema under `src/schemas/` first.
2. Derive the TypeScript type with `z.infer`.
3. Export both from `src/index.ts`.
4. Add a registry entry if it's an observation schema.
5. Document the field's purpose in the schema's `.describe()` call.
