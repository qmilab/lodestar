# @qmilab/lodestar-core

Schemas and types for the Lodestar epistemic chain. Part of
[Lodestar](https://qmilab.com/lodestar) — the trust layer for AI agents.

Every other Lodestar package depends on this one. If you're building
directly on Lodestar's primitives (claims, evidence, beliefs,
decisions, actions, outcomes, revisions, the event envelope), this is
the package you import from.

## Install

```sh
npm install @qmilab/lodestar-core
# or
bun add @qmilab/lodestar-core
```

## Usage

Every schema and type is re-exported from the package root. Import
from `@qmilab/lodestar-core` directly — there are no subpath imports.

```ts
import { ClaimSchema, type Claim, registry } from "@qmilab/lodestar-core"

// Validate a candidate Claim against the schema. Zod's parse throws
// on invalid input; safeParse returns a Result. Lodestar uses safeParse
// at every package boundary.
const candidate: unknown = {
  id: crypto.randomUUID(),
  statement: "Current branch is 'main'",
  source_observation_ids: ["obs-1"],
  extraction_method: "tool",
  extracted_by: "agent-1",
  status: "extracted",
  scope: { level: "project", identifier: "my-project" },
  sensitivity: "internal",
  authors: ["agent-1"],
  created_at: new Date().toISOString(),
}

const parsed = ClaimSchema.safeParse(candidate)
if (!parsed.success) {
  throw new Error(`invalid claim: ${parsed.error.message}`)
}
const claim: Claim = parsed.data

// The observation-schema registry: register your tool's output schema
// once at module load, then the Action Kernel validates tool outputs
// against it before they enter cognition.
//
// registry.register("my.tool@1", MyOutputSchema)
```

## What's in here

- `Observation`, `Claim`, `EvidenceSet`, `Belief`, `Decision`,
  `Action`, `Outcome`, `Revision`, `Explanation` — the eight links of
  the epistemic chain plus the rationale type that binds them.
- `ContextPolicy`, `ActionContract`, `Sensitivity`, `ResourceScope`,
  and the four orthogonal belief lifecycle axes (truth, retrieval,
  security, freshness).
- `EventEnvelope` — the append-only NDJSON event-log envelope every
  Lodestar event is wrapped in.
- A schema registry (`registry`) for tool output schemas.

Each type has both a Zod schema (e.g. `ClaimSchema`) and a TypeScript
type alias derived via `z.infer` (e.g. `Claim`). The Zod schemas are
the source of truth; the types are derived.

## What's not in here

No runtime behaviour. This package is pure types + schemas. The
governance components live in their own packages:

- `@qmilab/lodestar-event-log` — append-only event log writer / reader
- `@qmilab/lodestar-action-kernel` — tool registry + two-phase action execution
- `@qmilab/lodestar-memory-firewall` — claim/belief lifecycle gates
- `@qmilab/lodestar-cognitive-core` — claim extraction + belief adoption
- `@qmilab/lodestar-guard` — the `wrap()` helper that ties it all
  together for an agent loop
- `@qmilab/lodestar-trace` — `lodestar report <session-id>` from the log

## License

[Apache 2.0](./LICENSE).
