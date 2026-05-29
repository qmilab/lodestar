import { resolve } from "node:path"
import {
  type AgentLoop,
  type GuardConfig,
  alwaysHoldsChecker,
  autoApprovePolicy,
  runGuarded,
} from "@qmilab/lodestar-guard"
import { defaultLogRoot } from "@qmilab/lodestar-trace"

/**
 * `lodestar guard wrap --target <module> [--project <id>] [--actor <id>] [--log-root <path>]`
 *
 * Programmatic surface for experimentation: import a JS/TS module that
 * default-exports an {@link AgentLoop}, then run it under a guarded
 * session with a starter policy preset. The session_id is printed so
 * the caller can immediately render the report with
 * `lodestar report <session-id>`.
 *
 * The target module is expected to:
 *
 *   export default async function loop(ctx) { ... }
 *
 * The CLI does NOT supply a tool registry — the loop module is
 * responsible for registering whichever adapters/tools it needs
 * before calling `ctx.callTool`. The CLI's job is to wire the trust
 * layer around it.
 */
export async function guardWrapCommand(argv: string[]): Promise<number> {
  let target: string | undefined
  let project_id = "lodestar-guard-cli"
  let actor_id = "guard-cli"
  let log_root = defaultLogRoot()
  let auto_approve_up_to = 2

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--target" || arg === "-t") {
      target = argv[++i]
    } else if (arg === "--project" || arg === "-p") {
      const next = argv[++i]
      if (next) project_id = next
    } else if (arg === "--actor" || arg === "-a") {
      const next = argv[++i]
      if (next) actor_id = next
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg === "--auto-approve-up-to") {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 4) {
        process.stderr.write(
          `--auto-approve-up-to must be an integer in [0,4]; got '${next}'. L5 is prohibited and cannot be auto-approved.\n`,
        )
        return 2
      }
      auto_approve_up_to = parsed
    }
  }

  if (!target) {
    process.stderr.write(
      "usage: lodestar guard wrap --target <module> [--project <id>] [--actor <id>]\n" +
        "       [--log-root <path>] [--auto-approve-up-to <0..5>]\n",
    )
    return 2
  }

  const targetPath = resolve(process.cwd(), target)
  let loop: AgentLoop<unknown>
  try {
    const mod = await import(targetPath)
    const candidate = mod.default ?? mod.loop
    if (typeof candidate !== "function") {
      process.stderr.write(
        `target module '${target}' must default-export an async (ctx) => Promise<T> function.\n`,
      )
      return 2
    }
    loop = candidate as AgentLoop<unknown>
  } catch (err) {
    process.stderr.write(
      `failed to load target '${target}': ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 3
  }

  const config: GuardConfig = {
    project_id,
    actor_id,
    log_root,
    default_scope: { level: "project", identifier: project_id },
    default_sensitivity: "internal",
    policy_gate: autoApprovePolicy({
      auto_approve_up_to: auto_approve_up_to as 0 | 1 | 2 | 3 | 4,
      approver_id: "lodestar-cli-policy",
    }),
    precondition_checker: alwaysHoldsChecker,
  }

  try {
    const run = await runGuarded(loop, config)
    process.stderr.write(`[guard] session ${run.session_id}\n`)
    process.stderr.write(`[guard] log root ${run.log_root}\n`)
    process.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`)
    process.stderr.write(`[guard] render with: lodestar report ${run.session_id}\n`)
    return 0
  } catch (err) {
    process.stderr.write(
      `[guard] session failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}
