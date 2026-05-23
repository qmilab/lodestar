---
description: Produce the full epistemic chain report for a session
---

You are operating inside the Orrery monorepo. The user has requested a trace report for session `$ARGUMENTS`.

Your job is to:

1. Read the event log files under `.orrery/events/<project_id>/` for the requested session.
2. Group events by their position in the epistemic chain: Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision.
3. For each link, summarise what happened and reference the relevant event IDs.
4. Surface any Explanation records associated with governance events (action approvals/rejections, memory promotions/quarantines, confidence downweights, belief revisions).
5. Note any Incident events.
6. Produce a structured markdown report with the following sections:
   - Session summary (start time, actor count, total events)
   - Epistemic chain trace (organised by link)
   - Governance events (with explanations)
   - Incidents (if any)
   - Harness findings (probes, sentinels, calibrators that fired)

Do not invent events that are not in the log. If a link in the chain has no entries, say so explicitly.

If the session ID is not found, list the available sessions for the project and ask which one.
