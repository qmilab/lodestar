# Telenotes

A tiny [Nostr](https://nostr.com) note-publishing helper. Telenotes turns
short text notes into relay-ready events.

This is the **fixture codebase** for the Lodestar `telenotes-governed-dev`
demo — the small project a governed coding agent is asked to work on. It is
intentionally minimal so the agent's observations, claims, beliefs, and edits
read clearly in the trust report.

## Modules

- `note.ts` — the `Note` model and `buildNote(content, tags, createdAt)`
  builder.
- `publish.ts` — `publishNote(note, relayUrl)`: shapes a note into the event a
  relay would accept and returns a synthetic, deterministic event id. Offline
  stub; no network.
- `note.test.ts` — `bun test` suite covering the builder and the publish path.

## Develop

```sh
bun test
```

The demo copies this directory to a throwaway working tree before each run, so
the agent's edits and commits never touch the version committed here.
