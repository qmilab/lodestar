# @qmilab/lodestar-core — CLAUDE.md

This package defines the epistemic chain primitives. Everything else in the monorepo depends on it.

## What lives here

- **Types** (`src/types/`) — TypeScript type definitions, organised by domain.
- **Schemas** (`src/schemas/`) — Zod runtime schemas matching the types.
- **Schema registry** (`src/registry.ts`) — runtime registration and lookup of observation schemas.
- **Crypto** (`src/crypto/`) — the shared Ed25519 signing primitive (ADR-0017).
  `canonical.ts` (`stableStringify` + `canonicalHashHex`); `signing.ts`
  (`signPayloadHash` / `verifyPayloadHashSignature` / `generateEd25519KeyPair` /
  `assertValidPublicKeys`, parameterised by a `makeError` factory + `subject`
  label); `probe-pack-signing.ts` (the `lodestar.probe-pack.json` canonical hash
  + sign/verify); `badge-signing.ts` (the verification-badge canonical hash +
  sign/verify, plus `assertBadgeAppliesTo` — the `manifest_hash` subject-binding
  check that defeats a mis-attached badge; ADR-0020, #89); `pack-index-signing.ts`
  (the discovery-index canonical hash + sign/verify, structurally identical to the
  badge/manifest signers; ADR-0021, #87). Pure `node:crypto`
  compute over the `Signature` type — the one audited implementation the
  approval-resolution path (`policy-kernel`), the pack manifest (`harness` loader),
  the badge path, and the discovery index all share, so no consumer copies crypto or
  grows an awkward cross-kernel dependency to verify a signature. The badge wire
  format itself lives in `src/schemas/pack-badge.ts` (the `probe_results` /
  `security_scan` discriminated union and the `badges/` layout constants), and the
  discovery-index format in `src/schemas/pack-index.ts` (the `PackIndex` listing +
  `index_publisher_keys` trust-root key), beside the manifest + registry schemas.

## Invariants

1. **No runtime behavior, with one narrow carve-out.** This package is types and
   schemas only — no I/O, no database, no HTTP, no mutable state — *except* the
   schema registry (`registry.ts`) and the pure cryptographic / canonicalisation
   primitives in `src/crypto/` (ADR-0017). Those use only `node:crypto` over
   core's own wire types and perform no I/O; they live here so every consumer
   shares one audited implementation. Do not add anything that reads a file, a
   socket, a database, or a clock.
2. **Zod and TypeScript types stay in sync.** When you add a type, add the Zod schema, and use `z.infer<typeof schema>` to derive the type from the schema. Never define them separately.
3. **No package-local imports.** This is the dependency root. Nothing in `@qmilab/lodestar-core` imports from `@qmilab/lodestar-*`.
4. **Backwards-compatible additions only after v0.2.** Until then, schema changes are free. Once we declare v0.2 stable, every schema change ships with a `schema_version` bump and a migration note.

## What does not live here

- Persistence: see `@qmilab/lodestar-event-log` and the Postgres adapters in respective packages.
- Tool registry: see `@qmilab/lodestar-action-kernel`.
- Policy evaluation: see `@qmilab/lodestar-policy-kernel`.
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
