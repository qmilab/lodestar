import type { FreshnessStatus, RetrievalStatus, SecurityStatus, TruthStatus } from "@qmilab/lodestar-core"
import type { LifecycleAxis } from "./stores/belief-store"

/**
 * Allowed lifecycle transitions, by axis.
 *
 * Each transition declares:
 * - from: starting value
 * - to: ending value
 * - authority: who is allowed to perform this transition
 *
 * Authorities are coarse role tokens. The Policy Kernel checks the
 * acting Actor's role against the required authority before allowing
 * the firewall to apply a transition.
 */

export type TransitionAuthority =
  | "user"            // explicit user confirmation
  | "policy"          // policy configuration
  | "probe"           // harness probe verified
  | "sentinel"        // sentinel raised a finding
  | "reflection"      // reflection pass with confirming evidence
  | "auto_observation" // narrow auto-promotion from fresh tool observation
  | "system"          // freshness decay, etc.

export interface Transition<T extends string> {
  from: T
  to: T
  authorities: TransitionAuthority[]
}

export const TRUTH_TRANSITIONS: Transition<TruthStatus>[] = [
  // Promotion paths
  { from: "unverified", to: "supported", authorities: ["user", "probe", "reflection", "auto_observation"] },
  { from: "unverified", to: "contradicted", authorities: ["user", "probe", "sentinel", "reflection"] },

  // Counter-promotion: anyone with evidence can contradict
  { from: "supported", to: "contradicted", authorities: ["user", "probe", "sentinel", "reflection"] },

  // Supersession requires a successor belief
  { from: "supported", to: "superseded", authorities: ["user", "reflection"] },
  { from: "contradicted", to: "superseded", authorities: ["user", "reflection"] },

  // Restoration from contradicted: only user or probe
  { from: "contradicted", to: "supported", authorities: ["user", "probe"] },
]

export const RETRIEVAL_TRANSITIONS: Transition<RetrievalStatus>[] = [
  // Normal promotion path
  { from: "hidden", to: "restricted", authorities: ["user", "reflection"] },
  { from: "restricted", to: "normal", authorities: ["user", "probe"] },
  { from: "normal", to: "privileged_only", authorities: ["user", "policy"] },

  // Demotion: easier than promotion. Sentinels can demote.
  { from: "normal", to: "restricted", authorities: ["user", "policy", "sentinel"] },
  { from: "normal", to: "hidden", authorities: ["user", "policy", "sentinel"] },
  { from: "restricted", to: "hidden", authorities: ["user", "policy", "sentinel"] },
  { from: "privileged_only", to: "restricted", authorities: ["user", "policy"] },

  // Blocking is a hard demotion any sentinel can apply.
  { from: "normal", to: "blocked", authorities: ["user", "policy", "sentinel"] },
  { from: "restricted", to: "blocked", authorities: ["user", "policy", "sentinel"] },
  { from: "hidden", to: "blocked", authorities: ["user", "policy", "sentinel"] },
  { from: "privileged_only", to: "blocked", authorities: ["user", "policy", "sentinel"] },

  // Unblocking requires user only — never policy, never sentinel
  { from: "blocked", to: "hidden", authorities: ["user"] },
]

export const SECURITY_TRANSITIONS: Transition<SecurityStatus>[] = [
  // Suspicion can come from any sentinel or probe
  { from: "clean", to: "suspicious", authorities: ["sentinel", "probe", "user"] },

  // Quarantine is one direction: clean → quarantined is allowed,
  // but quarantined → clean requires explicit user clearance.
  { from: "suspicious", to: "quarantined", authorities: ["sentinel", "probe", "user"] },
  { from: "clean", to: "quarantined", authorities: ["sentinel", "probe", "user"] },
  { from: "quarantined", to: "malicious", authorities: ["sentinel", "user"] },

  // Clearance: USER ONLY. Sentinels cannot un-quarantine.
  { from: "suspicious", to: "clean", authorities: ["user"] },
  { from: "quarantined", to: "clean", authorities: ["user"] },
  // Malicious is terminal — no path back.
]

export const FRESHNESS_TRANSITIONS: Transition<FreshnessStatus>[] = [
  // Decay path
  { from: "fresh", to: "stale", authorities: ["system"] },
  { from: "stale", to: "expired", authorities: ["system"] },

  // Refresh: user, probe, or fresh observation
  { from: "stale", to: "fresh", authorities: ["user", "probe", "auto_observation"] },
  { from: "expired", to: "fresh", authorities: ["user", "probe", "auto_observation"] },
]

const TABLES: Record<LifecycleAxis, Transition<string>[]> = {
  truth_status: TRUTH_TRANSITIONS,
  retrieval_status: RETRIEVAL_TRANSITIONS,
  security_status: SECURITY_TRANSITIONS,
  freshness_status: FRESHNESS_TRANSITIONS,
}

/**
 * Check whether a proposed transition is allowed.
 */
export function isTransitionAllowed(
  axis: LifecycleAxis,
  from: string,
  to: string,
  authority: TransitionAuthority,
): boolean {
  const table = TABLES[axis]
  return table.some(
    (t) => t.from === from && t.to === to && t.authorities.includes(authority),
  )
}

/**
 * Get the list of authorities that can make a given transition.
 * Returns empty array if the transition is not allowed at all.
 */
export function authoritiesFor(
  axis: LifecycleAxis,
  from: string,
  to: string,
): TransitionAuthority[] {
  const table = TABLES[axis]
  const found = table.find((t) => t.from === from && t.to === to)
  return found?.authorities ?? []
}
