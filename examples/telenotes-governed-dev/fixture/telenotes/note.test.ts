import { expect, test } from "bun:test"
import { buildNote } from "./note.js"
import { publishNote } from "./publish.js"

test("buildNote captures content and defaults to no tags", () => {
  const note = buildNote("gm nostr", [], 1_700_000_000)
  expect(note.content).toBe("gm nostr")
  expect(note.tags).toEqual([])
  expect(note.createdAt).toBe(1_700_000_000)
})

test("buildNote copies the tags it is given (no shared reference)", () => {
  const tags = ["intro"]
  const note = buildNote("hello", tags, 1_700_000_000)
  tags.push("mutated")
  expect(note.tags).toEqual(["intro"])
})

test("publishNote hashtags the tags and returns the relay url", () => {
  const note = buildNote("hello", ["intro", "nostr"], 1_700_000_000)
  const result = publishNote(note, "wss://relay.example")
  expect(result.acceptedTags).toEqual(["#intro", "#nostr"])
  expect(result.relayUrl).toBe("wss://relay.example")
})

test("publishNote assigns a stable event id for identical notes", () => {
  const note = buildNote("hello", ["intro"], 1_700_000_000)
  const first = publishNote(note, "wss://relay.example")
  const second = publishNote(note, "wss://relay.example")
  expect(first.eventId).toBe(second.eventId)
  expect(first.eventId).toMatch(/^[0-9a-f]{8}$/)
})
