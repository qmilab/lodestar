# Publishing runbook — the walkthrough (and the series)

How to take `walkthrough.md` from repo to its co-primary homes and syndicated
copies without two copies fighting for SEO. Reusable for parts 2–3 of the
series.

## Source of truth

- **`walkthrough.md`** is canonical content. Edit it; everything else derives.
- **`walkthrough.devto.md`** is a generated copy (dev.to front-matter + Mermaid
  swapped for images). Regenerate it whenever `walkthrough.md` changes — don't
  hand-maintain two prose copies.
- Diagram sources live in **`assets/*.mmd`**; rendered images are generated, not
  authored.

## Canonical-first rule

Publish the canonical **first** so search engines attribute it correctly. This
guide's canonical is the **docs-site URL** in `walkthrough.md`'s front-matter
(`qmilab.com/lodestar/docs/guides/walkthrough/`). Every syndicated copy (dev.to,
Hashnode) must point `canonical_url` back to it — otherwise duplicates compete.

Note the two-piece model: nandan.me carries a *separate* first-person motivation
essay (canonical there), which links to this guide. nandan.me does **not** host a
copy of this guide, so they never compete.

## Render the diagrams (once per change)

The article uses inline Mermaid, which renders on GitHub and most docs-site
generators (Docusaurus, Starlight, MkDocs-Material with the mermaid plugin).
Platforms that do **not** render Mermaid (dev.to, Hashnode, Medium) need images:

```sh
# one-off: bun add -d @mermaid-js/mermaid-cli   (or: npx @mermaid-js/mermaid-cli)
cd docs/guides/assets
for f in two-belief-split proxy-topology policy-ladder; do
  mmdc -i "$f.mmd" -o "$f.png" -b transparent
done
```

Commit the PNGs alongside the `.mmd` sources so the dev.to copy's
`raw.githubusercontent.com/...` image URLs resolve.

## Terminal cast (the poison run)

The `firewall verdict: HELD` cast is committed at
`docs/guides/assets/telenotes-poison.cast` (asciicast v2). It's a curated,
faithful snapshot — the verbatim `[agent]` step log and the real verdict block,
with the throwaway workspace path genericised — generated from a real run, not a
raw recording (which carries bun-install noise and local temp/home paths).

```sh
# regenerate the cast (intentional snapshot, like the committed reports):
bun run docs/internal/walkthrough/build-poison-cast.ts
# render the repo/dev.to/Medium GIF + an animated SVG (needs agg + svg-term):
agg --theme monokai --font-size 14 docs/guides/assets/telenotes-poison.cast docs/guides/assets/telenotes-poison.gif
svg-term --in docs/guides/assets/telenotes-poison.cast --out docs/guides/assets/telenotes-poison.svg --window --width 98 --height 30
```

Where each form is used:
- **Docs site** — interactive asciinema-player (the `.cast`), wired via the CDN
  player in `mkdocs.yml` + `docs/assets/asciinema-init.js`.
- **GitHub / README** — the `.gif` (GitHub renders animated GIFs inline; it can't
  run the player).
- **dev.to** — upload the cast to asciinema.org and embed with `{% asciinema <id> %}`,
  or use the `.gif`.
- **Medium** — the `.gif` (or a YouTube link).

To swap in a true `asciinema rec` recording instead of the curated cast: warm the
dep cache first (`bun run example:telenotes:poison` once), then
`asciinema rec --overwrite --cols 98 --rows 30 -c 'bun run example:telenotes:poison >/tmp/r.md' docs/guides/assets/telenotes-poison.cast`,
and redact the temp/home paths from the resulting JSON before committing.

## Per-platform checklist

| Step | Repo / docs-site | dev.to | Hashnode | Medium |
| --- | --- | --- | --- | --- |
| Front-matter | Jekyll block in `walkthrough.md` | dev.to block in `walkthrough.devto.md` | set Canonical URL field | use Import tool |
| Mermaid | inline (renders) | image embed (done in devto copy) | image embed | image embed |
| asciinema | embed script | `{% asciinema <id> %}` | iframe/embed | GIF or YT link |
| Links | absolute GitHub (already) | absolute (already) | absolute | absolute |
| Tables | fine | fine | fine | mangled → image |
| Canonical | n/a (is canonical) | `canonical_url` back | Canonical URL back | auto via Import |

### dev.to

1. Render + commit the PNGs (above) so the cover and inline images resolve.
2. Copy `walkthrough.devto.md` into a new dev.to article (front-matter is
   already in dev.to format). Tags: max 4, no `#`.
3. Leave `published: false` until ready; flip to `true` to publish.
4. Confirm `canonical_url` points at the docs-site URL
   (`qmilab.com/lodestar/docs/guides/walkthrough/`).

### Hashnode (optional)

Import or paste; set the **Canonical URL** field to the docs-site URL. Embed
the same PNGs.

### Medium (skip unless targeting a publication)

Use Medium's **Import a story** tool with the canonical URL — it sets
`rel=canonical` automatically. Never hand-paste (tables break; no canonical).

## Distribute (not publish)

These point at the canonical/repo; they are not new copies:

- **Show HN** — article + repo. Lead with the `firewall verdict: HELD` hook.
- **MCP community / `awesome-mcp`** — the proxy angle.
- **X / Bluesky thread** — the poisoned-file → HELD moment is the hook; embed the
  asciinema cast or a GIF.
- **Targeted subreddits** — r/LocalLLaMA, r/MachineLearning (be norm-aware).

### Headline variants (canonical H1 stays fixed)

The in-post **canonical H1 / slug never changes** (SEO): *"Wrap your coding
agent, get a trust report"* →
`qmilab.com/lodestar/docs/guides/walkthrough/`. For distribution, use a
punchier headline that **links back to that same canonical URL** — a second post
title would split SEO; a different *link headline* does not. Marketing back
pocket:

- **Hook (Show HN / X / Bluesky):** *"Your coding agent read a poisoned file.
  Here's why it didn't matter."*
- **Idea-forward (HN title / cross-post headline):** *"Reading isn't believing:
  a trust layer for AI coding agents."*
- **Provocation (thread opener / Reddit):** *"What did your coding agent actually
  believe?"*

Same pattern for parts 2–3: one stable canonical H1, several distribution
headlines pointing home.

## Video

Script: [`video-script.md`](./video-script.md). Record the asciinema casts named
in its checklist, publish to YouTube, embed on the personal site, and embed the
`example:telenotes:poison` cast in the article body.

## Accuracy guardrails (carry into every copy and the video)

Same as [`BRIEF.md`](./BRIEF.md): don't present the real-Claude-Code capture as
deterministic; don't say a sentinel "halted" anything (sentinels are
non-blocking, the calibrator only measures); `shell_test` is epistemic/audit +
policy-gate, not OS isolation; nothing gates the solo-dev workflow.
