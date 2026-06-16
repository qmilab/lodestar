#!/usr/bin/env bun
/**
 * Probe: pack_index_signature_required
 *
 * The discovery index is the registry's read-side surface (#87, ADR-0021), and the
 * last of the six registry children (ADR-0016 step 6). Discovery in the open layer is
 * **a protocol, not a service**: a fetchable static signed JSON document that lists
 * packs and where to resolve them, hostable anywhere. It is signed with the same
 * Ed25519 lineage as manifests (ADR-0017) and badges (ADR-0020), under a *third*,
 * separate trust root — the operator's pinned **index-publisher** keys.
 *
 * The load-bearing property (ADR-0016 §1, threat-model §5): an index is an
 * **advertisement, not an authority**. A consumer pins the publisher and verifies the
 * listing locally, but the index can never make an unsigned/forged pack verify —
 * choosing a discovered pack still routes through source resolution (#86) and
 * verify-on-load (#88) against pinned *author* keys. So a hostile or tampered index
 * can mis-list or omit, but the trust is in the pack signature, never the index.
 *
 *   A. VERIFIED INDEX — a static index signed by a PINNED index publisher loads and
 *      lists its packs; an un-pinned publisher is rejected.
 *   B. SEARCH / FILTER — the local query filters listings by coverage area, invariant,
 *      and text (AND), the side-effect-free inspection `lodestar pack search` drives.
 *   C. UNSIGNED REJECTED — an unsigned index is rejected (fail closed); allow_unsigned
 *      is the explicit, never-silent opt-out, and its entries surface as UNSIGNED.
 *   D. TAMPERED — an index entry edited after signing fails on the payload hash.
 *   E. INDEX IS ADVISORY; TRUST IS IN #88 — a VERIFIED index advertising an unsigned
 *      (or forged) pack cannot make it verify: resolving the chosen pack still routes
 *      through `addProbePack`, which rejects it, while the genuinely-signed pack the
 *      same index lists adds cleanly. The index advertises; #86/#88 decide.
 *   F. INDEXES COMPOSE — listings from several verified indexes merge, each hit
 *      attributed to the index (and publisher) that advertised it.
 *
 * Everything runs offline over temp directories; no network, no subprocess. A real
 * index would be fetched from where it is hosted; here it is signed in memory and
 * written to a temp file so the probe stays inert (the CLI's `pack index-sign` /
 * `pack search` drive the real fetch + verify).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PACK_INDEX_SPEC_VERSION,
  PROBE_PACK_SPEC_VERSION,
  type PackIndex,
  type PackIndexEntry,
  type ProbePackManifest,
  generateEd25519KeyPair,
  signPackIndex,
} from "@qmilab/lodestar-core"
import {
  ProbePackError,
  addProbePack,
  loadPackIndex,
  publishProbePack,
  searchPackIndexes,
} from "@qmilab/lodestar-harness"

const AUTHOR_ID = "acme-pack-author"
const PUBLISHER_ID = "acme-index"
const AT = "2026-01-01T00:00:00.000Z"
const PROBE_FILE = "probes/sample.ts"
const PROBE_BODY = "#!/usr/bin/env bun\nexport const sample = 1\nprocess.exit(0)\n"

/** Write an unsigned pack (manifest + one probe file) into `dir`; returns the dir. */
async function writeUnsignedPack(dir: string, name: string): Promise<string> {
  await mkdir(join(dir, "probes"), { recursive: true })
  await writeFile(join(dir, PROBE_FILE), PROBE_BODY, "utf8")
  const manifest: ProbePackManifest = {
    name,
    version: "1.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    description: `A demo pack (${name}) for the discovery-index probe.`,
    coverage_areas: ["pack_registry"],
    invariants: ["pack_index_signature_required"],
    probes: [{ name: "sample", file: PROBE_FILE }],
  }
  await writeFile(
    join(dir, "lodestar.probe-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )
  return dir
}

/** Publish (sign) a freshly written pack and return its dir. */
async function signedPack(
  workspace: string,
  dirName: string,
  packName: string,
  authorPriv: string,
): Promise<string> {
  const dir = await writeUnsignedPack(join(workspace, dirName), packName)
  await publishProbePack({ target: dir, authorId: AUTHOR_ID, privateKeyPem: authorPriv, at: AT })
  return dir
}

/** Build a signed index over the given entries, write it to `path`, return the path. */
async function writeSignedIndex(
  path: string,
  entries: PackIndexEntry[],
  publisherPriv: string,
  opts: { sign?: boolean } = {},
): Promise<string> {
  const sign = opts.sign ?? true
  const base: PackIndex = {
    index_version: PACK_INDEX_SPEC_VERSION,
    description: "ACME community pack index",
    packs: entries,
    ...(sign ? { publisher_id: PUBLISHER_ID, generated_at: AT } : {}),
  }
  const index: PackIndex = sign
    ? {
        ...base,
        signature: signPackIndex(base, {
          publisherId: PUBLISHER_ID,
          privateKeyPem: publisherPriv,
          at: AT,
        }),
      }
    : base
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8")
  return path
}

function localEntry(
  name: string,
  dir: string,
  extra: Partial<PackIndexEntry> = {},
): PackIndexEntry {
  return {
    name,
    version: "1.0.0",
    source: { type: "local", path: dir },
    author_id: AUTHOR_ID,
    coverage_areas: ["pack_registry"],
    invariants: ["pack_index_signature_required"],
    ...extra,
  }
}

async function run(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  const workspace = await mkdtemp(join(tmpdir(), "lodestar-pack-index-"))
  const author = generateEd25519KeyPair()
  const publisher = generateEd25519KeyPair()
  const attacker = generateEd25519KeyPair()
  const pinnedAuthor = [{ actor_id: AUTHOR_ID, public_key: author.publicKeyPem }]
  const pinnedPublisher = [{ actor_id: PUBLISHER_ID, public_key: publisher.publicKeyPem }]

  try {
    // Two real on-disk packs the index will advertise.
    const goodDir = await signedPack(workspace, "good", "good-pack", author.privateKeyPem)
    const evilDir = await writeUnsignedPack(join(workspace, "evil"), "evil-pack") // never signed

    // ── A — VERIFIED INDEX (+ un-pinned publisher rejected) ──────────────────────
    const indexPath = await writeSignedIndex(
      join(workspace, "lodestar.pack-index.json"),
      [
        localEntry("good-pack", goodDir, {
          description: "core safety probes",
          coverage_areas: ["pack_registry", "memory_firewall"],
          invariants: ["pack_index_signature_required"],
        }),
        localEntry("net-pack", evilDir, {
          coverage_areas: ["egress"],
          invariants: ["ssrf_guard"],
        }),
      ],
      publisher.privateKeyPem,
    )
    const verified = await loadPackIndex(indexPath, {
      authorizedIndexPublisherKeys: pinnedPublisher,
    })
    if (
      !verified.signed ||
      verified.publisherId !== PUBLISHER_ID ||
      verified.index.packs.length !== 2
    ) {
      throw new Error("a signed index from a pinned publisher should verify and list its packs")
    }
    // The same index, with the publisher NOT pinned, is rejected.
    let unpinnedRejected = false
    try {
      await loadPackIndex(indexPath, { authorizedIndexPublisherKeys: [] })
    } catch (err) {
      if (err instanceof ProbePackError) unpinnedRejected = true
      else throw err
    }
    if (!unpinnedRejected)
      throw new Error("a signed index from an un-pinned publisher must be rejected")
    details.push(
      "A: a static index signed by a PINNED publisher verifies + lists; an un-pinned publisher is rejected ✓",
    )

    // ── B — SEARCH / FILTER ──────────────────────────────────────────────────────
    const all = searchPackIndexes([verified])
    if (all.length !== 2) throw new Error("no-query search should return every listing")
    const byCoverage = searchPackIndexes([verified], { coverageArea: "egress" }).map(
      (h) => h.entry.name,
    )
    const byInvariant = searchPackIndexes([verified], { invariant: "ssrf_guard" }).map(
      (h) => h.entry.name,
    )
    const byText = searchPackIndexes([verified], { text: "GOOD" }).map((h) => h.entry.name)
    const andNone = searchPackIndexes([verified], { text: "good", coverageArea: "egress" })
    if (
      JSON.stringify(byCoverage) !== JSON.stringify(["net-pack"]) ||
      JSON.stringify(byInvariant) !== JSON.stringify(["net-pack"]) ||
      JSON.stringify(byText) !== JSON.stringify(["good-pack"]) ||
      andNone.length !== 0
    ) {
      throw new Error(
        "local search/filter (coverage / invariant / text, AND) did not return the right subset",
      )
    }
    details.push(
      "B: local search filters by coverage area, invariant, and text (AND) — the right subset ✓",
    )

    // ── C — UNSIGNED REJECTED (allow_unsigned is the explicit opt-out) ───────────
    const unsignedPath = await writeSignedIndex(
      join(workspace, "unsigned.pack-index.json"),
      [localEntry("good-pack", goodDir)],
      publisher.privateKeyPem,
      { sign: false },
    )
    let unsignedRejected = false
    try {
      await loadPackIndex(unsignedPath, { authorizedIndexPublisherKeys: pinnedPublisher })
    } catch (err) {
      if (err instanceof ProbePackError) unsignedRejected = true
      else throw err
    }
    if (!unsignedRejected)
      throw new Error("an unsigned index must be rejected without allow_unsigned")
    const allowed = await loadPackIndex(unsignedPath, { allowUnsigned: true })
    if (allowed.signed || allowed.publisherId !== undefined) {
      throw new Error("an allow_unsigned index must surface as UNSIGNED (no verifying publisher)")
    }
    details.push(
      "C: an unsigned index is rejected fail-closed; allow_unsigned is the explicit opt-out (surfaced UNSIGNED) ✓",
    )

    // ── D — TAMPERED ─────────────────────────────────────────────────────────────
    const onDisk = JSON.parse(await readFile(indexPath, "utf8")) as PackIndex
    // Re-point the good-pack entry's source AFTER signing — the signed bytes differ.
    ;(onDisk.packs[0] as PackIndexEntry).source = { type: "local", path: evilDir }
    const tamperedPath = join(workspace, "tampered.pack-index.json")
    await writeFile(tamperedPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8")
    let tamperRejected = false
    try {
      await loadPackIndex(tamperedPath, { authorizedIndexPublisherKeys: pinnedPublisher })
    } catch (err) {
      if (err instanceof ProbePackError) tamperRejected = true
      else throw err
    }
    if (!tamperRejected)
      throw new Error("an index entry edited after signing must fail verification")
    details.push("D: an index entry edited after signing fails on the payload hash → rejected ✓")

    // ── E — INDEX IS ADVISORY; TRUST IS IN #88 ───────────────────────────────────
    // The VERIFIED index advertises both packs. Resolving each chosen pack routes
    // through addProbePack (#86/#88) against the pinned AUTHOR keys: the genuinely
    // signed good-pack adds, but the unsigned pack the same verified index advertises
    // is REJECTED. A trusted index cannot launder an untrusted pack.
    const goodHit = all.find((h) => h.entry.name === "good-pack")?.entry
    const evilHit = all.find((h) => h.entry.name === "net-pack")?.entry
    if (goodHit === undefined || evilHit === undefined)
      throw new Error("expected both advertised entries")

    const added = await addProbePack({
      ref: goodHit.source,
      authorizedAuthorKeys: pinnedAuthor,
      at: AT,
    })
    if (added.pack.manifest.author_id !== AUTHOR_ID) {
      throw new Error("the genuinely-signed advertised pack should verify + add")
    }
    let forgedAddRejected = false
    try {
      // evilHit advertises the UNSIGNED pack — add must reject it (no allow_unsigned).
      await addProbePack({ ref: evilHit.source, authorizedAuthorKeys: pinnedAuthor, at: AT })
    } catch (err) {
      if (err instanceof ProbePackError) forgedAddRejected = true
      else throw err
    }
    if (!forgedAddRejected) {
      throw new Error(
        "a verified index must not make an unsigned pack installable — trust is in #88, not the index",
      )
    }
    details.push(
      "E: a VERIFIED index advertising an unsigned pack cannot make it verify — add still routes through #86/#88 ✓",
    )

    // ── F — INDEXES COMPOSE ──────────────────────────────────────────────────────
    const second = await loadPackIndex(
      await writeSignedIndex(
        join(workspace, "second.pack-index.json"),
        [
          localEntry("extra-pack", goodDir, {
            coverage_areas: ["egress"],
            invariants: ["ssrf_guard"],
          }),
        ],
        publisher.privateKeyPem,
      ),
      { authorizedIndexPublisherKeys: pinnedPublisher },
    )
    const composed = searchPackIndexes([verified, second], { coverageArea: "egress" })
    if (composed.length !== 2 || new Set(composed.map((h) => h.indexSource)).size !== 2) {
      throw new Error(
        "listings from several verified indexes should compose, each attributed to its index",
      )
    }
    if (!composed.every((h) => h.indexPublisherId === PUBLISHER_ID)) {
      throw new Error("each composed hit should carry its advertising index's verifying publisher")
    }
    details.push(
      "F: listings from several verified indexes compose, each hit attributed to its index + publisher ✓",
    )
  } catch (err) {
    return {
      passed: false,
      details: [...details, `FAIL: ${err instanceof Error ? err.message : String(err)}`],
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: pack_index_signature_required")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
