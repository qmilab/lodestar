# ADR-0035: Opt-in LLM-driven generic claim extractor + a partner aware linker

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Nandan
- **Related:** #163 (issue), #154 (epic, child C-2), #157 / ADR-0032 (the evidence-linker cross-belief join + `*Aware` linker pattern this mirrors), Round 5 auto-observation (Parallax) gate (`docs/architecture/v02-delta.md`)

## Context

`extractors/index.ts` registered only schema-bound built-ins (`git.status@1`,
`fs.read@1`; `DocumentationExtractor` opt-in). The `__generic__` slot that
`lookupExtractor` falls back to was **reserved but unregistered**, so arbitrary
tool-result / observation text with no schema-bound extractor produced no claims
at all. Epic #154's last child (C-2) is the generic, LLM-driven extractor that
fills it.

Three forces shaped the design:

1. **Determinism is the default; an LLM extractor is not.** Replay-stable,
   schema-bound extraction is what the rest of the system relies on. An LLM
   extractor is non-deterministic, so it must be an explicit opt-in, never a
   built-in — registering it is a deliberate choice.
2. **The safety property is the whole point.** A generic extractor is acceptable
   *only* because its claims cannot silently self-promote. They must stay
   `unverified` until a human or a reflection pass promotes them.
3. **Lodestar ships no LLM.** The package carries no model client, key handling,
   or prompt — it is types, schemas, and governance. The model must be injected.

## Decision

Two opt-in pieces in `@qmilab/lodestar-cognitive-core`, mirroring the existing
extractor + `*Aware` linker pairing (Doc / MCP / Runtime):

- **`createGenericLLMExtractor(model, options?)`** — a factory returning a
  `ClaimExtractor` for the `GENERIC_EXTRACTOR_SCHEMA_KEY` (`"__generic__"`) slot.
  The consumer registers it explicitly (`registerExtractor(...)`); it is **never**
  in `registerBuiltInExtractors`. The provider-agnostic `GenericExtractionModel`
  seam (`extractClaims(text, schema, observation) → GenericClaimDraft[]`) is where
  the consumer's actual LLM call lives. Every minted claim is
  `extraction_method: "llm"`, with provenance (`source_observation_ids`, scope,
  sensitivity, authorship) stamped by the extractor so a draft can't lie about its
  origin. Caps on claim count and input text length defend against a noisy or
  poisoned observation.
- **`GenericAwareEvidenceLinker`** — the partner linker. For an
  `extraction_method: "llm"` claim it stamps the source-observation evidence at
  **`model_inference`** quality (synthetic-trust observations stay
  `synthetic_probe`, never upgraded), preserving the #157 cross-belief join.
  `model_inference` is exactly what trips the auto-observation gate in
  `CognitiveCore`, so the belief is adopted at `truth_status: unverified` even at
  an aggregate strength that would promote a `direct_observation` claim, and even
  when a second independent LLM inference corroborates it (Parallax holds across
  LLM inferences, as it does across two `external_document` beliefs). Non-`llm`
  claims fall straight through to the base linker.

**The downgrade lives in the linker, not the base extractor path.** Evidence
quality is the linker's concern, and the base `EvidenceLinker` deliberately
treats `extraction_method` as non-load-bearing (the source observation's own
trust sets quality). First-party flows rely on that — notably the #157
`evidence-linker-cross-belief-join` probe, which uses `extraction_method: "llm"`
synthetic extractors with the base linker and *expects* `direct_observation`
promotion. So opting into the generic extractor means opting into its linker too;
the probe pins that the base-linker path still promotes (AC#5), making the pairing
requirement explicit rather than a silent footgun.

## Consequences

- No `packages/core` schema change — `extraction_method: "llm"` and
  `model_inference` already exist; this only wires them together behind the
  opt-in. No new event, no firewall change.
- Pure no-op for every existing flow: nothing registers the generic extractor or
  uses the new linker by default, so the event stream and all prior probes are
  byte-for-byte unchanged (70 first-party probes pass, was 69).
- The consumer owns the prompt + model and its non-determinism; Lodestar governs
  the *result* (records it as `llm` / `model_inference`, gates promotion). A
  TS/governance boundary, not a guarantee about the model's quality.
- Locked by `generic-llm-extractor-stays-unverified` (in-memory): the gate holds
  at high strength, Parallax holds across LLM inferences, not active unless
  registered, never a built-in, and the load-bearing-downgrade control.

## Alternatives considered

- **Make the base linker cap `llm` claims at `model_inference`** — rejected: it
  would break the locked #157 probe (which relies on `llm` claims promoting via
  the base linker) and is a behaviour change for every consumer, not an opt-in.
- **Put the safety in the extractor alone (no linker)** — rejected: an extractor
  produces only `Claim`s; evidence quality (what the gate reads) is built later by
  the linker. The extractor cannot set it, so the property would not be robust.
- **Register the generic extractor as a built-in** — rejected: it makes
  non-deterministic extraction the default fallback for any unknown schema,
  exactly the opposite of "replay-stable extraction is the default."
- **Ship a bundled LLM client / prompt** — rejected: pulls a provider SDK + secret
  handling into a types-and-governance package and picks the consumer's model for
  them. The injected `GenericExtractionModel` seam keeps both out.
- **C-1, a consumer's own schema-bound tool-result extractor** — out of scope and
  consumer-owned (e.g. Asterism's, modelled on `DocumentationExtractor`); #163 is
  only the generic fallback.
