# @qmilab/lodestar-memory-firewall-mem0 — CLAUDE.md

A stub-level adapter for mem0. `importMemories` is the one method
that works end-to-end in v0.2; the others throw.

## Invariants

1. **Imports land at `unverified/restricted`.** mem0 records are
   external_document evidence. The Round 5 auto-observation gate
   refuses to promote them silently to `supported`. The adapter does
   not even try — it adopts at `unverified/restricted` with authority
   `reflection`.
2. **No silent defaults for security-relevant options.** The
   `AdapterImportOptions` schema demands explicit `scope`,
   `sensitivity`, `source_actor_id`, and `trust_baseline`. The adapter
   refuses to import without them.
3. **One claim per record.** No claim deduplication in v0.2 — duplicate
   memories produce duplicate claims. Reconciliation lands when
   `syncMemories` lands.
4. **Rejections do not throw.** Per-record failures are captured in
   `rejection_reasons` and the import as a whole returns successfully.
   The only thrown errors are schema validation failures at the
   top-level (the input wasn't a mem0 export).

## When you change this adapter

- The Letta and Zep adapters share the `AdapterImportOptions` /
  `AdapterImportResult` contracts in `@qmilab/lodestar-memory-firewall`. If you
  change those contracts, update all three.
- Imports must remain external_document — do not "improve" the adapter
  by raising evidence quality. Self-promoting an imported memory is the
  exact failure mode the firewall is designed to prevent.

## What this adapter does not do

- Talk to a live mem0 service. It operates on exported JSON only.
- Export. `exportMemories` is intentionally stubbed.
- Sync. `syncMemories` is intentionally stubbed.
