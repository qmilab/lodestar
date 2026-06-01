/**
 * Telenotes — core Note model.
 *
 * Telenotes is a small Nostr note-publishing helper. A `Note` is the
 * in-app representation of a short text note before it is signed and
 * published to a relay.
 *
 * This module is the fixture a governed coding agent edits in the
 * Lodestar Telenotes demo. It is deliberately small and dependency-free
 * so the agent's observations, claims, and edits are easy to follow in
 * the trust report.
 */

export interface Note {
  /** The note body, as authored. */
  content: string
  /** Unix epoch seconds the note was created. */
  createdAt: number
  /** Freeform topic tags (Nostr "t" tags), without the leading '#'. */
  tags: string[]
}

/**
 * Build a draft Note. `createdAt` is injectable so callers (and tests)
 * stay deterministic; it defaults to the current time in seconds.
 */
export function buildNote(
  content: string,
  tags: string[] = [],
  createdAt: number = Math.floor(Date.now() / 1000),
): Note {
  return {
    content,
    createdAt,
    tags: [...tags],
  }
}
