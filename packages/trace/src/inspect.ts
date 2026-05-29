import type { EventEnvelope } from "@qmilab/lodestar-core"

/**
 * Debug-grade inspection of a single event envelope.
 *
 * Returns a pretty-printed JSON description meant for `lodestar trace
 * inspect`. This is intentionally not the user-facing report — it's for
 * developers who already understand the schema.
 */
export function describeEvent(event: EventEnvelope): string {
  return JSON.stringify(event, null, 2)
}

/**
 * Locate an event in a stream by id, returning the envelope if found.
 * Pure function; the caller is responsible for loading the stream.
 */
export function findEventById(events: EventEnvelope[], id: string): EventEnvelope | undefined {
  return events.find((e) => e.id === id)
}
