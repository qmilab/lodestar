import type { ChainProjection } from "./chain.js"

/**
 * JSON-safe serialization of a {@link ChainProjection}.
 *
 * This is a pure `Set → array` projection in the same family as
 * `projectChain` — no I/O, no read/verify logic. It graduated here from
 * `@qmilab/lodestar-viewer` (which re-exports it unchanged) so a read-side
 * consumer that only wants to JSON-serialize a projection need not depend on
 * the viewer's HTTP server (which drags in Elysia). It is the serializer the
 * stable `projectChain` contract points integrators at.
 */

/**
 * JSON-safe view of a {@link ChainProjection}.
 *
 * `projectChain()` returns `actor_ids` as a `Set<string>`, which
 * `JSON.stringify` serialises to `{}`. The wire DTO converts it to an
 * array. `raw_events` is dropped here — it is the heavy verbatim event
 * stream, available separately (the viewer fetches it through its dedicated
 * `/events` endpoint and the live SSE stream), so the chain payload stays
 * small even for long sessions.
 */
export interface WireProjection extends Omit<ChainProjection, "actor_ids" | "raw_events"> {
  actor_ids: string[]
}

/**
 * Map a {@link ChainProjection} to its JSON-safe wire shape. Pure.
 */
export function toWireProjection(projection: ChainProjection): WireProjection {
  const { actor_ids, raw_events: _raw_events, ...rest } = projection
  return { ...rest, actor_ids: [...actor_ids] }
}
