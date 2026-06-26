# ADR-0037: World-model writes honour the auto-observation gate

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** Nandan
- **Related:** #165 (epic #154 tail), #157 / ADR-0032 (the world-model write rule
  this refines), #163 / ADR-0035 (the generic LLM extractor — the other gated
  source), docs/concepts/threat-model/memory-poisoning.md §6

## Context

`CognitiveCore.ingest` writes two stores. Beliefs go to the firewall, where the
**auto-observation gate** (Parallax) keeps a claim whose strongest support is
`model_inference` / `external_document` at `truth_status: unverified` — it cannot
become trusted on its own. But step 6 also writes the **world model**, the agent's
"current state" scratchpad a planner reads to decide its next action, and that
write was gated only on *net-positive strength* (the #157 P2#1 rule: a
net-contradicted claim does not overwrite observed state). A positive-but-gated
claim — a lone poisoned `external_document`, an LLM inference — still wrote current
state.

So the gate guarded the front door (beliefs) but not the side door (the world
model). It is latent today — nothing reads the world model back into a decision
yet (no `planner.ts`; the only readers are the telenotes report and a probe) — but
"a planner reads current state" is the world model's whole purpose. The moment a
real agent or integrator (e.g. Asterism) uses it as intended, an unverified
poisoned value reaches a decision, bypassing the gate that exists to stop it.

## Decision

A world-model write honours the same gate the belief gate does: **a claim updates
current state only if its evidence both nets positive AND clears the
auto-observation gate.** When the strongest support is `model_inference` /
`external_document`, the write is **withheld**, and the withholding is recorded on
`IngestResult.worldModelWithheld` (`{ key, quality }[]`) so the audit trail shows
the gate held on this path too. Hosts that emit `cognitive.ingested`
(`guard.wrap`, the MCP proxy, the runtime gate) carry the receipt as
`world_model_withheld`. This reuses the `autoObservationBlocked` signal `ingest`
already computes (single source of truth) and strictly refines ADR-0032's P2#1
rule (positive **and** gate-cleared, not merely positive). The net-contradiction
rule (strength ≤ 0) is unchanged.

We **withhold** rather than **write-and-flag**:

- The belief store can "record but mark" because the firewall's *retrieval* gate
  enforces `truth_status` at read time. The world model has **no read gate** —
  `get()` returns the value — so a flag is only safe for a consumer who remembers
  to check it (secure-by-vigilance, not by default; wrong for arbitrary agents).
- A flagged gated write **shadows** good state: it appends a newer version atop a
  previously gate-cleared value, and a plain read returns the latest. Withholding
  guarantees an ungated write can never displace a gate-cleared one.
- Nothing is lost. The unverified claim survives as the firewall-governed belief
  with full evidence + provenance — the audited home for "a document said X". The
  world model defers to it and holds only gate-cleared current state.

## Consequences

- The Parallax principle now applies to **both** stores ingest writes, closing the
  side door before any consumer reads the world model into a decision.
- Applies to **all** aware linkers (`Doc` / `MCP` / `Runtime` / the generic LLM
  extractor), since the gate signal is the shared one `core.ts` computes.
- Accepted trade-off: when reality genuinely changed but the only evidence is
  untrusted, the world model keeps the stale-but-trusted value rather than the
  fresh-but-unverified one — the same trade-off the belief gate already makes,
  surfaced via the retained `unverified` belief and the `worldModelWithheld`
  receipt so a planner can choose to seek verification.
- Corroboration is unaffected: the cross-belief join reads prior *beliefs*, not the
  world model, so a later higher-quality observation can still corroborate the
  retained belief and *then* clear the gate and write.
- No `packages/core` schema change (`IngestResult` / world-model schema live in
  cognitive-core; neither is on the stable public-API ledger). Locked with an
  adversarial probe; the existing `evidence-linker-cross-belief-join` Scenario D
  (net-contradiction) stays green.

## Alternatives considered

- **Write-but-flag the gated entry** — rejected: no read-time gate to enforce the
  flag, and a flagged write shadows trusted state (see Decision).
- **Keep the world model ungated; document that consumers gate at read** —
  rejected: pushes the safety boundary onto every integrator, contradicting the
  secure-by-default thesis; this is precisely the laundering path.
- **Skip silently (no receipt)** — rejected: violates "we can show the gate held";
  the audit record is cheap and makes the boundary auditable + probe-able.
