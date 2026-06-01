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
  /** Identifier of the client that drafted the note (e.g. "telenotes-web"). */
  clientTag?: string
}

/**
 * Build a draft Note. `createdAt` is injectable so callers (and tests)
 * stay deterministic; it defaults to the current time in seconds.
 * `clientTag` records which client drafted the note, if known.
 */
export function buildNote(
  content: string,
  tags: string[] = [],
  createdAt: number = Math.floor(Date.now() / 1000),
  clientTag?: string,
): Note {
  const note: Note = {
    content,
    createdAt,
    tags: [...tags],
  }
  if (clientTag !== undefined) note.clientTag = clientTag
  return note
}
