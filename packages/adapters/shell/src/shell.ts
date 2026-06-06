import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type Reversibility, type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * Native shell-command adapter for the Lodestar Action Kernel.
 *
 * Graduates the demo-shaped `dev-tools-mcp` server (three hardcoded tools) into
 * a configurable native adapter: the operator declares command *specs*, and each
 * becomes its own governed `Tool` with its own name and trust floor (so the
 * kernel's per-tool floor gives distinct trust per command for free).
 *
 * This is a TS-level audit / governance boundary, NOT an OS sandbox. It enforces:
 *
 *   - **Fixed binary, argv-only.** The binary is fixed by the spec; the agent
 *     supplies only args, which pass through the spec's `argsMatcher`. Commands
 *     run via `Bun.spawn` with an argv array (never a shell string), so inputs
 *     cannot inject extra commands or arguments.
 *   - **Allowlist.** `argsMatcher` IS the allowlist: it validates the requested
 *     args and returns the final args to run, or throws to reject the call before
 *     any process is spawned. A preset can inject safety flags the agent cannot
 *     see or override.
 *   - **No host-env passthrough.** The subprocess sees only the declared `env`;
 *     `process.env` is never spread in. The default is a minimal scoped env with a
 *     fresh empty HOME (no host dotfiles) and git's global/system config disabled.
 *   - **Wall-clock timeout.** Every command has a deadline; at the timeout the whole
 *     process group is killed (so a descendant that inherited the pipes is reclaimed,
 *     not just the immediate child) and `timed_out` is reported.
 *   - **Bounded output capture.** stdout/stderr are captured up to a byte cap and
 *     flagged when truncated; the child is still drained to EOF so it cannot block.
 *   - **Pinned cwd.** Every command runs in `workspaceRoot`; the agent cannot
 *     redirect it.
 *
 * What it does NOT claim: it does not OS-sandbox the code it runs (no namespaces,
 * cgroups, or network isolation). `shell.test` executes the workspace's own test
 * code; a command that internally `cd`s elsewhere is not prevented. OS-level
 * enforcement graduates separately (see `docs/architecture/v02-delta.md` §6 and
 * `.claude/adr/0004-native-shell-adapter-ts-level-sandbox.md`).
 */

// All shell command tools share one output schema; the specific tool name
// (e.g. "shell.test") rides on the observation's `source.tool`, so per-command
// provenance is preserved without a schema per command.
export const ShellRunOutputSchema = z
  .object({
    command: z.array(z.string()).describe("the exact argv executed (argv[0] is the fixed binary)"),
    exit_code: z.number().int().describe("process exit code; -1 if terminated by signal"),
    stdout: z.string(),
    stderr: z.string(),
    duration_ms: z.number().int().nonnegative(),
    timed_out: z.boolean().describe("true if the process was killed at the wall-clock deadline"),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
  })
  .describe("shell.run tool output")

// Idempotent: registering the same key twice throws ("bump the version"), but this
// module's registration is a process-global side effect at import time. Guard it so a
// double import (e.g. a test runner that loads this file via both its real path and a
// workspace self-symlink) is a harmless no-op rather than a crash.
if (!registry.has("shell.run@1")) {
  registry.register("shell.run@1", ShellRunOutputSchema)
}

const ShellRunInputSchema = z.object({
  args: z
    .array(z.string())
    .optional()
    .describe(
      "arguments after the fixed binary; validated and finalized by the command's argsMatcher",
    ),
})

export type ShellRunInput = z.infer<typeof ShellRunInputSchema>
export type ShellRunOutput = z.infer<typeof ShellRunOutputSchema>

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB per stream
const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
// After the deadline kills the process group, the pipes close and `close` fires
// promptly. This is a hard backstop so the call can never hang past the deadline if
// group-kill fails to close them (e.g. a descendant escaped into its own session).
const TIMEOUT_GRACE_MS = 500

/**
 * A single governed shell command. Each spec becomes one `Tool`.
 */
export interface ShellCommandSpec {
  /** Tool name in the form `namespace.action`, e.g. "shell.test". */
  name: string
  /** The exact binary (argv[0]). Fixed: the agent cannot substitute it. */
  bin: string
  /**
   * The allowlist. Receives the args the caller requested (after the binary) and
   * returns the *final* args to run, or throws to reject the call. Reject before
   * spawning by throwing; a preset may inject safety flags here.
   */
  argsMatcher: (requestedArgs: string[]) => string[]
  /** Minimum trust level required to invoke (the kernel enforces this as a floor). */
  trust: TrustLevel
  /** Reversibility of the command's side effects. */
  reversibility: Reversibility
  /** Declared world-state effects. Omit (or `[]`) for a read-only command. */
  effects?: Effect[]
  /** Declared permissions. Defaults to `["shell.exec"]`. */
  permissions?: Permission[]
  /** Wall-clock timeout in ms. Falls back to the adapter's `defaultTimeoutMs`. */
  timeoutMs?: number
  /** Human-facing description. */
  description?: string
}

/**
 * Adapter-wide settings shared by every command (everything but the command list).
 */
export interface ShellAdapterOptions {
  /** The cwd every command runs in. The agent cannot override it. */
  workspaceRoot: string
  /**
   * The COMPLETE environment the subprocess sees. `process.env` is never merged in.
   * When omitted, a minimal scoped env is created (fresh empty HOME, git config
   * disabled, PATH inherited) — mirroring the dev-tools-mcp `scopedEnv` pattern.
   */
  env?: Record<string, string>
  /** Max bytes captured per stream. Default 1 MiB. */
  maxOutputBytes?: number
  /** Default per-command timeout when a spec omits `timeoutMs`. Default 120s. */
  defaultTimeoutMs?: number
}

/**
 * Full adapter config: adapter-wide options plus the declared commands.
 */
export interface ShellAdapterConfig extends ShellAdapterOptions {
  commands: ShellCommandSpec[]
}

interface ResolvedOptions {
  workspaceRoot: string
  env: Record<string, string>
  maxOutputBytes: number
  defaultTimeoutMs: number
}

/**
 * The default scoped environment: a fresh empty HOME (so spawned tools read no
 * host dotfiles), git's global/system config neutralised (so an attacker-controlled
 * `~/.gitconfig` cannot influence anything), and PATH inherited so binaries resolve.
 * `process.env` is otherwise NOT passed through. Mirrors the Action Kernel's
 * "no host env to sandboxes" rule.
 */
export function defaultScopedEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lodestar-shell-home-"))
  const env: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }
  const path = process.env.PATH
  if (path !== undefined) env.PATH = path
  return env
}

function resolveOptions(options: ShellAdapterOptions): ResolvedOptions {
  return {
    workspaceRoot: resolve(options.workspaceRoot),
    env: options.env ?? defaultScopedEnv(),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Accumulate a child stream up to `maxBytes`, marking truncation. Buffers are kept
 * whole and decoded once, so a multibyte UTF-8 sequence spanning two `data` chunks is
 * not corrupted; only the final truncation boundary may split a code point (acceptable
 * for captured-for-audit output). The stream stays in flowing mode even past the cap
 * (we keep consuming, just stop storing), so a chatty child never blocks on a full pipe.
 */
interface StreamSink {
  readonly onData: (chunk: Buffer) => void
  text(): string
  truncated(): boolean
}

function makeStreamSink(maxBytes: number): StreamSink {
  const chunks: Buffer[] = []
  let stored = 0
  let truncated = false
  return {
    onData(chunk: Buffer): void {
      if (stored >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - stored
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        stored += chunk.length
      } else {
        chunks.push(chunk.subarray(0, remaining))
        stored += remaining
        truncated = true
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  }
}

async function runScoped(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number },
): Promise<ShellRunOutput> {
  const start = Date.now()
  const command = [bin, ...args]

  // `detached: true` puts the child in its OWN process group (POSIX setsid), so the
  // timeout can later signal the whole group by its negative pid — killing any
  // descendants it spawned, not just the immediate process. This is load-bearing:
  // a descendant that inherited the stdout/stderr pipes keeps them open, so killing
  // only the immediate child would leave the reads hanging and the descendant
  // orphaned, defeating the wall-clock timeout.
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  const stdoutSink = makeStreamSink(opts.maxOutputBytes)
  const stderrSink = makeStreamSink(opts.maxOutputBytes)
  child.stdout?.on("data", stdoutSink.onData)
  child.stderr?.on("data", stderrSink.onData)

  // Signal the child's whole process group (negative pid). Falls back to the lone
  // child if the platform has no process groups or the group is already gone.
  const killGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already exited */
      }
    }
  }

  let timedOut = false
  const exitCode = await new Promise<number>((resolveFn) => {
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolveFn(code)
    }
    const deadline = setTimeout(() => {
      timedOut = true
      killGroup("SIGKILL")
      // Once the group is SIGKILLed the pipes close and `close` fires promptly. If it
      // does not (a descendant escaped into its own session, or no group kill on this
      // platform), stop waiting anyway so the call never hangs past the deadline.
      graceTimer = setTimeout(() => finish(-1), TIMEOUT_GRACE_MS)
    }, opts.timeoutMs)

    // `close` (not `exit`) fires after every stdio stream reaches EOF, so the captured
    // output is complete; after a timeout kill, EOF arrives because the group is dead.
    child.once("close", (code) => finish(code ?? -1))
    child.once("error", () => finish(-1))
  })

  return {
    command,
    exit_code: exitCode,
    stdout: stdoutSink.text(),
    stderr: stderrSink.text(),
    duration_ms: Date.now() - start,
    timed_out: timedOut,
    stdout_truncated: stdoutSink.truncated(),
    stderr_truncated: stderrSink.truncated(),
  }
}

/**
 * Build one governed `Tool` from a command spec plus adapter-wide options.
 */
export function defineShellTool(
  spec: ShellCommandSpec,
  options: ShellAdapterOptions,
): Tool<ShellRunInput, ShellRunOutput> {
  const resolved = resolveOptions(options)
  const timeoutMs = spec.timeoutMs ?? resolved.defaultTimeoutMs
  return {
    name: spec.name,
    inputs: ShellRunInputSchema,
    output_schema_key: "shell.run@1",
    effects: spec.effects ?? [],
    reversibility: spec.reversibility,
    permissions: spec.permissions ?? ["shell.exec"],
    required_trust_level: spec.trust,
    sandbox: "controlled-shell",
    preconditions: () => [],
    execute: async (inputs) => {
      // The allowlist runs first and throws on a forbidden request, so nothing is
      // spawned for a rejected call. Args are finalized here (the binary is fixed).
      const finalArgs = spec.argsMatcher(inputs.args ?? [])
      return runScoped(spec.bin, finalArgs, {
        cwd: resolved.workspaceRoot,
        env: resolved.env,
        timeoutMs,
        maxOutputBytes: resolved.maxOutputBytes,
      })
    },
  }
}

/**
 * Build every governed `Tool` declared in a config. The scoped env (when not
 * supplied) is resolved once and shared across all tools.
 */
export function defineShellTools(
  config: ShellAdapterConfig,
): Tool<ShellRunInput, ShellRunOutput>[] {
  const resolved = resolveOptions(config)
  return config.commands.map((spec) => defineShellTool(spec, resolved))
}

/**
 * Build and register every governed `Tool` declared in a config. Returns the tools.
 */
export function registerShellTools(
  config: ShellAdapterConfig,
): Tool<ShellRunInput, ShellRunOutput>[] {
  const tools = defineShellTools(config)
  for (const tool of tools) {
    registerTool(tool)
  }
  return tools
}
