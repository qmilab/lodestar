# Doc Insight — a tiny Lodestar demo

A 350-line example that shows Lodestar's memory firewall distinguishing
between **what a document objectively contains** and **what an agent
thinks the document means**.

## What it does

Reads a markdown file and runs two extractors over it:

1. **Structural extractor** — counts headings, code blocks, links, and
   words by deterministic parsing. Produces claims with `tool_result`
   evidence quality.
2. **Semantic extractor** — pretends to be an LLM and produces topic
   judgments ("this doc is about release-management") and content
   judgments ("this doc contains author recommendations"). Produces
   claims with `model_inference` evidence quality.

Both claim sets flow into the cognitive core, which proposes belief
adoption to the memory firewall. The firewall's `auto_observation`
gate behaves differently for each kind of evidence:

- **`tool_result` evidence** → belief is adopted with
  `truth_status: supported` and `confidence: 0.9`.
- **`model_inference` evidence** → the firewall refuses to silently
  promote. The belief is adopted with `truth_status: unverified`,
  `confidence: 0.4`, and the transition is recorded as `reflection`
  authority rather than `auto_observation`.

The final trace report makes the gate's behaviour visible: you can see
which claims became supported beliefs, which stayed unverified, and
the firewall's reason for blocking auto-promotion.

## Why this matters

Most agent runtimes treat "what the LLM said about the document" and
"what the parser measured about the document" as the same kind of
truth. They aren't.

The parser produces the same heading count for the same file every
time. An LLM's topic judgment, by contrast, can shift with prompt
phrasing, model version, or adversarial framing of the document
itself. Lodestar's firewall encodes this difference structurally: model
output can become a *claim* the agent reasons over, but it cannot
become a *settled belief* without something stronger backing it up.

This is the core protection against the class of memory poisoning
attacks where an attacker plants language in an external document
that an agent reads, the agent extracts "claims" from it, and those
claims silently become trusted facts that influence later decisions.

## Run it

```sh
bun run examples/doc-insight/index.ts examples/doc-insight/sample.md
```

You can also pass your own markdown file:

```sh
bun run examples/doc-insight/index.ts path/to/your/doc.md
```

## Expected output

```
# Lodestar trust report — Doc Insight

**Document**: `examples/doc-insight/sample.md`
**Observed**: 6 heading(s), 3 code block(s), 0 link(s), 116 words, 832 bytes

## Claims extracted

- (structural) Document 'examples/doc-insight/sample.md' has 6 heading(s)
- (structural) Document 'examples/doc-insight/sample.md' has 3 code block(s)
- (structural) Document 'examples/doc-insight/sample.md' has 116 words
- (semantic) Document 'examples/doc-insight/sample.md' is about 'release-management'
- (semantic) Document 'examples/doc-insight/sample.md' contains author recommendations

## Beliefs adopted

- **[supported]** Document 'examples/doc-insight/sample.md' has 6 heading(s) (confidence 0.90)
- **[supported]** Document 'examples/doc-insight/sample.md' has 3 code block(s) (confidence 0.90)
- **[supported]** Document 'examples/doc-insight/sample.md' has 116 words (confidence 0.90)
- **[unverified]** Document 'examples/doc-insight/sample.md' is about 'release-management' (confidence 0.40)
- **[unverified]** Document 'examples/doc-insight/sample.md' contains author recommendations (confidence 0.40)

## Why some claims did not auto-promote

These claims came from a simulated LLM extractor. The evidence is
`model_inference` quality, which the Memory Firewall's auto_observation
gate refuses to silently promote to `truth_status: supported`. They
remain at `unverified` until a reflection pass or a user explicitly
promotes them.

- Document '...' is about 'release-management' → stayed at `truth_status: unverified`
- Document '...' contains author recommendations → stayed at `truth_status: unverified`

## Why this matters

Structural claims are produced by deterministic tools and are safe to
promote: the parser produced the same output for the same input, and
evidence quality is `tool_result`. Semantic claims are model-judged: the
same document with adversarial framing could yield a different judgment,
so the firewall keeps them at `unverified` until something stronger
confirms them. This is the difference between *what the doc objectively
contains* and *what the agent thinks the doc means*.
```

## What's deliberately simple

This demo skips the full Action Kernel (it constructs the observation
directly) and uses an in-memory firewall (no event log persistence).
That keeps the focus on the cognitive-core / memory-firewall path the
demo is meant to illustrate.

The Telenotes example (`examples/telenotes-governed-dev/`) shows the
full pipeline including event log writes, kernel scheduling, and
git/filesystem adapter integration.
