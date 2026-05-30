import type { EventEnvelope, SentinelSeverity } from "@qmilab/lodestar-core"
import { Sentinel, type SentinelFinding, asActionView } from "../sentinel.js"

/**
 * One step in a suspicious tool sequence. Matched against an executed
 * action. A bare string is a substring match on the tool key; a RegExp is
 * tested against the tool key; the object form lets a step key off the
 * action contract (e.g. `blast_radius: "external"` for "reaches outside the
 * project") in addition to, or instead of, the tool name. Object fields are
 * ANDed.
 */
export type ToolStepMatcher = string | RegExp | { tool?: string | RegExp; blast_radius?: string }

/**
 * A named suspicious sequence. `steps` are matched as an *ordered
 * subsequence* (benign tool calls may interleave) that must *complete* at
 * the current event — the sentinel fires once, when the final step lands.
 */
export interface SuspiciousSequence {
  id: string
  description: string
  /** Defaults to "critical" — a matched sequence maps onto a concrete attack. */
  severity?: SentinelSeverity
  steps: ToolStepMatcher[]
}

interface ExecutedStep {
  tool?: string
  blast_radius?: string
  eventId: string
  actionId: string
}

/**
 * The classic exfiltration shape: read local data, push it somewhere
 * external, then write/commit — read-secret → exfiltrate → overwrite-tracks.
 * The egress step keys off `blast_radius: "external"` (the contract-level
 * signal that an action reaches outside the project) rather than guessing
 * tool names, which is the robust way to spot egress regardless of how the
 * tool is named.
 */
export const DEFAULT_SUSPICIOUS_SEQUENCES: readonly SuspiciousSequence[] = [
  {
    id: "read-egress-write",
    description:
      "Local read, then an external-egress action, then a write — the read-secret → exfiltrate → cover-tracks exfiltration shape.",
    severity: "critical",
    steps: [
      { tool: /(^|\.)(read|get|cat|load|open|fetch_file)/i },
      { blast_radius: "external" },
      { tool: /(^|\.)(write|put|save|commit|push|delete|update)/i },
    ],
  },
]

/**
 * Anomalous tool sequence sentinel.
 *
 * Roadmap (Batch 4): "Pattern-matches against known suspicious sequences
 * (e.g. `fs.read` → `network.egress` → `fs.write`) and surfaces them for
 * review."
 *
 * Watches executed actions per session and fires when a configured
 * sequence completes. Sequences are matched as ordered subsequences within
 * a bounded per-session window, so an attacker cannot evade detection by
 * interleaving a few benign calls — but the match must *end* at the current
 * event, so each completion alerts exactly once rather than re-firing on
 * every subsequent tool call.
 *
 * Which events count as "a tool ran" is configurable (`watchPhases`),
 * defaulting to `action.completed` — the phase that means the side effect
 * actually happened. Proposed-but-rejected actions do not run, so they do
 * not extend a sequence by default.
 */
export class AnomalousToolSequenceSentinel extends Sentinel {
  readonly name = "anomalous-tool-sequence"
  readonly description =
    "Flags a session whose executed tool calls match a known-suspicious ordered sequence (e.g. read → external egress → write)."

  private readonly sequences: readonly SuspiciousSequence[]
  private readonly watchPhases: ReadonlySet<string>
  private readonly windowSize: number
  /** session_id -> bounded window of executed steps */
  private readonly windows = new Map<string, ExecutedStep[]>()

  constructor(
    options: {
      sequences?: readonly SuspiciousSequence[]
      watchPhases?: readonly string[]
      windowSize?: number
    } = {},
  ) {
    super()
    this.sequences = options.sequences ?? DEFAULT_SUSPICIOUS_SEQUENCES
    this.watchPhases = new Set(options.watchPhases ?? ["action.completed"])
    const longest = this.sequences.reduce((m, s) => Math.max(m, s.steps.length), 0)
    // Window must hold at least the longest sequence; default headroom lets
    // benign calls interleave without pushing the pattern's earlier steps
    // out of view.
    this.windowSize = Math.max(options.windowSize ?? 16, longest)
  }

  inspect(event: EventEnvelope): SentinelFinding[] {
    if (!this.watchPhases.has(event.type)) return []
    const action = asActionView(event.payload)
    if (!action) return []

    const window = this.windows.get(event.session_id) ?? []
    window.push({
      tool: action.tool,
      blast_radius: action.contract?.blast_radius,
      eventId: event.id,
      actionId: action.id,
    })
    if (window.length > this.windowSize) window.splice(0, window.length - this.windowSize)
    this.windows.set(event.session_id, window)

    const findings: SentinelFinding[] = []
    const consumed = new Set<string>()
    for (const sequence of this.sequences) {
      const run = matchOrderedSubsequenceEndingAtLast(window, sequence.steps)
      if (!run) continue
      for (const step of run) consumed.add(step.eventId)
      findings.push({
        rule: sequence.id,
        severity: sequence.severity ?? "critical",
        subject: { kind: "tool_sequence", id: action.id },
        message:
          `Session ${event.session_id} completed suspicious tool sequence '${sequence.id}': ` +
          `${run.map((s) => s.tool ?? "<unknown>").join(" → ")}. ${sequence.description}`,
        observed_event_ids: run.map((s) => s.eventId),
        detail: {
          sequence_id: sequence.id,
          session_id: event.session_id,
          steps: run.map((s) => ({
            tool: s.tool,
            blast_radius: s.blast_radius,
            action_id: s.actionId,
            event_id: s.eventId,
          })),
        },
      })
    }
    // Consume the steps that formed a match so the same read/egress prefix
    // cannot be re-paired with a *later* final step and re-alert. A genuinely
    // fresh sequence (new read → new egress → new write) still fires.
    if (consumed.size > 0) {
      this.windows.set(
        event.session_id,
        window.filter((s) => !consumed.has(s.eventId)),
      )
    }
    return findings
  }

  override onSessionEnd(sessionId: string): void {
    this.windows.delete(sessionId)
  }
}

/**
 * Test a regex without leaking state across calls. A caller-supplied matcher
 * with the `g` or `y` flag carries a mutable `lastIndex`, so a plain
 * `re.test(s)` would resume from the previous match position and match
 * sporadically — which an attacker could exploit to slip a step past the
 * sequence. Resetting `lastIndex` first makes every test independent. (The
 * built-in patterns are non-global, so this is a no-op for them.)
 */
function regexTest(re: RegExp, value: string): boolean {
  re.lastIndex = 0
  return re.test(value)
}

function stepMatches(step: ExecutedStep, matcher: ToolStepMatcher): boolean {
  if (typeof matcher === "string") return step.tool?.includes(matcher) ?? false
  if (matcher instanceof RegExp) return step.tool !== undefined && regexTest(matcher, step.tool)
  // Object form: every provided field must match (AND). An empty object
  // would match anything, which is a misconfiguration — treat it as no match.
  let constrained = false
  if (matcher.tool !== undefined) {
    constrained = true
    const toolOk =
      typeof matcher.tool === "string"
        ? (step.tool?.includes(matcher.tool) ?? false)
        : step.tool !== undefined && regexTest(matcher.tool, step.tool)
    if (!toolOk) return false
  }
  if (matcher.blast_radius !== undefined) {
    constrained = true
    if (step.blast_radius !== matcher.blast_radius) return false
  }
  return constrained
}

/**
 * Match `matchers` against `window` as an ordered subsequence that must end
 * at the last element of `window` (the just-pushed step). Returns the
 * matched steps in order on success, or `null`. Greedy: matches each
 * matcher against the earliest still-available later element, which is
 * sufficient because the rule only asks whether *a* completion exists now.
 */
function matchOrderedSubsequenceEndingAtLast(
  window: ExecutedStep[],
  matchers: ToolStepMatcher[],
): ExecutedStep[] | null {
  const last = window[window.length - 1]
  const lastMatcher = matchers[matchers.length - 1]
  if (matchers.length === 0 || last === undefined || lastMatcher === undefined) return null
  if (!stepMatches(last, lastMatcher)) return null

  const matched: ExecutedStep[] = []
  let mi = 0
  for (let wi = 0; wi < window.length - 1 && mi < matchers.length - 1; wi++) {
    const step = window[wi]
    const matcher = matchers[mi]
    if (step !== undefined && matcher !== undefined && stepMatches(step, matcher)) {
      matched.push(step)
      mi++
    }
  }
  if (mi !== matchers.length - 1) return null
  matched.push(last)
  return matched
}
