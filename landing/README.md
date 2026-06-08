# `landing/` — the `qmilab.com/lodestar/` landing page

This directory holds the static landing page served at the **root** of this
repo's GitHub Pages site, `https://qmilab.com/lodestar/`.

## Why it lives here

`qmilab.com` is the QMI Lab org Pages apex (served from `qmilab/qmilab.github.io`,
built from the private `qmilab/qmilab-site` Astro repo). When this repo enabled
its own GitHub Pages to publish the MkDocs docs, GitHub began serving the entire
`/lodestar/*` path from **this** repo's Pages artifact — a project site takes
precedence over the org site for its path prefix. The docs build lands at
`/lodestar/docs/`, but nothing was at `/lodestar/` itself, so the root 404'd and
the org site's landing page was shadowed.

The fix: this repo's Pages artifact now carries a root `index.html` too. The
`docs` workflow copies `landing/.` into the Pages artifact root
(`_site/`) before upload, alongside `_site/docs/` from MkDocs.

## What's here

- `index.html` — self-contained landing page. **All CSS is inlined** and the
  logo is vendored locally on purpose: the original Astro build linked the
  apex's hash-named stylesheet (`/_assets/global.<hash>.css`), and that hash
  changes on every org-site rebuild — a vendored copy referencing it would
  silently break. Favicons / web manifest / OG image stay apex-absolute because
  those are stable filenames the org site keeps serving.
- `logo.png` — the QMI Lab nav logo (vendored copy of the apex `logo.png`).

## Editing

This file is the source of truth for the landing page content. Edit
`index.html` directly — no build step. Pushing a change to `landing/**` on
`main` redeploys via `.github/workflows/docs.yml`.

> Note: the old source `src/pages/lodestar.astro` in `qmilab/qmilab-site` still
> builds an `/lodestar/index.html` into the org Pages artifact, but it is now
> permanently shadowed by this repo's Pages and is unreachable. It should be
> removed there to avoid drift (tracked as a follow-up in that repo).

## Do not

- Do **not** add a `CNAME` to this repo's Pages — it would override the
  inherited apex domain. (See the note in `.github/workflows/docs.yml`.)
- Do **not** re-link the apex's hash-named CSS. Keep the styles inlined.
