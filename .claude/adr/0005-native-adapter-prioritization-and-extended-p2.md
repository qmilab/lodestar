# ADR-0005: Native adapter prioritization and the extended P2 sequence

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Nandan, Claude
- **Related:** ADR-0004, `docs/roadmap.md`, `packages/adapters/`, `packages/memory-firewall/adapters/`

## Context

P2 (native adapters) was sequenced shell → github → nostr. `shell` shipped
(#56, ADR-0004). Three adapters is too narrow to make Lodestar broadly useful, so
we need (a) a principle for *which* adapters earn a build slot, and (b) an extended
sequence.

The principle: an adapter is worth building when **governance is load-bearing** —
when at least one of Lodestar's three mechanisms actually fires on it:

1. **Consequential action** — irreversible / `blast_radius: external` → the trust
   ladder and L4 human-approval gate earn their keep.
2. **Untrusted output** — the tool returns `external_document` content → the
   Memory Firewall / auto-observation gate earns its keep (content that must not
   self-promote to a supported belief).
3. **Outward data movement** — `blast_radius: external` → activates the
   `anomalous-tool-sequence` sentinel's `read → external-egress → write` exfil
   pattern, which is **dormant in the native path** until an egress-capable adapter
   lands (today nothing native emits external egress; `github` push is the first).

Adapters where none of these fire (pure local, reversible, trusted-shape output)
are low-value: Lodestar would record them faithfully but add little.

## Decision

**Extend the ordered P2 native-tool-adapter sequence to:**

> shell ✓ → github → nostr → **http / web-fetch** → **messaging (email / Slack)**

Then a governance-rich backlog (unordered, pulled by demand): **SQL / database**
(SELECT L1–2 vs INSERT/UPDATE L3 vs DELETE/DROP L4), **vector / RAG retrieval**
(retrieved chunks = `external_document` — the gate's home turf, RAG poisoning),
**`fs.write`** (the filesystem adapter is read-only today; complete the native
greenfield coding story), **payments** (smallest surface, maximal stakes — the
cleanest L4/L5 demo), **cloud / infra** (k8s / terraform — highest stakes, heaviest).

Why these two are promoted into the *ordered* sequence:

- **http / web-fetch** is the only adapter that hits all three governance surfaces
  at once (injection vector + egress + untrusted content), lights up the dormant
  egress sentinel, and "browse the web safely" is a far more universal adoption
  story than git/nostr.
- **messaging / email** is the canonical irreversible-external L4 action — the
  clearest demonstration of the Policy Kernel human-approval gate just wired in
  (slices 3a/3b/3c).

Two adjacent adapter categories continue on their existing patterns (not part of
the ordered P2 tool sequence):

- **Memory-firewall import adapters** (siblings of `mem0`/`letta`/`zep`): Pinecone /
  Weaviate / Chroma, Redis, OpenAI Assistants threads, MemGPT. Same proven shape
  (imported memories cannot self-promote), low cost each.
- **Runtime / framework adapters** (wrap a whole agent loop, not one tool; v1.5+):
  LangGraph, CrewAI, Hermes, OpenClaw, **Flue, Pi**. These route a framework's whole
  cognition through Lodestar rather than a single tool call.

## Consequences

- P2 grows from 3 to 5 ordered adapters — broader usefulness, more surface to build
  and maintain. Each remains its own feature branch → PR → merge.
- `http` + `messaging` exercise the *full* governance stack (firewall + ladder +
  egress sentinel) together — the strongest end-to-end demos for the Policy Kernel.
- Every new external adapter must declare `blast_radius` / `reversibility` / sandbox
  honestly (no silent defaults for security-relevant settings) and route egress
  content through the firewall / sensitivity ceiling.
- The runtime-adapter list now names Flue and Pi as targets; per-framework scope is
  a separate work item each (v1.5+) and is not detailed here.

## Alternatives considered

- **Keep P2 at shell / github / nostr.** Rejected — too niche; the product stays a
  coding/Nostr demo rather than a general agent trust layer.
- **Jump straight to runtime/framework adapters.** Rejected — heavier, and per-tool
  adapters demonstrate the governance mechanisms more legibly first.
- **Promote cloud/infra (k8s/terraform) into the ordered sequence.** Deferred —
  highest stakes but heaviest to sandbox honestly; not needed to prove the model.
