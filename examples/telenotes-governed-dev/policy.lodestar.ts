/**
 * Telenotes governance policy.
 *
 * This file lives in `examples/`, not in `packages/`. The trust ladder
 * and contract types come from `@qmilab/lodestar-core`; the Telenotes-specific
 * defaults below are example configuration.
 *
 * Week 1: stub. The real Telenotes policy with full action coverage
 * arrives in week 7.
 */

import type { TrustLevel } from "@qmilab/lodestar-core"

export interface ToolPolicy {
  tool: string
  default_level: TrustLevel
  scope_overrides?: Array<{
    scope_match: string
    level: TrustLevel
    reason: string
  }>
  notes?: string
}

/**
 * Conservative v0 defaults. External effects start at L4.
 * Promotions to lower trust levels require calibrator or user evidence.
 */
export const TELENOTES_TOOL_POLICIES: ToolPolicy[] = [
  { tool: "fs.read", default_level: 0 },
  { tool: "git.status", default_level: 0 },

  // Week 5+ tools below. Listed here so the policy table is complete.
  { tool: "fs.write", default_level: 3, notes: "modifying repo state; reversible via git" },
  { tool: "git.commit", default_level: 3 },
  {
    tool: "git.push",
    default_level: 4,
    scope_overrides: [{ scope_match: "branch:main", level: 5, reason: "main branch is PR-only" }],
  },
  { tool: "github.pr.create", default_level: 4 },
  { tool: "github.pr.merge", default_level: 4, notes: "main only; dual-confirm" },
  { tool: "shell.test", default_level: 3, notes: "test runner only; no install" },
  { tool: "shell.lint", default_level: 3 },
  { tool: "nostr.sign", default_level: 4, notes: "approval per signing event in v0" },
  {
    tool: "nostr.key.export",
    default_level: 5,
    notes: "prohibited at kernel level; user handles directly",
  },
  { tool: "deploy.stage", default_level: 4 },
  { tool: "deploy.prod", default_level: 4, notes: "dual-confirm at approval surface" },
]
