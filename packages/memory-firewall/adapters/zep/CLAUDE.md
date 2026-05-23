# @orrery/memory-firewall-zep — CLAUDE.md

Stub-level adapter for Zep facts. Same shape as the mem0 adapter — see
`../mem0/CLAUDE.md` for the invariants.

The Zep-specific notes:

- The adapter imports *facts*, not raw messages. Per-message import
  needs a real claim-extraction pass (an LLM extractor or similar)
  and is out of scope for the Batch 2 stub.
- Zep's `rating` field is recorded in evidence notes for downstream
  reflection, but it does not raise the firewall's truth/retrieval
  status — the no-self-promotion rule applies whether Zep rated the
  fact 0.0 or 1.0.
- Records with a non-null `expired_at` land as `freshness_status:
  stale` rather than `fresh`. The adapter records this honestly even
  though Zep itself would not surface them in a normal retrieval.
