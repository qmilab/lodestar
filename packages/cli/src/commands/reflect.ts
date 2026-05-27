import type { ReflectionProposal } from "@qmilab/lodestar-core"
import { ExplanationGenerator, Reflection } from "@qmilab/lodestar-cognitive-core"
import {
  defaultLogRoot,
  loadSessionEvents,
} from "@qmilab/lodestar-trace"

/**
 * `lodestar reflect <session-id> [--project <id>] [--log-root <path>]
 *                                [--since-seq <n>] [--trigger <name>]
 *                                [--json]`
 *
 * Dry-run reflection over an existing session's event log. Reads
 * events, computes proposals, prints them. Does NOT apply proposals —
 * applying requires a live MemoryFirewall (Guard or the MCP proxy own
 * one), and the CLI does not rebuild firewall state from events.
 *
 * Defaulting to dry-run is deliberate: per the design doc, applying a
 * reflection proposal mutates belief state through the firewall and
 * emits new `belief.transitioned` events. That should happen inside
 * the host process that owns the firewall, not from a long-after-the-
 * fact CLI inspection.
 */
export async function reflectCommand(argv: string[]): Promise<number> {
  let session_id: string | undefined
  let project_id: string | undefined
  let log_root = defaultLogRoot()
  let since_seq: number | undefined
  let trigger: "cli" | "programmatic" | "tail_cascade" | "tail_batch" | "sentinel" = "cli"
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--project" || arg === "-p") {
      project_id = argv[++i]
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg === "--since-seq") {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN
      if (Number.isFinite(parsed)) since_seq = parsed
    } else if (arg === "--trigger") {
      const next = argv[++i]
      if (
        next === "cli" ||
        next === "programmatic" ||
        next === "tail_cascade" ||
        next === "tail_batch" ||
        next === "sentinel"
      ) {
        trigger = next
      }
    } else if (arg === "--json") {
      json = true
    } else if (arg && !arg.startsWith("-") && !session_id) {
      session_id = arg
    }
  }

  if (!session_id) {
    process.stderr.write(
      "usage: lodestar reflect <session-id> [--project <id>] [--log-root <path>]\n" +
        "                                  [--since-seq <n>] [--trigger <name>] [--json]\n",
    )
    return 2
  }

  const loaded = await loadSessionEvents({
    logRoot: log_root,
    session_id,
    project_id,
  })
  if (loaded.events.length === 0) {
    process.stderr.write(
      `no events found for session '${session_id}' under '${log_root}'\n`,
    )
    return 3
  }

  const reflection = new Reflection({
    explanations: new ExplanationGenerator(`cli-reflect:${loaded.project_id}`),
    context: {
      project_id: loaded.project_id,
      session_id,
      actor_id: `cli-reflect:${loaded.project_id}`,
    },
  })

  const result = await reflection.run({
    trigger,
    since_seq,
    events: loaded.events,
    apply: false,
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`)
    return 0
  }

  process.stdout.write(renderProposalsHuman(result.payload, loaded.events.length))
  return 0
}

function renderProposalsHuman(
  payload: {
    pass_id: string
    triggered_by: string
    cursor: { from_seq: number; to_seq: number }
    observed_event_ids: string[]
    proposals: ReflectionProposal[]
    started_at: string
    finished_at: string
  },
  total_session_events: number,
): string {
  const lines: string[] = []
  lines.push(`pass ${payload.pass_id.slice(0, 8)}  trigger=${payload.triggered_by}`)
  lines.push(`  cursor: seq ${payload.cursor.from_seq} → ${payload.cursor.to_seq}`)
  lines.push(`  observed ${payload.observed_event_ids.length} of ${total_session_events} session event(s)`)
  lines.push(`  proposals: ${payload.proposals.length}`)
  for (const p of payload.proposals) {
    lines.push(`    - ${describeProposal(p)}`)
  }
  lines.push("")
  lines.push("(dry run — `lodestar reflect` does not apply proposals; the host firewall does)")
  lines.push("")
  return lines.join("\n")
}

function describeProposal(p: ReflectionProposal): string {
  switch (p.kind) {
    case "claim_promotion":
      return `claim_promotion claim=${p.claim_id.slice(0, 8)} → ${p.target_truth_status}`
    case "belief_transition":
      return `belief_transition belief=${p.belief_id.slice(0, 8)} ${p.axis}: ${p.from_value} → ${p.to_value}`
    case "belief_supersession":
      return `belief_supersession ${p.old_belief_id.slice(0, 8)} → ${p.new_belief_id.slice(0, 8)}`
    case "decision_dependency_flagged":
      return `decision_dependency_flagged decision=${p.decision_id.slice(0, 8)} contradicted_belief=${p.contradicted_belief_id.slice(0, 8)}`
    case "no_op":
      return `no_op subject=${p.subject.kind}:${p.subject.id.slice(0, 24)}`
  }
}
