# ChatGPT review prompt — Batch 1 positioning + scaffold sanity check

Use this as the prompt to send to ChatGPT. Attach the following files alongside the prompt itself:

- `README.md`
- `docs/positioning.md`
- `docs/roadmap.md`
- `docs/architecture/v02-delta.md` (the full file, including the new "post-implementation positioning shift" section at the bottom)
- `docs/threat-model/memory-poisoning.md`
- The scaffold tarball `orrery-week2-scaffold.tar.gz` (or a link to the GitHub repo if it's up)
- A short transcript excerpt showing both probes passing and the Telenotes example's 11-event audit trail

---

## The prompt

> You and I have been collaboratively designing Orrery — what is internally called an "epistemic governance framework for agentic systems" and externally positioned as a "trust layer for AI agents." We're at the end of a long arc that went through v0, v0.1, and v0.2 design memos, with you pressing for revisions at each stage. Claude has now done two things:
>
> 1. Built a working week-2 scaffold in TypeScript (Bun, strict mode, zero errors). The full epistemic chain runs end-to-end: Observation → Claim → Evidence → Belief → world-model update. Two probes pass: the memory-poisoning resistance probe (synthetic-probe-only evidence cannot adopt a belief) and the full-chain smoke test (3 claims, 3 beliefs, 3 world-model keys from one git.status observation). The Telenotes example produces an 11-event audit trail with monotonic sequence numbers, payload hashes, and full causality.
>
> 2. Adopted your product-strategy recommendations almost verbatim. The architecture stays as the v0.2 delta described, but the public language has shifted from "epistemic governance framework" to "trust layer for AI agents." The four open-source surfaces (Guard / Trace / Memory Firewall / Harness) are now the developer-facing entry points. Marketplace strategy is trust packs (policy / probe / sentinel / adapter / signed manifests) sequenced v0 through v2 with no public registry before v1. Organizational home is QMI Lab as the research arc primary, with Machinise reserved for commercial extensions later.
>
> I'd like a sanity-check pass before further implementation. Three categories of feedback would help me most:
>
> **A. Positioning honesty.**
> - Does the README copy hold up? Is the "use X for Y, use Orrery to govern Y" framing genuinely defensible against LangSmith, Langfuse, mem0, and the agent runtimes? Where is it weakest?
> - Is anything I'm claiming about competing tools (e.g., "mem0 lacks a principled what-is-safe-to-retrieve answer") wrong or unfair?
> - Is the four-surface framing (Guard / Trace / Memory Firewall / Harness) clear, or does it carry residual confusion from the earlier three-product list in your previous response? Is there a cleaner split I should consider?
> - The roadmap reserves "advanced replay UI" for the commercial layer but keeps "basic replay capability" open-source. Does that split actually work, or am I dividing a single primitive in a way that won't survive contact with users?
>
> **B. Scaffold sanity check.**
> - The attached scaffold implements the architecture you and I converged on. Does the code shape match what you'd expect from the v0.2 delta? Are the package boundaries (`@orrery/core`, `@orrery/event-log`, `@orrery/action-kernel`, `@orrery/memory-firewall`, `@orrery/cognitive-core`, `@orrery/adapter-*`, `@orrery/cli`) sensible?
> - The Memory Firewall enforces no-self-promotion (synthetic-probe-only evidence cannot adopt a belief at truth_status='supported'). The probe passing means the rule is wired correctly. Is this *all* it should enforce, or are there additional invariants I'm missing that should be probe-tested before further development?
> - The four orthogonal lifecycle axes (truth / retrieval / security / freshness) with per-axis transition tables — is the abstraction holding up, or do you see a case where these axes should not be orthogonal?
> - BeliefAuthority (provenance: observed/inferred/user_asserted/policy_asserted/imported/synthetic) is deliberately separated from TransitionAuthority (who can perform a lifecycle change: user/policy/probe/sentinel/reflection/auto_observation/system). Earlier drafts conflated them. Is the separation right?
>
> **C. Roadmap pressure.**
> - The five-batch sequence is: positioning (now) → package cleanup → harness infrastructure → MCP proxy → week-8 demo. Is the ordering correct? In particular: Harness infrastructure (Batch 3) before MCP proxy (Batch 4) — defensible because the demo's value rests on probes catching real failures, but the headline use case ("wrap Claude Code") doesn't land until Batch 4. Should the MCP proxy come first?
> - The headline use case is "wrap a coding agent and get a trust report" with Telenotes as the first proving ground (not the demo subject). Are there other proving grounds I should consider in parallel that would broaden the surface — for example, wrapping a customer-support agent, a data analysis agent, a documentation agent?
> - The research arc (memory poisoning paper, calibration paper, evaluation methodology, position paper) runs in parallel. Are any of those papers fundamentally premature given the scaffold's current state, or are they reasonable to plan for now?
>
> I'm not asking for a conceptual rewrite — that work is done. I'm asking for a pass that surfaces anything I'd regret missing later. Be direct. Disagree on substance, not politeness. If something is right, say so briefly and move on.

---

## Notes to self before sending

Before sending this prompt:

- [ ] Bundle the scaffold tarball (latest version after Batch 1 commit)
- [ ] Run both probes one more time and paste the output into the message
- [ ] Run the Telenotes example one more time and paste the event sequence
- [ ] Optional: include a one-page summary of the v0.2 delta's key decisions if ChatGPT's context window is constrained

Expected response shape: ChatGPT will likely push back hardest on **A** (positioning honesty), validate or refine **B** (scaffold sanity), and provide useful pressure on **C** (roadmap ordering). The most likely high-leverage critique is on the MCP proxy ordering — moving it earlier might be the correct call.

After receiving ChatGPT's response, do not implement immediately. Triage the response into:
- Things to fix in Batch 1 (positioning docs themselves)
- Things to add to Batch 2's plan
- Things to defer to a future batch

Then loop back to the user (Nandan) for sign-off before any further code changes.
