import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NpmPackSource, NpmPackSourceSchema } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { DEFAULT_RESOLUTION_TIMEOUT_MS } from "./run.js"
import { extractTarball } from "./tar.js"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
/** Hard ceiling on a downloaded tarball — a probe pack is tiny; this is a generous DoS cap. */
const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024
/** Registry version metadata is small; bound it too against a hostile registry. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024

/**
 * Encode a (possibly scoped) package name for a registry URL path: the scope
 * slash is percent-encoded so `@scope/name` addresses one package, not a
 * nested path.
 */
function encodePackageName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2f") : name
}

function parseSriAlgorithm(integrity: string): "sha256" | "sha512" {
  const algo = integrity.slice(0, integrity.indexOf("-"))
  if (algo === "sha256" || algo === "sha512") return algo
  throw new ProbePackError(
    `Unsupported integrity algorithm in '${integrity}'. Only sha256 / sha512 are supported.`,
  )
}

function computeSri(algorithm: "sha256" | "sha512", bytes: Buffer): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`
}

interface DeadlineFetch {
  res: Response
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

/** Fetch with an abort deadline that stays armed through the body read below. */
async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<DeadlineFetch> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    return { res, controller, timer }
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Read a response body into a Buffer with a hard byte cap, aborting the transfer
 * (and clearing the deadline) on overflow. Without this, an untrusted registry
 * could hang the call or exhaust memory before the integrity check ever runs —
 * the resolution subprocess timeout only covers extraction, not the fetch.
 */
async function readBoundedBody(
  fetched: DeadlineFetch,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const { res, controller, timer } = fetched
  try {
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new ProbePackError(`${label} is ${declared} bytes, over the ${maxBytes}-byte cap.`)
    }
    const body = res.body
    if (body === null) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) {
        throw new ProbePackError(`${label} exceeds the ${maxBytes}-byte cap.`)
      }
      return buf
    }
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        total += value.byteLength
        if (total > maxBytes) {
          controller.abort()
          await reader.cancel().catch(() => {})
          throw new ProbePackError(`${label} exceeds the ${maxBytes}-byte cap; download aborted.`)
        }
        chunks.push(Buffer.from(value))
      }
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

export interface ResolveNpmOptions {
  /**
   * Directory to extract into; a fresh subdirectory is created beneath it.
   * Defaults to a throwaway OS temp dir. (#90's `pack add` will pass a durable,
   * content-addressed cache root.)
   */
  cacheRoot?: string
  /** Injection seam for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Hard cap on the downloaded tarball size (bytes); defaults to 64 MiB. */
  maxTarballBytes?: number
  /** Per-request deadline for the metadata + tarball fetch (ms); defaults to the resolution timeout. */
  downloadTimeoutMs?: number
}

/**
 * Resolve a pinned npm pack source to a confined local directory (ADR-0016 §1,
 * #86 / ADR-0018).
 *
 * The flow is a **non-executing fetch**: read the version's tarball URL +
 * advertised integrity from the registry, assert the advertised integrity equals
 * the operator-pinned one (a registry that advertises a different hash is
 * mis-advertising), download the tarball, assert the *downloaded bytes'* SRI
 * equals the pin (the load-bearing check — a tampered or re-published artifact
 * fails here), then extract with {@link extractTarball}, which never runs `npm
 * install` or any lifecycle script. Returns the extracted package root; the
 * caller runs {@link loadProbePack} over it, where the signature + content-digest
 * verification applies to the fetched bytes.
 */
export async function resolveNpmSource(
  input: NpmPackSource,
  options: ResolveNpmOptions = {},
): Promise<string> {
  // Validate here too, not only via resolvePackSource: a direct caller of this
  // exported entry must not be able to bypass the exact-version + SRI immutability
  // guard (e.g. fetch `/pkg/latest`). Mirrors resolveGitSource's defensive check.
  const validated = NpmPackSourceSchema.safeParse(input)
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Invalid npm pack source:\n${issues}`)
  }
  const source = validated.data
  const fetchImpl = options.fetchImpl ?? fetch
  const registry = (source.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "")
  const algorithm = parseSriAlgorithm(source.integrity)
  const coordinate = `${source.package}@${source.version}`
  const timeoutMs = options.downloadTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS
  const maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES

  // 1. Read the version metadata: tarball URL + advertised integrity. Bounded +
  // abortable so a hostile registry cannot hang the call or flood memory.
  const metaUrl = `${registry}/${encodePackageName(source.package)}/${encodeURIComponent(source.version)}`
  let metaFetched: DeadlineFetch
  try {
    metaFetched = await fetchWithDeadline(fetchImpl, metaUrl, timeoutMs)
  } catch (cause) {
    throw new ProbePackError(`Could not reach the registry for '${coordinate}': ${String(cause)}`, {
      cause,
    })
  }
  if (!metaFetched.res.ok) {
    clearTimeout(metaFetched.timer)
    throw new ProbePackError(
      `Registry returned ${metaFetched.res.status} for '${coordinate}' (${metaUrl}).`,
    )
  }
  let meta: { dist?: { tarball?: string; integrity?: string } }
  try {
    const metaText = (
      await readBoundedBody(
        metaFetched,
        MAX_METADATA_BYTES,
        `Registry metadata for '${coordinate}'`,
      )
    ).toString("utf8")
    meta = JSON.parse(metaText) as typeof meta
  } catch (cause) {
    if (cause instanceof ProbePackError) throw cause
    throw new ProbePackError(`Registry metadata for '${coordinate}' was not valid JSON.`, { cause })
  }

  const tarballUrl = meta.dist?.tarball
  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new ProbePackError(`Registry metadata for '${coordinate}' has no dist.tarball.`)
  }
  if (typeof meta.dist?.integrity === "string" && meta.dist.integrity !== source.integrity) {
    throw new ProbePackError(
      `Registry-advertised integrity for '${coordinate}' does not match the pinned integrity (pinned ${source.integrity.slice(0, 20)}…, registry ${meta.dist.integrity.slice(0, 20)}…).`,
    )
  }

  // 2. Download the tarball — bounded + abortable, same as the metadata read.
  let tarFetched: DeadlineFetch
  try {
    tarFetched = await fetchWithDeadline(fetchImpl, tarballUrl, timeoutMs)
  } catch (cause) {
    throw new ProbePackError(
      `Could not download the tarball for '${coordinate}': ${String(cause)}`,
      {
        cause,
      },
    )
  }
  if (!tarFetched.res.ok) {
    clearTimeout(tarFetched.timer)
    throw new ProbePackError(
      `Tarball download for '${coordinate}' returned ${tarFetched.res.status} (${tarballUrl}).`,
    )
  }
  const bytes = await readBoundedBody(tarFetched, maxTarballBytes, `Tarball for '${coordinate}'`)

  // 3. The load-bearing pin: the downloaded bytes' SRI must equal the pin.
  const actual = computeSri(algorithm, bytes)
  if (actual !== source.integrity) {
    throw new ProbePackError(
      `Tarball integrity mismatch for '${coordinate}': downloaded bytes hash to ${actual.slice(0, 24)}…, pinned ${source.integrity.slice(0, 24)}…. The artifact has been tampered with or re-published.`,
    )
  }

  // 4. Non-executing extract into a confined directory. Everything for this
  // resolution lives under a per-call unique `work` dir (mkdtemp): the tarball at
  // `work/pack.tgz` and the extracted root at `work/root`. A unique tarball path
  // is essential — with a shared `cacheRoot` and concurrent resolutions, a single
  // `cacheRoot/pack.tgz` could be overwritten by another call between this one's
  // integrity check and its extraction, landing bytes that don't match the pin.
  const cacheRoot = options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "lodestar-pack-npm-")))
  await mkdir(cacheRoot, { recursive: true })
  const work = await mkdtemp(join(cacheRoot, "pkg-"))
  const dest = join(work, "root")
  await mkdir(dest)
  const tgzPath = join(work, "pack.tgz")
  await writeFile(tgzPath, bytes)
  await extractTarball(tgzPath, dest)
  return dest
}
