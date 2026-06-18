# ADR-0024 spike — remoted execute / "hook as downstream"

A **throwaway** proof-of-concept that validated the riskiest claim in
[ADR-0024](../../.claude/adr/0024-langgraph-runtime-adapter-seam.md): a non-MCP
runtime (LangGraph) can be governed by remoting each native tool call to a TS
**governance-gate sidecar** that reuses the **real `ActionKernel`** unchanged,
with two-phase preserved across the language boundary.

This is **not production code** and is not wired into CI or any package. It is
kept as the reproducible artifact backing the ADR's *Validation* section — the
real implementation will be `packages/runtime-core/` (TS) + `runtimes/langgraph/`
(Python), per the ADR.

## Run

```bash
# from the repo root (needs `bun` and `python3` on PATH)
python3 spikes/adr-0024-remoted-execute/hook.py
```

`hook.py` (the LangGraph-side stand-in) spawns `gate.ts` (`bun run`, the real
kernel) and drives it over bidirectional stdio NDJSON-RPC, asserting:

| Check | Claim |
|-------|-------|
| A | re-entrant remoted execute works; result enters the chain via `observationSink` |
| B | an L4 call holds at `pending_approval` — the Python body **never runs** (no work before approval) |
| C | `resolve(granted)` then executes the body once |
| D | a **duplicate** resolve is idempotent — no re-execution (exactly-once) |
| E | two in-flight calls are each correlated to the right action by RPC id, ingested once |

## What it deliberately does NOT cover

- **Durability across a sidecar restart** (ADR-0024 §5): the spike holds pending
  /idempotency state in memory. The real gate reconstructs it from the durable
  event log + signed side-channel; that is an obligation of the
  `runtime-gate-enforces-two-phase` probe, not this spike.
- The full `CompiledPolicy` gate, sentinels, and cognitive-core ingestion — all
  already proven by the MCP proxy and reused as-is; the spike uses a stand-in
  gate because the kernel only ever sees a gate as a function.
