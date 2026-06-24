import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * The writer-free guarantee for the `@qmilab/lodestar-guard/approval-channel`
 * subpath (ADR-0030). The whole point of the subpath is that a consumer can link
 * the approval transport + signed-resolution reader WITHOUT dragging the write-side
 * runtime that the `.` barrel pulls in (action-kernel, memory-firewall,
 * cognitive-core, harness). This test makes that property enforced, not intended:
 * it statically walks the module graph reachable from `channel.ts` and asserts the
 * transitive RUNTIME imports stay within `{ @qmilab/lodestar-core, zod, node:* }`.
 *
 * "RUNTIME" excludes `import type` / `export type` re-exports (erased from `dist`),
 * so the lone action-kernel edge in the graph — a type-only
 * `import type { ApprovalOutcome }` in `approvals-channel.ts` — must NOT appear.
 */

// Bare packages a writer-free channel client may link. node:* is always allowed.
const ALLOWED_BARE = new Set(["@qmilab/lodestar-core", "zod"])

// Write-side / kernel modules that must never appear in the runtime graph. Listed
// explicitly (beyond the subset check) so a regression names the offender.
const FORBIDDEN_BARE = [
  "@qmilab/lodestar-action-kernel",
  "@qmilab/lodestar-event-log",
  "@qmilab/lodestar-memory-firewall",
  "@qmilab/lodestar-cognitive-core",
  "@qmilab/lodestar-harness",
  "@qmilab/lodestar-policy-kernel",
]

/** A module specifier reached at runtime, with the file that imported it. */
interface Edge {
  spec: string
  from: string
}

// Matches `import [type] … from "X"` and `export [type] … from "X"` at the start
// of a line (so prose inside block comments is ignored). The `[^;=]*?` between the
// keyword and `from` cannot cross a declaration (`export const X = …`) or a
// statement boundary, so a non-re-export keyword never steals a later `from`.
const FROM_RE = /^[ \t]*(import|export)\b[ \t]+(type\b[ \t]+)?[^;=]*?\bfrom[ \t]*["']([^"']+)["']/gm
// Bare side-effect import: `import "X"`. (Always runtime.)
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]+["']([^"']+)["']/gm
// Dynamic import: `import("X")`. (Always runtime.)
const DYNAMIC_RE = /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g

/** Resolve a relative specifier (written ESM-style with `.js`) to its `.ts` source. */
function resolveRelative(spec: string, fromFile: string): string {
  const base = resolve(dirname(fromFile), spec)
  const asTs = base.replace(/\.js$/, ".ts")
  if (existsSync(asTs)) return asTs
  if (existsSync(base)) return base
  throw new Error(`cannot resolve relative import ${spec} from ${fromFile}`)
}

/**
 * Walk the runtime module graph from `entry`, returning every distinct bare-package
 * edge. Relative imports are followed; `import type` / `export type` re-exports are
 * skipped (erased at compile, no runtime edge); `node:*` edges are recorded too.
 */
function walkRuntimeGraph(entry: string): Edge[] {
  const bareEdges: Edge[] = []
  const seen = new Set<string>()

  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, "utf8")

    const record = (spec: string, isTypeOnly: boolean): void => {
      if (isTypeOnly) return // erased — no runtime edge
      if (spec.startsWith(".")) {
        visit(resolveRelative(spec, file))
        return
      }
      bareEdges.push({ spec, from: file })
    }

    for (const m of text.matchAll(FROM_RE)) record(m[3]!, m[2] !== undefined)
    for (const m of text.matchAll(SIDE_EFFECT_RE)) record(m[1]!, false)
    for (const m of text.matchAll(DYNAMIC_RE)) record(m[1]!, false)
  }

  visit(entry)
  return bareEdges
}

// Anchor reads to the package root, not `import.meta.dir`: guard ships its test
// files into `dist/` too (CI builds before `bun test`), so this file runs from
// both `src/` and `dist/`. Both are direct children of the package root, so `..`
// always lands there — and the static walk always reads the `.ts` SOURCE (where
// the type-only action-kernel import still exists, pre-erasure).
const PKG_ROOT = resolve(import.meta.dir, "..")
const SRC_DIR = join(PKG_ROOT, "src")
const CHANNEL_SRC = join(SRC_DIR, "channel.ts")
const CHANNEL_DIST = join(PKG_ROOT, "dist", "channel.js")

describe("approval-channel subpath is writer-free (ADR-0030)", () => {
  test("source graph runtime imports ⊆ { @qmilab/lodestar-core, zod, node:* }", () => {
    const edges = walkRuntimeGraph(CHANNEL_SRC)
    // Guard against a silent false-pass: if the parser ever stopped descending,
    // the graph would be empty and the subset check below would pass vacuously.
    // Assert the walk actually reached the two relative modules' real edges.
    const specs = new Set(edges.map((e) => e.spec))
    expect(specs.has("@qmilab/lodestar-core"), "walk must reach core (traversal sanity)").toBe(true)
    expect(specs.has("zod"), "walk must reach zod (traversal sanity)").toBe(true)
    const offenders = edges.filter((e) => !e.spec.startsWith("node:") && !ALLOWED_BARE.has(e.spec))
    expect(
      offenders,
      `channel.ts must not link the write side; saw: ${offenders
        .map((e) => `${e.spec} (via ${e.from.replace(SRC_DIR, ".")})`)
        .join(", ")}`,
    ).toEqual([])
  })

  test("no write-side / kernel module is reachable at runtime", () => {
    const specs = new Set(walkRuntimeGraph(CHANNEL_SRC).map((e) => e.spec))
    for (const forbidden of FORBIDDEN_BARE) {
      expect(specs.has(forbidden), `${forbidden} must not be a runtime edge`).toBe(false)
    }
  })

  test("the type-only action-kernel edge exists in source but is erased (the thing we rely on)", () => {
    // approvals-channel.ts carries `import type { ApprovalOutcome } from
    // "@qmilab/lodestar-action-kernel"`. Confirm it is present AND that it is the
    // ONLY action-kernel reference — i.e. the writer-free property rests entirely
    // on it being type-only, not on action-kernel being absent from the source.
    const approvals = readFileSync(join(SRC_DIR, "approvals-channel.ts"), "utf8")
    expect(approvals).toContain(
      'import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"',
    )
    const runtimeRefs = approvals
      .split("\n")
      .filter((l) => l.includes("@qmilab/lodestar-action-kernel") && !/^\s*import type\b/.test(l))
    expect(runtimeRefs, "action-kernel must only ever be a type-only import").toEqual([])
  })

  test("built dist graph (if present) is also writer-free", () => {
    if (!existsSync(CHANNEL_DIST)) return // dist not built in this run; CI builds first
    const edges = walkRuntimeGraph(CHANNEL_DIST)
    const offenders = edges.filter((e) => !e.spec.startsWith("node:") && !ALLOWED_BARE.has(e.spec))
    expect(offenders.map((e) => e.spec)).toEqual([])
  })

  test("the subpath specifier resolves and re-exports the channel + reader surface", async () => {
    const mod = await import("@qmilab/lodestar-guard/approval-channel")
    // Transport seam (./approval-channel.js)
    expect(typeof mod.createApprovalChannel).toBe("function")
    expect(typeof mod.FileApprovalChannel).toBe("function")
    expect(typeof mod.HttpApprovalChannel).toBe("function")
    expect(typeof mod.httpChannelForbidsUnsigned).toBe("function")
    expect(mod.ApprovalChannelConfigSchema).toBeDefined()
    // Signed wire reader (./approvals-channel.js)
    expect(mod.ApprovalResolutionSchema).toBeDefined()
    expect(typeof mod.readApprovalResolution).toBe("function")
    expect(typeof mod.resolutionToOutcome).toBe("function")
  })
})
