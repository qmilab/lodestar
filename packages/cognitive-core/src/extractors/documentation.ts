import type { Claim } from "@qmilab/lodestar-core"
import type { ClaimExtractor, ExtractionInput } from "./base.js"

/**
 * Observation schema key for documentation source files. Registered by
 * the filesystem adapter's `doc.read` tool. The payload shape below is
 * kept in sync with the adapter by convention — the same arrangement
 * `fs.read@1` uses between the adapter (which registers the Zod schema)
 * and {@link FsReadExtractor} (which casts the payload).
 */
export const DOCUMENTATION_SOURCE_SCHEMA_KEY = "documentation.source@1"

/** Payload of a `documentation.source@1` observation. */
export interface DocumentationSourcePayload {
  path: string
  /** How the bytes should be interpreted for claim extraction. */
  kind: "package_json" | "markdown" | "source"
  contents: string
  bytes: number
  truncated: boolean
}

// Caps keep a single noisy file from flooding the report / belief store.
const MAX_DEPS = 12
const MAX_HEADINGS = 8
const MAX_COMMANDS = 6
const MAX_SIGNATURES = 12

type PredicateShape = { subject: string; relation: string; object: unknown }

/**
 * Schema-bound extractor for `documentation.source@1` observations.
 *
 * Unlike {@link FsReadExtractor} — which emits a single envelope claim
 * ("file X exists with size N") — this extractor reads *into* the bytes
 * and emits semantic content claims:
 *
 * - `package_json` → one claim per declared dependency, plus name/version
 *   and main entry.
 * - `markdown`     → the title, section headings, and documented commands.
 * - `source`       → the signature of each exported function.
 *
 * The claims are exactly what a documentation agent reasons over when it
 * decides whether a docstring or README section is stale. Every claim is
 * deterministic (no LLM) and carries `source_observation_ids` back to the
 * file it came from, so the {@link DocAwareEvidenceLinker} can attribute
 * each claim to its source and the trust report can show the provenance.
 */
export const DocumentationExtractor: ClaimExtractor = {
  schema_key: DOCUMENTATION_SOURCE_SCHEMA_KEY,
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = obs.payload as DocumentationSourcePayload
    const ctx = input.context
    const now = new Date().toISOString()

    const make = (statement: string, predicate: PredicateShape): Claim => ({
      id: crypto.randomUUID(),
      statement,
      structured_predicate: predicate,
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })

    switch (payload.kind) {
      case "package_json":
        return extractPackageJson(payload, make)
      case "markdown":
        return extractMarkdown(payload, make)
      case "source":
        return extractSource(payload, make)
    }
  },
}

function extractPackageJson(
  payload: DocumentationSourcePayload,
  make: (statement: string, predicate: PredicateShape) => Claim,
): Claim[] {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(payload.contents) as Record<string, unknown>
  } catch {
    return [
      make(`'${payload.path}' is not valid JSON.`, {
        subject: `file:${payload.path}`,
        relation: "parse_status",
        object: "invalid_json",
      }),
    ]
  }

  const claims: Claim[] = []
  const name = typeof pkg.name === "string" ? pkg.name : payload.path
  const version = typeof pkg.version === "string" ? pkg.version : "unknown"
  claims.push(
    make(`Package '${name}' is at version ${version}.`, {
      subject: `package:${name}`,
      relation: "declares_version",
      object: version,
    }),
  )
  if (typeof pkg.main === "string") {
    claims.push(
      make(`Package '${name}' main entry is '${pkg.main}'.`, {
        subject: `package:${name}`,
        relation: "declares_main",
        object: pkg.main,
      }),
    )
  }
  const deps =
    pkg.dependencies && typeof pkg.dependencies === "object"
      ? (pkg.dependencies as Record<string, unknown>)
      : {}
  for (const dep of Object.keys(deps).slice(0, MAX_DEPS)) {
    const ver = typeof deps[dep] === "string" ? (deps[dep] as string) : "?"
    claims.push(
      make(`Package '${name}' depends on ${dep}@${ver}.`, {
        subject: `package:${name}`,
        relation: "declares_dependency",
        object: `${dep}@${ver}`,
      }),
    )
  }
  return claims
}

function extractMarkdown(
  payload: DocumentationSourcePayload,
  make: (statement: string, predicate: PredicateShape) => Claim,
): Claim[] {
  const claims: Claim[] = []
  const lines = payload.contents.split(/\r?\n/)

  const titleLine = lines.find((l) => /^#\s+/.test(l))
  if (titleLine) {
    const title = titleLine.replace(/^#\s+/, "").trim()
    claims.push(
      make(`Documentation '${payload.path}' is titled '${title}'.`, {
        subject: `doc:${payload.path}`,
        relation: "declares_title",
        object: title,
      }),
    )
  }

  const headings = lines
    .filter((l) => /^#{2,3}\s+/.test(l))
    .map((l) => l.replace(/^#+\s+/, "").trim())
    .slice(0, MAX_HEADINGS)
  for (const heading of headings) {
    claims.push(
      make(`'${payload.path}' documents a section '${heading}'.`, {
        subject: `doc:${payload.path}`,
        relation: "documents_section",
        object: heading,
      }),
    )
  }

  for (const cmd of extractCommands(payload.contents).slice(0, MAX_COMMANDS)) {
    claims.push(
      make(`'${payload.path}' documents the command \`${cmd}\`.`, {
        subject: `doc:${payload.path}`,
        relation: "documents_command",
        object: cmd,
      }),
    )
  }

  if (claims.length === 0) {
    claims.push(
      make(`'${payload.path}' is a documentation file (${payload.bytes} bytes).`, {
        subject: `doc:${payload.path}`,
        relation: "is_documentation",
        object: payload.bytes,
      }),
    )
  }
  return claims
}

/** Pull CLI-looking invocations out of markdown (fenced or inline). */
function extractCommands(contents: string): string[] {
  const prefix = /^(lodestar|bun|npm|npx|git|pnpm|yarn)\s+\S/
  const seen = new Set<string>()
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/^\s*\$\s*/, "").trim()
    if (prefix.test(line)) seen.add(line)
  }
  return Array.from(seen)
}

function extractSource(
  payload: DocumentationSourcePayload,
  make: (statement: string, predicate: PredicateShape) => Claim,
): Claim[] {
  const claims: Claim[] = []
  const sigRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null = sigRe.exec(payload.contents)
  let count = 0
  while (match !== null && count < MAX_SIGNATURES) {
    const fnName = match[1] ?? "anonymous"
    const params = parseParamNames(match[2] ?? "")
    claims.push(
      make(
        `Function \`${fnName}\` in '${payload.path}' takes parameters (${params.join(", ") || "none"}).`,
        {
          subject: `function:${fnName}`,
          relation: "has_signature",
          object: params,
        },
      ),
    )
    count++
    match = sigRe.exec(payload.contents)
  }
  if (claims.length === 0) {
    claims.push(
      make(
        `Source file '${payload.path}' (${payload.bytes} bytes) declares no exported functions.`,
        {
          subject: `file:${payload.path}`,
          relation: "source_summary",
          object: payload.bytes,
        },
      ),
    )
  }
  return claims
}

/**
 * Parse parameter *names* from a parameter list, stripping types and the
 * optional `?` marker. Splits on top-level commas only, so generics like
 * `Map<string, number>` don't fragment.
 */
function parseParamNames(paramList: string): string[] {
  const names: string[] = []
  for (const part of splitTopLevel(paramList)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const name = (trimmed.split(":")[0] ?? "").replace(/[?\s]/g, "")
    if (name) names.push(name)
  }
  return names
}

/** Split on commas that are not nested inside <>, (), [], or {}. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of input) {
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1)
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}
