import type { ChainProjection } from "@qmilab/lodestar-trace"

/**
 * JSON-safe view of a {@link ChainProjection}.
 *
 * `projectChain()` returns `actor_ids` as a `Set<string>`, which
 * `JSON.stringify` serialises to `{}`. The wire DTO converts it to an
 * array. `raw_events` is dropped here — the viewer fetches raw envelopes
 * through the dedicated `/events` endpoint (and the live SSE stream), so
 * the chain payload stays small even for long sessions.
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
