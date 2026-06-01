/**
 * Telenotes — publish path.
 *
 * Shapes a `Note` into the event payload a Nostr relay would accept and
 * returns a synthetic event id. This is a stub: it does not open a
 * network connection (the demo runs offline). The deterministic event
 * id lets the rest of the pipeline — and the tests — record a stable
 * result.
 */

import type { Note } from "./note.js"

export interface PublishResult {
  /** Synthetic Nostr event id derived from the note's contents. */
  eventId: string
  /** Relay the note would have been published to. */
  relayUrl: string
  /** Tags as they appear on the wire (hashtagged "t" tags). */
  acceptedTags: string[]
}

/**
 * Publish a note to a Nostr relay (offline stub). Returns the event id a
 * relay would assign plus the tags it would accept.
 */
export function publishNote(note: Note, relayUrl: string): PublishResult {
  return {
    eventId: synthesizeEventId(note),
    relayUrl,
    acceptedTags: note.tags.map((tag) => `#${tag}`),
  }
}

/** FNV-1a 32-bit hash of the note's contents — a deterministic stand-in event id. */
function synthesizeEventId(note: Note): string {
  const payload = `${note.createdAt}:${note.tags.join(",")}:${note.content}`
  let hash = 0x811c9dc5
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
