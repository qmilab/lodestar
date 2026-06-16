import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type PackIndex,
  type PackIndexEntry,
  PackIndexSchema,
  type PinnedPublicKeys,
  canonicalPackIndexHash,
  publicKeyPemFromPrivate,
  signPackIndex,
  verifyPackIndexSignature,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"

/**
 * Pack discovery index — the harness's read-side fetch + verify + query (ADR-0021,
 * #87). Core owns the index wire format and the pure sign/verify; this is the I/O
 * half: fetching a static index from where it is hosted, verifying it against the
 * operator's pinned **index-publisher** keys, and the thin local query over verified
 * indexes. Same core-owns-format / harness-owns-resolution split the loader follows.
 *
 * Discovery is a protocol, not a service (ADR-0016 §1): an index is a plain JSON
 * document hostable anywhere, fetched read-only. It is an **advertisement, not an
 * authority** — `searchPackIndexes` only filters listings; resolving and installing a
 * discovered pack still routes through `addProbePack` (#86/#88) against pinned author
 * keys, so a hostile index can mis-list or omit but never make a forged pack verify.
 */

/** Default cap on a fetched index's size — a guard against a hostile/huge response. */
const DEFAULT_MAX_INDEX_BYTES = 5 * 1024 * 1024

export interface FetchPackIndexOptions {
  /** Max bytes accepted from a remote index. Defaults to 5 MiB; exceeding it throws. */
  maxBytes?: number
  /** Injectable `fetch` (tests pass a local capture). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Where an index lives. A bare path or `file:<path>` is read from disk (resolved
 * against the cwd); an `http(s)://` URL is fetched read-only. The fetch is a plain GET
 * of a static document — no auth, no lifecycle, no following of anything but the JSON
 * body — because an index carries no secrets and grants no capability; the real trust
 * boundary is the signature check below and the pack verify on add.
 */
function classifySource(
  source: string,
): { kind: "remote"; url: string } | { kind: "local"; path: string } {
  if (/^https?:\/\//i.test(source)) return { kind: "remote", url: source }
  const path = source.startsWith("file:") ? source.slice("file:".length) : source
  return { kind: "local", path: resolve(path) }
}

/**
 * Read a fetch `Response` body to a UTF-8 string, enforcing the byte cap *before*
 * buffering the whole thing. A declared `Content-Length` over the cap is rejected
 * up front; then the body is streamed and aborted the moment the running byte count
 * exceeds the cap — so a hostile or misconfigured endpoint with a missing or lying
 * length cannot force the process to buffer an unbounded response. Falls back to a
 * capped `arrayBuffer()` only when the Response exposes no stream (e.g. a synthetic
 * Response in a test), which is still bounded by the post-read check.
 */
async function readCappedResponseBody(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  const tooBig = (): never => {
    throw new ProbePackError(`Discovery index exceeds the ${maxBytes}-byte cap: ${url}`)
  }
  const advertised = Number(res.headers.get("content-length"))
  if (Number.isFinite(advertised) && advertised > maxBytes) tooBig()

  const reader = res.body?.getReader()
  if (reader === undefined) {
    const body = Buffer.from(await res.arrayBuffer())
    if (body.byteLength > maxBytes) tooBig()
    return body.toString("utf8")
  }

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        tooBig()
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Fetch + parse + schema-validate an index from `source`, WITHOUT verifying its
 * signature (that is {@link loadPackIndex}). A malformed document, an oversized
 * response, an unreadable path, or a non-2xx HTTP status throws a `ProbePackError`.
 */
export async function fetchPackIndex(
  source: string,
  options: FetchPackIndexOptions = {},
): Promise<PackIndex> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INDEX_BYTES
  const where = classifySource(source)

  let text: string
  if (where.kind === "local") {
    try {
      text = await readFile(where.path, "utf8")
    } catch (err) {
      throw new ProbePackError(`Could not read discovery index: ${where.path}`, { cause: err })
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProbePackError(`Discovery index exceeds the ${maxBytes}-byte cap: ${where.path}`)
    }
  } else {
    const doFetch = options.fetchImpl ?? fetch
    let res: Response
    try {
      res = await doFetch(where.url, { redirect: "follow" })
    } catch (err) {
      throw new ProbePackError(`Could not fetch discovery index: ${where.url}`, { cause: err })
    }
    if (!res.ok) {
      throw new ProbePackError(
        `Discovery index fetch failed (HTTP ${res.status} ${res.statusText}): ${where.url}`,
      )
    }
    text = await readCappedResponseBody(res, maxBytes, where.url)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new ProbePackError(`Discovery index is not valid JSON: ${source}`, { cause })
  }
  const parsed = PackIndexSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Discovery index failed validation: ${source}\n${issues}`)
  }
  return parsed.data
}

export interface LoadPackIndexOptions extends FetchPackIndexOptions {
  /** Operator-pinned index-publisher keys the signature is verified against. */
  authorizedIndexPublisherKeys?: PinnedPublicKeys
  /**
   * Accept an *unsigned* index. Explicit opt-out, never a silent default — absent
   * means a signed index verified against a pinned publisher is required (fail closed).
   */
  allowUnsigned?: boolean
}

/** A fetched index that passed verification, tagged with where it came from. */
export interface VerifiedPackIndex {
  /** The verified index document. */
  index: PackIndex
  /** The source it was fetched from (for display + per-hit attribution). */
  source: string
  /** True when a signature verified against a pinned publisher; false under allow_unsigned. */
  signed: boolean
  /** The verifying publisher id, when signed. */
  publisherId?: string
}

/**
 * Fetch an index and verify it against operator-pinned publisher keys (fail closed):
 * an unsigned index is rejected unless `allowUnsigned`, and a signed index is always
 * fully verified (un-pinned signer, wrong key, or post-signing tamper all throw a
 * `ProbePackError`). Returns the verified index tagged with its source — the unit
 * `searchPackIndexes` consumes.
 */
export async function loadPackIndex(
  source: string,
  options: LoadPackIndexOptions = {},
): Promise<VerifiedPackIndex> {
  const index = await fetchPackIndex(source, options)
  verifyPackIndexSignature(index, {
    authorizedIndexPublisherKeys: options.authorizedIndexPublisherKeys ?? [],
    allowUnsigned: options.allowUnsigned,
    makeError: (m) => new ProbePackError(`${m} (index source: ${source})`),
  })
  // Surface `publisherId` ONLY when a signature actually verified. An unsigned index
  // loaded under allowUnsigned can carry a `publisher_id` field that was never bound
  // to a signature — attributing it to that publisher would let an unsigned index
  // claim a name it never proved. An unsigned index is always UNSIGNED, no attribution.
  const signed = index.signature !== undefined
  return {
    index,
    source,
    signed,
    ...(signed && index.publisher_id !== undefined ? { publisherId: index.publisher_id } : {}),
  }
}

export interface PublishPackIndexOptions {
  /** Local path to the unsigned (authored) index JSON to sign. A remote source is rejected. */
  source: string
  /** The publisher's signer id — written as `publisher_id` and bound to the signature. */
  publisherId: string
  /** The publisher's Ed25519 PKCS#8 PEM private key. Never logged or returned. */
  privateKeyPem: string
  /** Issuance timestamp (ISO 8601). Caller-supplied, keeping this deterministic. */
  at: string
  /** Where to write the signed index. Defaults to overwriting `source`. */
  outPath?: string
}

export interface PublishedPackIndex {
  /** The signed index document. */
  index: PackIndex
  /** The path the signed index was written to. */
  indexPath: string
  /** The publisher id it was signed as. */
  publisherId: string
  /** The publisher's derived SPKI public key — the pin consumers add to index_publisher_keys. */
  publicKeyPem: string
  /** The canonical index hash that was signed. */
  hash: string
}

/**
 * Sign an authored index in place (the publisher side; ADR-0021). Reads + validates
 * the unsigned index, sets `publisher_id` + `generated_at`, signs the canonical
 * document, **self-verifies** against the derived public key, and writes it atomically
 * (temp + rename) to `outPath` (default: overwrite `source`). Re-signing an
 * already-signed index drops the prior signature first. Mirrors `publishProbePack`'s
 * sign-then-self-verify discipline; the author writes the listing (they know each
 * pack's source pin), the CLI signs it.
 */
export async function publishPackIndex(
  options: PublishPackIndexOptions,
): Promise<PublishedPackIndex> {
  if (/^https?:\/\//i.test(options.source)) {
    throw new ProbePackError(
      `Cannot sign a remote index (${options.source}) — author it locally and sign the file.`,
    )
  }
  const authored = await fetchPackIndex(options.source)
  // Strip any existing signature so a re-sign produces a fresh, single signature.
  const { signature: _drop, ...rest } = authored
  const unsigned: PackIndex = {
    ...rest,
    publisher_id: options.publisherId,
    generated_at: options.at,
  }
  const signature = signPackIndex(unsigned, {
    publisherId: options.publisherId,
    privateKeyPem: options.privateKeyPem,
    at: options.at,
    makeError: (m) => new ProbePackError(m),
  })
  const signed: PackIndex = { ...unsigned, signature }

  // Self-verify against the derived public key — the same key consumers pin.
  const publicKeyPem = publicKeyPemFromPrivate(options.privateKeyPem, (m) => new ProbePackError(m))
  verifyPackIndexSignature(signed, {
    authorizedIndexPublisherKeys: [{ actor_id: options.publisherId, public_key: publicKeyPem }],
    makeError: (m) => new ProbePackError(`self-verify failed: ${m}`),
  })

  const target = resolve(options.outPath ?? options.source)
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(signed, null, 2)}\n`, "utf8")
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new ProbePackError(`Could not write signed index to ${target}`, { cause: err })
  }

  return {
    index: signed,
    indexPath: target,
    publisherId: options.publisherId,
    publicKeyPem,
    hash: canonicalPackIndexHash(signed),
  }
}

/** A local query over fetched indexes. Every provided filter must match (AND). */
export interface PackIndexQuery {
  /** Case-insensitive substring over a listing's name, description, and author_id. */
  text?: string
  /** Case-insensitive exact membership in a listing's coverage_areas. */
  coverageArea?: string
  /** Case-insensitive exact membership in a listing's invariants. */
  invariant?: string
}

/** One search hit: a listing plus which (verified) index advertised it. */
export interface PackIndexSearchHit {
  entry: PackIndexEntry
  /** The index source that advertised this listing. */
  indexSource: string
  /** The advertising index's verifying publisher id, when signed. */
  indexPublisherId?: string
}

function entryMatches(entry: PackIndexEntry, query: PackIndexQuery): boolean {
  if (query.text !== undefined && query.text !== "") {
    const needle = query.text.toLowerCase()
    const haystack = [entry.name, entry.description ?? "", entry.author_id ?? ""]
      .join("\n")
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  if (query.coverageArea !== undefined && query.coverageArea !== "") {
    const want = query.coverageArea.toLowerCase()
    if (!entry.coverage_areas.some((c) => c.toLowerCase() === want)) return false
  }
  if (query.invariant !== undefined && query.invariant !== "") {
    const want = query.invariant.toLowerCase()
    if (!entry.invariants.some((iv) => iv.toLowerCase() === want)) return false
  }
  return true
}

/**
 * Filter verified indexes' listings by the query, returning one hit per matching
 * (index, listing) pair — a pack listed in several indexes appears once per index, so
 * a consumer sees who advertises it. With no query (or an empty one) every listing is
 * returned (the `pack list` behaviour). Pure: no I/O, deterministic order (indexes in
 * the order passed, listings in their in-index order).
 */
export function searchPackIndexes(
  indexes: VerifiedPackIndex[],
  query: PackIndexQuery = {},
): PackIndexSearchHit[] {
  const hits: PackIndexSearchHit[] = []
  for (const vi of indexes) {
    for (const entry of vi.index.packs) {
      if (!entryMatches(entry, query)) continue
      hits.push({
        entry,
        indexSource: vi.source,
        ...(vi.publisherId !== undefined ? { indexPublisherId: vi.publisherId } : {}),
      })
    }
  }
  return hits
}
