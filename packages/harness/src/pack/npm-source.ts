import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NpmPackSource } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { extractTarball } from "./tar.js"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"

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

export interface ResolveNpmOptions {
  /**
   * Directory to extract into; a fresh subdirectory is created beneath it.
   * Defaults to a throwaway OS temp dir. (#90's `pack add` will pass a durable,
   * content-addressed cache root.)
   */
  cacheRoot?: string
  /** Injection seam for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
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
  source: NpmPackSource,
  options: ResolveNpmOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const registry = (source.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "")
  const algorithm = parseSriAlgorithm(source.integrity)
  const coordinate = `${source.package}@${source.version}`

  // 1. Read the version metadata: tarball URL + advertised integrity.
  const metaUrl = `${registry}/${encodePackageName(source.package)}/${encodeURIComponent(source.version)}`
  let metaRes: Response
  try {
    metaRes = await fetchImpl(metaUrl)
  } catch (cause) {
    throw new ProbePackError(`Could not reach the registry for '${coordinate}': ${String(cause)}`, {
      cause,
    })
  }
  if (!metaRes.ok) {
    throw new ProbePackError(
      `Registry returned ${metaRes.status} for '${coordinate}' (${metaUrl}).`,
    )
  }
  let meta: { dist?: { tarball?: string; integrity?: string } }
  try {
    meta = (await metaRes.json()) as typeof meta
  } catch (cause) {
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

  // 2. Download the tarball.
  let tarRes: Response
  try {
    tarRes = await fetchImpl(tarballUrl)
  } catch (cause) {
    throw new ProbePackError(
      `Could not download the tarball for '${coordinate}': ${String(cause)}`,
      {
        cause,
      },
    )
  }
  if (!tarRes.ok) {
    throw new ProbePackError(
      `Tarball download for '${coordinate}' returned ${tarRes.status} (${tarballUrl}).`,
    )
  }
  const bytes = Buffer.from(await tarRes.arrayBuffer())

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
