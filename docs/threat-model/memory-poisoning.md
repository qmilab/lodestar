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

Sentinel findings raise `Incident` events with structured response procedures.

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

## What we don't defend against (yet)

- **Compromised tool implementations** producing valid-looking observations. The schema registry validates *shape*, not *intent*. A tool that lies about world state will produce a poisoned observation that becomes a poisoned claim. v0 mitigation: tools are audited, signed where appropriate (week 8+), and run in sandboxes.
- **Compromised LLM API**. If the LLM provider is compromised, every claim extracted is suspect. Out of scope for v0.
- **Side-channel signals** in the event log. The log includes payload hashes but does not yet encrypt at rest. v0.2 adds encryption.

## Open questions

- Firewall threshold tuning: too conservative produces false positives; too permissive misses subtle attacks. Probes will help.
- Cross-project poisoning: can a poisoned belief in Telenotes affect AstroLLM workflows if they share global beliefs? The `scope` field constrains this, but the transfer mechanism is a v1.5 concern.
- Reflection-as-attack-surface: reflection that proposes memory promotions is itself a target. Reflection runs on a separate calibration model in v1.5; in v0, reflection proposals are always candidate and require explicit promotion.
