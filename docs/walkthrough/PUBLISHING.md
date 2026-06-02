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

Pick the long-term-stable URL as canonical and publish it **first** so search
engines attribute it correctly. Current canonical: the personal-site URL in
`walkthrough.md`'s front-matter (`nandan.me/writing/…`). When the docs site
exists, decide whether canonical moves there; if it does, update every copy's
`canonical_url`. Every syndicated copy must point `canonical_url` back to the
canonical — otherwise duplicates compete.

## Render the diagrams (once per change)

The article uses inline Mermaid, which renders on GitHub and most docs-site
generators (Docusaurus, Starlight, MkDocs-Material with the mermaid plugin).
Platforms that do **not** render Mermaid (dev.to, Hashnode, Medium) need images:

```sh
# one-off: bun add -d @mermaid-js/mermaid-cli   (or: npx @mermaid-js/mermaid-cli)
cd docs/walkthrough/assets
for f in two-belief-split proxy-topology policy-ladder; do
  mmdc -i "$f.mmd" -o "$f.png" -b transparent
done
```

Commit the PNGs alongside the `.mmd` sources so the dev.to copy's
`raw.githubusercontent.com/...` image URLs resolve.

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
4. Confirm `canonical_url` points at the personal-site URL.

### Hashnode (optional)

Import or paste; set the **Canonical URL** field to the personal-site URL. Embed
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

## Video

Script: [`video-script.md`](./video-script.md). Record the asciinema casts named
in its checklist, publish to YouTube, embed on the personal site, and embed the
`example:telenotes:poison` cast in the article body.

## Accuracy guardrails (carry into every copy and the video)

Same as [`BRIEF.md`](./BRIEF.md): don't present the real-Claude-Code capture as
deterministic; don't say a sentinel "halted" anything (sentinels are
non-blocking, the calibrator only measures); `shell_test` is epistemic/audit +
policy-gate, not OS isolation; nothing gates the solo-dev workflow.
