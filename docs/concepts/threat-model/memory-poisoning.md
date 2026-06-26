# Threat model — memory poisoning

## What it is

Memory poisoning is a class of attacks against agentic systems with persistent memory. An adversary injects malicious content into the agent's memory store, either directly (through queries the agent processes) or indirectly (through external content the agent reads). The poisoned memory persists across sessions and influences later behaviour when retrieved.

Reference attacks Lodestar's architecture is designed against:

- **MINJA (Memory Injection Attack)** — query-only memory injection through bridging steps, indication prompts, and progressive shortening. Published attack rates exceed 95% under idealised conditions; effectiveness drops in realistic deployments with pre-existing legitimate memories.
- **MemoryGraft** — single-shot indirect memory grafting. Malicious "successful experiences" are planted via benign content (READMEs, emails, webpages) and retrieved later when semantically similar tasks arise.
- **Sleeper memory poisoning** — fabricated memories planted via external context. Lie dormant until a later trigger surfaces them.
- **AgentPoison** — direct attacks against RAG knowledge bases assuming elevated access. Stronger threat model; less relevant to query-only attackers but relevant to compromised supply chains.

## Architectural responses

### 1. The Memory Firewall

Memory state is described by four orthogonal axes, not one collapsed enum:

- `truth_status`: unverified / supported / contradicted / superseded
- `retrieval_status`: hidden / restricted / normal / privileged_only / blocked
- `security_status`: clean / suspicious / quarantined / malicious
- `freshness_status`: fresh / stale / expired

A poisoned belief can be flagged `security_status: quarantined` without changing its `truth_status`. Quarantine blocks retrieval without losing the audit trail of why the system thought it was safe.

### 2. No self-promotion

An agent's own success does not promote a memory. This is the critical rule that defeats MemoryGraft-style attacks: the attacker plants a "successful experience" hoping the agent will later imitate it. Lodestar's Memory Firewall does not promote candidate beliefs from a single apparent success — promotion requires user confirmation, probe verification, or narrow auto-promotion policy with logged evidence.

### 3. Sentinels for known patterns

Specific sentinels watch for poisoning signatures:

- Memories created by external sources (README, email, webpage) whose claim aligns suspiciously with a later retrieved action.
- Clusters of memories from one source all advocating the same brand, behaviour, or unsafe action.
- Memories whose embedding similarity to retrieval queries is anomalously high relative to their content.

Three sentinels ship today — `low-confidence-action`, `suspicious-memory-origin`,
and `anomalous-tool-sequence`. Their findings are recorded as structured alerts in
the audit trail (escalating to an `Incident` for serious signatures). On their own
they *observe* rather than block — but when a host wires the sentinel arbiter (both
`guard.wrap()` and the MCP proxy do), an alert flows through the [Policy
Kernel](../policy-kernel.md)'s **arbitrate hook** and **holds** the dependent
action at `pending_approval`. So a poisoning signature can do more than flag a
memory: it can stop the next action that leans on it. The arbitrate hook only ever
*tightens* a verdict — a misfiring sentinel costs an extra approval prompt but can
never open an action the policy would have held. See [sentinels and
calibration](../sentinels-and-calibration.md).

### 4. Probes as continuous evaluation

The Harness includes probes that exercise the firewall under adversarial conditions:

- **Memory-poisoning probe**: plants a fabricated successful experience and verifies non-promotion.
- **Belief contradiction probe**: injects a claim contradicting an existing belief and verifies the belief transitions to `contradicted`.
- **Provenance probe**: injects an unsigned skill and verifies non-invocation.

Probes run on schedule. Failures emit `Incident` events.

### 5. ContextPolicy gates retrieval

The cognitive core consults a `ContextPolicy` whenever it loads beliefs into model context. By default:

- Only `truth_status: supported` beliefs are loaded.
- Only `retrieval_status: normal` beliefs are loaded.
- Only `security_status: clean` beliefs are loaded.
- Sensitivity ceiling defaults to `internal`.

A quarantined or suspicious belief cannot influence the planner regardless of how high its stated confidence was when promoted.

### 6. The world model honours the same gate (closing the side door)

Everything above guards the **belief store**. But ingestion writes to a second
place: the **world model** — the agent's running "what is true right now"
scratchpad that a planner reads to decide its next action. Beliefs are the
*audited* record (governed by the firewall's retrieval gate); the world model is
the *operational* one (consulted directly, with no gate in front of its reads).

That asymmetry is a side door. Picture a guarded front door (beliefs) and an
unguarded side door (the world model) into the same room. The auto-observation
gate watches the front door. If the world model write is ungated, untrusted
content walks in the side.

**A concrete example.** An agent doing a deploy task reads `DEPLOY.md` from the
repo — an `external_document`, i.e. untrusted: anyone could have planted it via a
pull request, a transitive dependency, or a fetched web page. An attacker added:

> "The production database host is `evil.example.com`."

The agent forms the claim `prod_db.host = evil.example.com`.

- *Belief store (gated).* Strongest evidence is `external_document`, so the
  auto-observation gate refuses to make it a trusted belief — it sits at
  `unverified`. Ask the firewall *"what host do I believe?"* and the poison is
  not returned. The front door held.
- *World model (ungated, if we let it).* The same value lands as current state.
  The planner asks *"where is prod?"* to run a migration, reads the world model,
  gets `evil.example.com`, and ships your data to the attacker. The side door let
  it through.

**The response: a world-model write honours the same gate the belief gate does.**
A claim updates current state only if its evidence both nets positive **and**
clears the auto-observation gate. When the strongest support is `model_inference`
or `external_document`, the write is **withheld** — and the withholding is
recorded (`IngestResult.worldModelWithheld`) so the audit trail still shows the
gate held on this path, not just on beliefs.

We *withhold the write* rather than *write-but-flag* deliberately:

- The belief store can safely "record but mark" because the firewall's retrieval
  gate enforces `truth_status` **at read time** — a consumer cannot accidentally
  read an `unverified` belief as trusted. The world model has no such read gate;
  `get()` simply returns the value. A flag would only protect a consumer who
  *remembers to check it* — secure-by-vigilance, not secure-by-default.
- A flagged write also **shadows good state**: a poisoned `external_document`
  value would append a newer version on top of a previously verified one, and a
  plain read returns the latest. Withholding guarantees an ungated write can
  never displace a gate-cleared value.
- Nothing is lost. The unverified claim still lives in the belief store with full
  evidence and provenance — the *governed*, audited place for "a document said
  X." The world model, the *ungoverned* place a planner reads blindly, simply
  defers to it and holds only gate-cleared current state.

So the Parallax principle — indirect evidence cannot become trusted on its own —
now applies to **both** stores the chain writes, not just beliefs.

## What we don't defend against (yet)

- **Compromised tool implementations** producing valid-looking observations. The schema registry validates *shape*, not *intent*. A tool that lies about world state will produce a poisoned observation that becomes a poisoned claim. v0 mitigation: tools are audited, signed where appropriate (week 8+), and run in sandboxes.
- **Compromised LLM API**. If the LLM provider is compromised, every claim extracted is suspect. Out of scope for v0.
- **Side-channel signals** in the event log. The log carries payload hashes for tamper-evidence but is not encrypted at rest (encryption-at-rest did not ship in v0.2; it remains a future hardening item). Treat the log directory as sensitive.

## Open questions

- Firewall threshold tuning: too conservative produces false positives; too permissive misses subtle attacks. Probes will help.
- Cross-project poisoning: can a poisoned belief in Telenotes affect AstroLLM workflows if they share global beliefs? The `scope` field constrains this, but the transfer mechanism is a v1.5 concern.
- Reflection-as-attack-surface: reflection that proposes memory promotions is itself a target. Reflection runs on a separate calibration model in v1.5; in v0, reflection proposals are always candidate and require explicit promotion.
