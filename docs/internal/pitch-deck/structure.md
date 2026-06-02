# Pitch deck structure — Lodestar

**Format**: ~12 slides. Trust-layer voice (external positioning), not "epistemic governance framework" voice.

**Primary use case**: developer evangelism — meetups, tech talks, podcast appearances, dev.to / Substack posts that reuse the slides as illustrations.

**Secondary use case**: investor / partnership conversations once Machinise spins up the commercial layer. The same deck works for both, with two slides swapped at the end (call to action changes).

**Visual style notes**:
- Dark theme, charcoal background, single accent color (teal or amber), Cormorant Garamond for headings, IBM Plex Mono for code samples (matching the AstroLLM aesthetic Nandan already uses)
- Minimal text per slide — the slide is a punctuation mark for the spoken story, not a substitute for it
- Diagrams over bullet lists wherever possible
- Real code, real screenshots, real audit trails — not stock illustrations

---

## Slide 1 — Title

**Visual**: Lodestar wordmark on dark background. Subtitle below.

**Headline**: Lodestar

**Subhead**: The trust layer for AI agents.

**Footer**: A QMI Lab research project · qmilab.com/lodestar

**Speaker note**: Open with a question to the room, not the title. "How many of you have had an AI agent do something you couldn't explain afterward?" Show of hands. Then advance to slide 2.

---

## Slide 2 — The gap (open with pain)

**Visual**: Three-column screenshot grid: (a) a coding agent committing wrong code, (b) a research agent citing a fabricated source, (c) a customer-service agent leaking PII. Below each, the question the team asked afterward.

**Headline**: When agents fail, teams ask the same five questions.

**Body**:
- What did the agent believe?
- Where did that belief come from?
- Which action depended on it?
- Was the belief verified?
- Did the agent learn the right lesson afterward?

**Speaker note**: This is the pain. Don't introduce Lodestar yet. Spend 30 seconds making sure the room agrees these are the right questions. If they don't, the rest of the deck won't land.

---

## Slide 3 — What's missing today

**Visual**: A three-row diagram showing the current state of agent infrastructure as stacked layers:
- "Runtime" row with logos: Claude Code, Cursor, OpenClaw, Hermes, LangGraph
- "Memory" row with logos: mem0, Letta, Zep
- "Observability" row with logos: LangSmith, Langfuse, Phoenix

A fourth row underneath, drawn in dashes: "**Trust** — [missing]".

**Headline**: We have runtime, memory, and observability. We don't have trust.

**Body**:
- Runtime tools execute actions.
- Memory tools persist information.
- Observability tools record what happened.
- *None of them* answer "what did the agent believe, why did it act, and was it right."

**Speaker note**: This is where you place Lodestar in the landscape without yet saying its name. Audiences understand layered stacks. Letting them see the gap visually is more effective than telling them about it.

---

## Slide 4 — What Lodestar is

**Visual**: The same stack from slide 3, with the dashed bottom row now filled in and labeled "Lodestar" in the accent color.

**Headline**: Lodestar is the trust layer.

**Subhead**: Know what your agent believed, why it acted, and whether it was right.

**Body** (in three short lines, each accompanied by a small icon):
- Wraps your agent's actions
- Governs its memory
- Produces a complete audit trail

**Speaker note**: This is the one-liner. Memorize it. Everything else in the deck supports this slide.

---

## Slide 5 — How it works (the chain)

**Visual**: Horizontal flow diagram of the epistemic chain. Eight stages connected by arrows:

```
Observation → Claim → Evidence → Belief → Decision → Action → Outcome → Revision
```

Color coding: blue for inputs (Observation, Evidence), amber for governance (Claim, Belief, Decision), green for outputs (Action, Outcome, Revision).

**Headline**: Every action has a story. Lodestar records it.

**Body**:
- The agent **observes** something via a tool call.
- The observation produces typed **claims** about the world.
- Each claim is supported by **evidence**, weighed by quality and freshness.
- Strong evidence becomes a **belief**.
- Beliefs inform **decisions**.
- Decisions execute as **actions**.
- Actions produce **outcomes**.
- Outcomes drive **revisions** to beliefs.

**Speaker note**: Walk the chain left to right on the slide. Take ~45 seconds. The point is not to teach the chain in detail — it's to show that Lodestar has a structured answer to each of the five questions on slide 2.

---

## Slide 6 — The Memory Firewall

**Visual**: A diagram showing a belief moving along four orthogonal axes:

```
     truth_status     ──→ supported
     retrieval_status ──→ normal
     security_status  ──→ clean
     freshness_status ──→ fresh
```

Each axis has its own allowed transitions. Highlight the no-self-promotion rule with a callout: "An agent's own success does NOT promote a belief."

**Headline**: Memory is governed, not just stored.

**Body** (three lines):
- Four orthogonal lifecycle axes per belief
- Per-axis transition tables specify who can change what
- The no-self-promotion rule defeats memory-poisoning attacks (MINJA, MemoryGraft)

**Speaker note**: This slide is dense. Don't try to teach the four axes — just show that the system has them. The takeaway: memory in Lodestar has structure that mem0 / Letta / Zep don't have.

---

## Slide 7 — Where it fits

**Visual**: The "use X for Y, use Lodestar for Z" table from `docs/strategy/positioning.md`:

| You use… | Lodestar's role |
| --- | --- |
| Claude Code, Cursor, OpenClaw, LangGraph | Wraps and governs their actions |
| mem0, Letta, Zep | Governs what is safe to remember |
| LangSmith, Langfuse, Phoenix | Exports traces, adds epistemic semantics |
| MS Agent Governance Toolkit, MCP gateways | Extends governance to beliefs, memory, skills |
| Claude Skills, MCP servers | Verifies, signs, scores, policy-wraps them |

**Headline**: Lodestar does not replace what you have. It governs it.

**Body**:
- *Use LangSmith to see traces. Use Lodestar to know whether the agent was allowed to believe and do what it did.*
- *Use mem0 for memory. Use Lodestar to govern memory promotion and retrieval.*
- *Use Claude Code or OpenClaw to run the agent. Use Lodestar to make its actions and memories trustworthy.*

**Speaker note**: This is the "are you competing with X?" defense. The audience will be wondering this. Get ahead of it. The integration-first stance is genuinely defensible and matches what Lodestar actually does.

---

## Slide 8 — Demo (the trace report)

**Visual**: Real screenshot of an `lodestar trace report` output. Markdown rendering with:
- Action header (what was attempted)
- Claims extracted (with their structured predicates)
- Beliefs adopted (with confidence and lifecycle state)
- Outcome and any revisions

This is the killer screenshot. It should occupy ~80% of the slide.

**Headline**: This is what Lodestar produces.

**Speaker note**: Live demo if possible. If not, walk the audience through the screenshot, pointing at: "this is the claim, this is the evidence, this is the belief, this is the action, this is the outcome." Total time on slide: 60-90 seconds. The visual does the work.

---

## Slide 9 — The four developer surfaces

**Visual**: Four cards in a 2x2 grid, each with a name and one-line description:

| **Lodestar Guard** | **Lodestar Trace** |
| Wraps tool calls. Records the chain. | Reads the event log. Produces audit reports. |

| **Lodestar Memory Firewall** | **Lodestar Harness** |
| Governs memory promotion and retrieval. Works with mem0, Letta, Zep. | Probes, sentinels, calibrators. The marketplace surface. |

**Headline**: One architecture, four packages.

**Subhead**: Adopt one. Or all four. Each is independent.

**Body** (small text below the grid):
- All Apache 2.0
- Bun + TypeScript
- Open source primary; hosted features come later

**Speaker note**: Most adoptions will start with Guard. Memory Firewall is the standalone wedge. Harness is what the community extends through trust packs.

---

## Slide 10 — Where we are today

**Visual**: A roadmap timeline with five batches, the first checked off, the others labelled with rough timing.

```
✓ Batch 1 — Positioning + scaffold ····· done
✓ Batch 2 — Guard, Trace, Memory adapters ····· done
✓ Batch 3 — MCP proxy (wrap any coding agent) ····· done
▸ Batch 4 — Harness infrastructure ····· done
□ Batch 5 — End-to-end thesis demo ····· next
```

**Headline**: v0.1.5 on npm. 13 packages published. Twenty-one passing probes.

**Body**:
- Full schema layer for the epistemic chain
- Two-phase action execution with TOCTOU defense
- Memory Firewall with four orthogonal lifecycle axes
- Cognitive Core: claim extraction, evidence linking, world model
- Two adversarial probes pass — memory poisoning resistance, full-chain integrity
- 11-event audit trail produced end-to-end

**Speaker note**: Honest about pre-v1 status. The fact that the scaffold works and passes the probes is real evidence; don't undersell that. The roadmap is short — six weeks of focused work. Audiences respect this kind of clarity.

---

## Slide 11 — Open source strategy

**Visual**: A two-column diagram.

Left column ("Apache 2.0, available today"):
- Core primitives (schemas, event log)
- Action Kernel
- Memory Firewall
- Cognitive Core
- Guard / Trace / Harness packages
- All adapters
- Basic replay

Right column ("Future commercial offering"):
- Hosted dashboard
- Team approval workflows
- Compliance exports
- Enterprise policy packs
- Managed marketplace

**Headline**: Open source first. Commercial later, and only on top.

**Body**:
- Nothing in the commercial layer gates the developer-adoption workflow.
- A solo developer using Lodestar gets a complete trust layer.
- Hosted features add team operations and compliance reporting on top.

**Footer**: Model is Langfuse-style open core.

**Speaker note**: Important for the dev audience to see the open-source line clearly. They need to know they're not being lured in to a closed product. The right-column items are explicitly things teams pay for, not things that lock individual developers out.

---

## Slide 12a — Call to action (dev evangelism version)

**Visual**: Repo URL, a couple of code snippets showing adoption, a QR code linking to the repo.

**Headline**: Try the scaffold.

**Body** (a small terminal-flavored block):

```
git clone github.com/qmilab/lodestar
bun install
bun run probes:all
bun run example:telenotes
```

Below: "Pull requests welcome. First three external probe packs will be co-authored on the v0.2 announcement."

**Speaker note**: The point of the talk is adoption. Make the path short. The "first three external probe packs co-authored" is a real incentive for the audience to engage now.

---

## Slide 12b — Call to action (partnership / investor version)

**Visual**: Three boxes — research collaboration, commercial pilot, ecosystem partnership.

**Headline**: Three ways to engage.

**Body**:
- **Research collaboration** — co-author a probe pack, contribute to the threat model, join the calibration framework working group. Anchor at QMI Lab.
- **Commercial pilot** — early-access to hosted Lodestar features through Machinise once available. Reach out to discuss.
- **Ecosystem partnership** — build an adapter for your agent runtime or memory layer. Get featured in the first-party adapter set.

**Speaker note**: Use this version only when the audience includes partnership/investment intent. Default to slide 12a for dev-heavy rooms.

---

## Production notes

### Building the actual `.pptx`

When ready to produce the actual deck, the path is:

1. **Confirm the structure** — get one round of feedback on this outline before generating the actual slides.
2. **Choose theme** — use the `theme-factory` skill or hand-build a theme matching the AstroLLM "Academic Observatory at Night" aesthetic (Cormorant Garamond + IBM Plex Mono + deep charcoal + teal/amber accents).
3. **Produce slides** — use the `pptx` skill in a follow-up turn. Each slide above maps to one PowerPoint slide. Embed real screenshots from the working scaffold for slides 8 and 10.
4. **Speaker notes** — every slide gets its speaker note in the PowerPoint speaker notes panel.

### Variants

The same deck supports two variants by swapping slides 12a / 12b:

- **Developer evangelism version** (default): slide 12a, no investor framing anywhere
- **Partnership / investor version**: slide 12b, slightly more enterprise-focused slide 11 (more emphasis on compliance and team operations)

Other potential variants:

- **Conference talk version (20 min slot)**: same 12 slides, expanded with 2-3 deep-dive slides on whatever the conference theme demands
- **Hallway version (60-second pitch)**: only slides 1, 4, 7, and 12a, used as a printed business-card-sized handout
- **Investor deep dive (separate deck, ~25 slides)**: built later if/when Machinise needs it

### What to NOT include in the dev deck

- Funding ask
- Team slide (Nandan-only for now)
- Financial projections
- Market sizing slides
- Anything that implies the project is a startup pitch

These belong in a separate investor deck, built later, and very different in voice. Keep the dev deck *technical*.

### Distribution

The deck should be available in three forms after the first version is built:

1. `.pptx` — for live talks
2. `.pdf` — for sharing as an artifact
3. Image-export per slide — for embedding in blog posts and Twitter threads

Each slide's body should make sense as a standalone image (no animation dependencies, no slide-to-slide visual jokes that only work in sequence).
