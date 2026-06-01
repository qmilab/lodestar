# Documentation agent — Lodestar example

Lodestar's second proving ground (the low-cost one). It exercises the
**claim → evidence → belief** chain on real documentation content, beyond
the schema-bound `git.status` / `fs.read` extractors.

A small agent:

1. reads this example's own `README.md`, `package.json`, and a sample
   module `workspace/widget.ts` via a governed `doc.read` tool;
2. extracts **content claims** from what it read — "package depends on
   X@Y", "`renderWidget` takes `(props, options)`" — each linked to the
   source file it came from;
3. notices that `renderWidget`'s docstring is **stale** (it documents a
   `name` parameter the function no longer takes);
4. rewrites the docstring through a governed `doc.write` action.

Then `lodestar report` shows the whole chain — and crucially, **which
source backed each documentation claim**.

## Run it

```
bun run examples/documentation-agent/index.ts
```

The run prints a trust report. Re-render it any time from the event log:

```
lodestar report <session-id>
```

It is hermetic: it only ever writes `workspace/widget.ts`, a gitignored
working copy reset from `workspace/widget.template.ts` at the start of
each run. It never touches the real repo.

## What to look for in the report

- **Observations** — `doc.read` of each source file.
- **Claims** — content claims like *"Function `renderWidget` … takes
  parameters (props, options)."*
- **Evidence** — each claim's evidence item is `quality external_document`
  with `indep doc:workspace/widget.ts` and `from workspace/widget.ts`.
  That is the source → claim link the example is built to demonstrate.
- **Beliefs** — adopted at `truth_status: unverified`. File *content* is
  `external_document` evidence, so the Round 5 auto-observation gate
  refuses to silently promote it to `supported`. The docstring fix is
  honestly recorded as resting on *read-but-not-independently-verified*
  evidence.
- **Decisions** — `rewrite-docstring`, citing the signature belief as a
  `belief_dependency`.
- **Actions** — the governed `doc.write` that performed the correction.

## How it's wired

The example uses the headline `guard.wrap()` API and plugs a custom
`DocAwareEvidenceLinker` in through the `cognitive.evidenceLinkerFactory`
seam on `GuardConfig`:

```ts
const { result, session_id } = await run({
  /* … */
  cognitive: {
    evidenceLinkerFactory: ({ evidence, beliefs }) =>
      new DocAwareEvidenceLinker(evidence, beliefs),
  },
})
```

That seam is the general extension point: any example or product can
attach document-aware, MCP-aware, or LLM-driven evidence linking the same
way, without forking `wrap`. The `DocumentationExtractor` and
`DocAwareEvidenceLinker` are reusable pieces shipped in
`@qmilab/lodestar-cognitive-core`; the `documentation.source@1` observation
and the `doc.read` tool live in `@qmilab/lodestar-adapter-filesystem`.
