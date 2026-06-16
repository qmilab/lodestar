import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type PackAttesterKey,
  type PackAuthorKey,
  type PackBadgeKind,
  PackBadgeKindSchema,
  type PackSourceRef,
  type ProbePackSourceType,
  ProbePackSourceTypeSchema,
  type SecurityScanBadgeResult,
  SecurityScanBadgeResultSchema,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import {
  type BadgeVerification,
  DEFAULT_PACK_LOCKFILE_PATH,
  DEFAULT_PACK_TRUST_PATH,
  ProbePackError,
  addProbePack,
  assertPackBadgeable,
  buildProbeResultsBadge,
  buildSecurityScanBadge,
  harnessVersion,
  loadProbePack,
  publishProbePack,
  readPackTrustConfig,
  runPack,
  writePackBadge,
} from "@qmilab/lodestar-harness"

/** Env var holding the author's PKCS#8 PEM private key (off argv; never logged). */
const AUTHOR_KEY_ENV = "LODESTAR_AUTHOR_KEY"

/** Env var holding the attester's PKCS#8 PEM private key (off argv; never logged). */
const ATTESTER_KEY_ENV = "LODESTAR_ATTESTER_KEY"

/** A malformed invocation (a value-taking flag with no value). Maps to exit 2. */
class PackUsageError extends Error {
  override readonly name = "PackUsageError"
}

/**
 * Read the value for a value-taking flag, rejecting a missing value or one that
 * looks like another flag (`--out --author`). Consuming a missing value silently is
 * dangerous here: `pack keygen --out` with the path omitted would otherwise fall
 * through to the no-`--out` branch and print the freshly generated PRIVATE key to
 * stdout. Mirrors the harness CLI's `takeFlagValue`.
 */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new PackUsageError(`flag ${flag} requires a value`)
  }
  return value
}

/**
 * `lodestar pack` — the trust-pack author + consumer + attestation flow (#90/#89,
 * ADR-0019 / ADR-0020).
 *
 *   lodestar pack keygen  (--author <id> | --attester <id>) [--out <prefix>]
 *   lodestar pack publish [--pack <dir>] --author <id> [--key <path>] [--source-type <local|npm|git>]
 *   lodestar pack attest  [--pack <dir>] --kind <probe_results|security_scan> --attester <id>
 *                         [--key <path>] [--scan <file>] [--author-key <id>=<file>]... [--allow-unsigned]
 *   lodestar pack add <source> [--author-key <id>=<file>]... [--attester-key <id>=<file>]...
 *                     [--trust-config <path>] [--integrity <sri>] [--registry <url>]
 *                     [--allow-unsigned] [--lockfile <path>] [--install-dir <dir>] [--no-install]
 *
 * `publish` signs a pack's manifest in place (freeze files → content digest → sign
 * → self-verify); `attest` issues a locally-verifiable signed badge over a pack
 * (a `probe_results` summary of a real run, or a `security_scan` verdict from a
 * provided result file), written into the pack's `badges/`; `add` resolves a pinned
 * source via a non-executing fetch, verifies the signature + content digest against
 * operator-pinned author keys **before any pack code could run**, then surfaces /
 * installs / records the pin and surfaces the pack's badges (verified against pinned
 * attester keys — advisory, never a gate). `keygen` mints an author *or* attester
 * keypair, mirroring `approve keygen`.
 *
 * The logic lives in `@qmilab/lodestar-harness`; this is the thin CLI shell.
 *
 * Exit codes:
 *   0  — success
 *   1  — runtime / verification failure (the publish, attest, or add did not complete)
 *   2  — usage error (bad/missing flag or subcommand, unparseable source)
 */
export async function packCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    writeUsage(sub === undefined ? process.stderr : process.stdout)
    return sub === undefined ? 2 : 0
  }
  switch (sub) {
    case "keygen":
      return keygenCommand(rest)
    case "publish":
      return publishCommand(rest)
    case "attest":
      return attestCommand(rest)
    case "add":
      return addCommand(rest)
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`)
      writeUsage(process.stderr)
      return 2
  }
}

// ── keygen ─────────────────────────────────────────────────────────────────────

/**
 * Mint an Ed25519 keypair for one of the two registry trust roles: an **author**
 * key (signs pack manifests; pinned under `author_keys`) or an **attester** key
 * (signs verification badges; pinned under `attester_keys`, ADR-0020). Exactly one
 * of `--author` / `--attester` is required — they are separate trust roots. Mirrors
 * `approve keygen` — same key format and the same temp+rename 0600 discipline for
 * the private key — but labels the printed pin for the role chosen.
 */
async function keygenCommand(argv: string[]): Promise<number> {
  let author: string | undefined
  let attester: string | undefined
  let outPath: string | undefined
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--author" || arg === "-a") {
        author = takeValue(argv, i, arg)
        i++
      } else if (arg === "--attester") {
        attester = takeValue(argv, i, arg)
        i++
      } else if (arg === "--out" || arg === "-o") {
        outPath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--help" || arg === "-h") {
        writeUsage(process.stdout)
        return 0
      } else {
        process.stderr.write(`unknown flag for 'keygen': ${arg}\n`)
        writeUsage(process.stderr)
        return 2
      }
    }
  } catch (err) {
    if (err instanceof PackUsageError) {
      process.stderr.write(`${err.message}\n`)
      writeUsage(process.stderr)
      return 2
    }
    throw err
  }
  const hasAuthor = author !== undefined && author !== ""
  const hasAttester = attester !== undefined && attester !== ""
  if (hasAuthor === hasAttester) {
    process.stderr.write(
      "keygen needs exactly one of --author <id> or --attester <id>\n" +
        "          (--author mints a manifest-signing key; --attester mints a badge-signing key — separate trust roots)\n",
    )
    return 2
  }

  // Role-specific labels: which trust-config field consumers pin it under, and how
  // the holder uses it. The key material and 0600 discipline are identical.
  const role = hasAuthor
    ? {
        id: author as string,
        idField: "actor_id" as const,
        keysField: "author_keys",
        keyEnv: AUTHOR_KEY_ENV,
        noun: "author",
        useHint: (id: string, key: string) =>
          `lodestar pack publish --pack <dir> --author ${id} --key ${key}`,
      }
    : {
        id: attester as string,
        idField: "attester_id" as const,
        keysField: "attester_keys",
        keyEnv: ATTESTER_KEY_ENV,
        noun: "attester",
        useHint: (id: string, key: string) =>
          `lodestar pack attest --pack <dir> --kind probe_results --attester ${id} --key ${key}`,
      }

  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
  const pin = JSON.stringify({ [role.idField]: role.id, public_key: publicKeyPem }, null, 2)

  if (outPath !== undefined) {
    const privPath = `${outPath}.key`
    const pubPath = `${outPath}.pub`
    // The private key must never touch disk with loose permissions: write to a fresh
    // 0600 temp (mode applies on creation) and atomically rename it into place.
    const tmpPath = `${privPath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, privateKeyPem, { mode: 0o600 })
      await rename(tmpPath, privPath)
      await writeFile(pubPath, publicKeyPem)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      process.stderr.write(`[pack] keygen: could not write key files: ${errMessage(err)}\n`)
      return 1
    }
    process.stdout.write(
      `[pack] wrote ${role.noun} keypair:\n  private (keep secret, mode 0600): ${privPath}\n  public  (give to consumers):       ${pubPath}\n\n` +
        `Use it:         ${role.useHint(role.id, privPath)}\n` +
        `Consumers pin it in ${DEFAULT_PACK_TRUST_PATH} under ${role.keysField}:\n${pin}\n`,
    )
    return 0
  }

  process.stdout.write(
    `# Ed25519 pack-${role.noun} keypair. Keep the PRIVATE key secret (a secret store / a 0600 file).
# Use with:  ${role.useHint(role.id, "<private-key-file>")}
#       or:  ${role.keyEnv}="$(cat <private-key-file>)" lodestar pack ${hasAuthor ? "publish" : "attest"} ...

# --- PRIVATE KEY (PKCS#8) ---
${privateKeyPem}
# --- PUBLIC KEY (SPKI) — consumers pin this in ${DEFAULT_PACK_TRUST_PATH} ---
${publicKeyPem}
# pack-trust.json ${role.keysField} entry:
${pin}
`,
  )
  return 0
}

// ── publish ──────────────────────────────────────────────────────────────────

async function publishCommand(argv: string[]): Promise<number> {
  let packDir = "."
  let author: string | undefined
  let keyPath: string | undefined
  let sourceType: ProbePackSourceType | undefined
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--pack" || arg === "-p") {
        packDir = takeValue(argv, i, arg)
        i++
      } else if (arg === "--author" || arg === "-a") {
        author = takeValue(argv, i, arg)
        i++
      } else if (arg === "--key" || arg === "-k") {
        keyPath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--source-type") {
        const v = takeValue(argv, i, arg)
        i++
        const parsed = ProbePackSourceTypeSchema.safeParse(v)
        if (!parsed.success) {
          process.stderr.write(`invalid --source-type '${v}' (expected local|npm|git)\n`)
          return 2
        }
        sourceType = parsed.data
      } else if (arg === "--help" || arg === "-h") {
        writeUsage(process.stdout)
        return 0
      } else {
        process.stderr.write(`unknown flag for 'publish': ${arg}\n`)
        writeUsage(process.stderr)
        return 2
      }
    }
  } catch (err) {
    if (err instanceof PackUsageError) {
      process.stderr.write(`${err.message}\n`)
      writeUsage(process.stderr)
      return 2
    }
    throw err
  }
  if (author === undefined || author === "") {
    process.stderr.write("missing required --author <id> for 'publish'\n")
    writeUsage(process.stderr)
    return 2
  }

  let privateKeyPem: string | undefined
  try {
    privateKeyPem = await loadSigningKey(keyPath, AUTHOR_KEY_ENV)
  } catch (err) {
    process.stderr.write(`[pack] could not read the signing key: ${errMessage(err)}\n`)
    return 1
  }
  if (privateKeyPem === undefined) {
    process.stderr.write(
      `[pack] missing the author signing key: pass --key <path> or set ${AUTHOR_KEY_ENV}.\n        Mint one with 'lodestar pack keygen --author ${author} --out <prefix>'.\n`,
    )
    return 2
  }

  try {
    const published = await publishProbePack({
      target: resolve(process.cwd(), packDir),
      authorId: author,
      privateKeyPem,
      at: new Date().toISOString(),
      ...(sourceType !== undefined ? { sourceType } : {}),
    })
    const m = published.manifest
    process.stdout.write(
      `[pack] signed and self-verified '${m.name}' v${m.version} (source ${m.source_type}) as '${author}'.\n` +
        `       manifest:       ${published.manifestPath}\n` +
        `       probes signed:  ${published.contentDigest.files.length}\n` +
        `       manifest hash:  ${published.manifestHash}\n\n` +
        `Consumers pin your key in ${DEFAULT_PACK_TRUST_PATH} under author_keys:\n` +
        `${JSON.stringify({ actor_id: author, public_key: published.publicKeyPem }, null, 2)}\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`[pack] publish failed: ${err.message}\n`)
      return 1
    }
    throw err
  }
}

// ── attest ─────────────────────────────────────────────────────────────────────

/**
 * Issue a locally-verifiable signed badge over a pack (ADR-0020), written into the
 * pack's `badges/` directory and bound to the pack's manifest hash. Two kinds:
 *  - `probe_results` — run the pack's probes and sign a summary of the outcome.
 *  - `security_scan` — sign a provided scan verdict (`--scan <file>`); the scanner
 *    that produces it is out of scope for the open repo (ADR-0016 §4).
 *
 * The pack is loaded as-is (an unsigned pack loads; a *signed* pack needs its author
 * pinned via `--author-key`, since a signed manifest is always verified on load).
 * The attester key comes from `--key` or `LODESTAR_ATTESTER_KEY`, never argv.
 */
async function attestCommand(argv: string[]): Promise<number> {
  let packDir = "."
  let kind: PackBadgeKind | undefined
  let attester: string | undefined
  let keyPath: string | undefined
  let scanPath: string | undefined
  const authorKeyFlags: PackAuthorKey[] = []
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--pack" || arg === "-p") {
        packDir = takeValue(argv, i, arg)
        i++
      } else if (arg === "--kind") {
        const v = takeValue(argv, i, arg)
        i++
        const parsed = PackBadgeKindSchema.safeParse(v)
        if (!parsed.success) {
          process.stderr.write(`invalid --kind '${v}' (expected probe_results|security_scan)\n`)
          return 2
        }
        kind = parsed.data
      } else if (arg === "--attester") {
        attester = takeValue(argv, i, arg)
        i++
      } else if (arg === "--key" || arg === "-k") {
        keyPath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--scan") {
        scanPath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--author-key") {
        const spec = takeValue(argv, i, arg)
        i++
        const parsed = await parseKeyFileFlag(spec, "--author-key")
        if ("error" in parsed) {
          process.stderr.write(`${parsed.error}\n`)
          return 2
        }
        authorKeyFlags.push({ actor_id: parsed.actorId, public_key: parsed.publicKey })
      } else if (arg === "--help" || arg === "-h") {
        writeUsage(process.stdout)
        return 0
      } else {
        process.stderr.write(`unknown flag for 'attest': ${arg}\n`)
        writeUsage(process.stderr)
        return 2
      }
    }
  } catch (err) {
    if (err instanceof PackUsageError) {
      process.stderr.write(`${err.message}\n`)
      writeUsage(process.stderr)
      return 2
    }
    throw err
  }

  if (kind === undefined) {
    process.stderr.write("missing required --kind <probe_results|security_scan> for 'attest'\n")
    writeUsage(process.stderr)
    return 2
  }
  if (attester === undefined || attester === "") {
    process.stderr.write("missing required --attester <id> for 'attest'\n")
    writeUsage(process.stderr)
    return 2
  }
  if (kind === "security_scan" && (scanPath === undefined || scanPath === "")) {
    process.stderr.write(
      "--kind security_scan requires --scan <result-file> (a JSON scan verdict)\n",
    )
    return 2
  }
  if (kind === "probe_results" && scanPath !== undefined) {
    process.stderr.write("[pack] note: --scan is ignored for --kind probe_results\n")
  }

  let privateKeyPem: string | undefined
  try {
    privateKeyPem = await loadSigningKey(keyPath, ATTESTER_KEY_ENV)
  } catch (err) {
    process.stderr.write(`[pack] could not read the attester key: ${errMessage(err)}\n`)
    return 1
  }
  if (privateKeyPem === undefined) {
    process.stderr.write(
      `[pack] missing the attester signing key: pass --key <path> or set ${ATTESTER_KEY_ENV}.\n        Mint one with 'lodestar pack keygen --attester ${attester} --out <prefix>'.\n`,
    )
    return 2
  }

  const at = new Date().toISOString()
  try {
    // Load the pack to attest. allowUnsigned: an attester vouches for the bytes it
    // holds regardless of authorship; a signed pack still needs its author pinned
    // (a signed manifest is always verified on load) via --author-key.
    const pack = await loadProbePack(resolve(process.cwd(), packDir), {
      allowUnsigned: true,
      authorizedAuthorKeys: authorKeyFlags,
    })

    // Reject an un-badgeable (unsigned) pack BEFORE running its probes — otherwise
    // `runPack` would execute pack-authored code for a command that cannot produce a
    // badge (an unsigned pack's bytes are not authenticated; ADR-0020).
    assertPackBadgeable(pack.manifest)

    let badgePath: string
    if (kind === "probe_results") {
      const run = await runPack(pack)
      const badge = buildProbeResultsBadge(pack.manifest, run, {
        attesterId: attester,
        privateKeyPem,
        at,
        harnessVersion: harnessVersion(),
      })
      badgePath = await writePackBadge(pack.root, badge)
      process.stdout.write(
        `[pack] ran ${run.total} probe(s): ${run.passed} passed, ${run.failed} failed${
          run.ok ? "" : " (NOT ok)"
        }.\n`,
      )
    } else {
      const scan = await readScanResult(scanPath as string)
      const badge = buildSecurityScanBadge(pack.manifest, scan, {
        attesterId: attester,
        privateKeyPem,
        at,
      })
      badgePath = await writePackBadge(pack.root, badge)
      process.stdout.write(
        `[pack] scan verdict: ${scan.status}${
          scan.findings_count > 0 ? ` (${scan.findings_count} finding(s))` : ""
        }.\n`,
      )
    }

    process.stdout.write(
      `[pack] issued a '${kind}' badge for '${pack.manifest.name}' v${pack.manifest.version} as attester '${attester}'.\n` +
        `       badge:  ${badgePath}\n\n` +
        `Consumers trust it only if they pin your attester key in ${DEFAULT_PACK_TRUST_PATH} under attester_keys.\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`[pack] attest failed: ${err.message}\n`)
      // A signed pack loaded without its author pinned fails here; hint the fix.
      if (err.message.includes("operator-pinned") || err.message.includes("unsigned")) {
        process.stderr.write(
          "        (the pack is signed — pass --author-key <id>=<public-key-file> to load it for attestation)\n",
        )
      }
      return 1
    }
    throw err
  }
}

/** Read + validate a `security_scan` verdict file into a {@link SecurityScanBadgeResult}. */
async function readScanResult(path: string): Promise<SecurityScanBadgeResult> {
  let raw: string
  try {
    raw = await readFile(resolve(process.cwd(), path), "utf8")
  } catch (err) {
    throw new ProbePackError(`could not read scan result file: ${path} (${errMessage(err)})`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ProbePackError(`scan result file is not valid JSON: ${path}`)
  }
  const parsed = SecurityScanBadgeResultSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("\n")
    throw new ProbePackError(`scan result file failed validation: ${path}\n${issues}`)
  }
  return parsed.data
}

// ── add ──────────────────────────────────────────────────────────────────────

async function addCommand(argv: string[]): Promise<number> {
  let source: string | undefined
  let integrity: string | undefined
  let registry: string | undefined
  let trustConfigPath: string | undefined
  let lockfilePath = DEFAULT_PACK_LOCKFILE_PATH
  let installDir: string | undefined = ".lodestar/packs"
  let allowUnsigned = false
  const authorKeyFlags: PackAuthorKey[] = []
  const attesterKeyFlags: PackAttesterKey[] = []
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--integrity") {
        integrity = takeValue(argv, i, arg)
        i++
      } else if (arg === "--registry") {
        registry = takeValue(argv, i, arg)
        i++
      } else if (arg === "--trust-config") {
        trustConfigPath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--lockfile") {
        lockfilePath = takeValue(argv, i, arg)
        i++
      } else if (arg === "--install-dir") {
        installDir = takeValue(argv, i, arg)
        i++
      } else if (arg === "--no-install") {
        installDir = undefined
      } else if (arg === "--allow-unsigned") {
        allowUnsigned = true
      } else if (arg === "--author-key") {
        // `--author-key <author-id>=<spki-pem-file>` (repeatable).
        const spec = takeValue(argv, i, arg)
        i++
        const parsed = await parseKeyFileFlag(spec, "--author-key")
        if ("error" in parsed) {
          process.stderr.write(`${parsed.error}\n`)
          return 2
        }
        authorKeyFlags.push({ actor_id: parsed.actorId, public_key: parsed.publicKey })
      } else if (arg === "--attester-key") {
        // `--attester-key <attester-id>=<spki-pem-file>` (repeatable). The separate
        // badge trust root (ADR-0020) — pinning an attester only governs which
        // badges are trusted, never whether the pack loads.
        const spec = takeValue(argv, i, arg)
        i++
        const parsed = await parseKeyFileFlag(spec, "--attester-key")
        if ("error" in parsed) {
          process.stderr.write(`${parsed.error}\n`)
          return 2
        }
        attesterKeyFlags.push({ attester_id: parsed.actorId, public_key: parsed.publicKey })
      } else if (arg === "--help" || arg === "-h") {
        writeUsage(process.stdout)
        return 0
      } else if (arg?.startsWith("-")) {
        process.stderr.write(`unknown flag for 'add': ${arg}\n`)
        writeUsage(process.stderr)
        return 2
      } else if (source === undefined) {
        source = arg
      } else {
        process.stderr.write(`unexpected extra argument for 'add': ${arg}\n`)
        writeUsage(process.stderr)
        return 2
      }
    }
  } catch (err) {
    if (err instanceof PackUsageError) {
      process.stderr.write(`${err.message}\n`)
      writeUsage(process.stderr)
      return 2
    }
    throw err
  }

  if (source === undefined) {
    process.stderr.write("missing <source> for 'add'\n")
    writeUsage(process.stderr)
    return 2
  }

  const parsedSource = parseSourceArg(source, { integrity, registry })
  if ("error" in parsedSource) {
    process.stderr.write(`[pack] ${parsedSource.error}\n`)
    writeUsage(process.stderr)
    return 2
  }

  // Merge the operator's pinned author keys. A `--author-key` flag is a deliberate
  // command-line override, so it takes precedence over a trust-config entry for the
  // same author (key rotation / a one-off pin): `lookupPinnedKey` returns the first
  // match for an author_id, so the flags must come FIRST. An empty set with no
  // --allow-unsigned means a signed pack is verifiable only if its author is pinned,
  // and an unsigned pack is rejected (fail closed).
  let pinnedKeys: PackAuthorKey[]
  let pinnedAttesterKeys: PackAttesterKey[]
  try {
    const trust = await readPackTrustConfig(trustConfigPath ?? DEFAULT_PACK_TRUST_PATH, {
      required: trustConfigPath !== undefined,
    })
    pinnedKeys = mergePinnedAuthorKeys(trust.author_keys, authorKeyFlags)
    // Attester keys merge the same way (flags first, so a command-line key wins for
    // the same attester id) — but they are advisory: an empty set just means no
    // badge is trusted, never that the pack is rejected.
    pinnedAttesterKeys = [...attesterKeyFlags, ...trust.attester_keys]
    // The config's own opt-out also counts, alongside the flag.
    if (trust.allow_unsigned === true) allowUnsigned = true
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`[pack] ${err.message}\n`)
      return 1
    }
    throw err
  }

  try {
    const added = await addProbePack({
      ref: parsedSource.ref,
      authorizedAuthorKeys: pinnedKeys,
      authorizedAttesterKeys: attesterKeysAsPinned(pinnedAttesterKeys),
      allowUnsigned,
      ...(installDir !== undefined ? { installRoot: resolve(process.cwd(), installDir) } : {}),
      lockfilePath: resolve(process.cwd(), lockfilePath),
      at: new Date().toISOString(),
    })
    const m = added.pack.manifest
    // Surface what verified, then where it landed.
    process.stdout.write(
      `[pack] verified '${m.name}' v${m.version} (source ${m.source_type})` +
        `${m.author_id ? ` signed by '${m.author_id}'` : " (UNSIGNED — allow_unsigned)"}.\n` +
        `       coverage:    ${m.coverage_areas.join(", ")}\n` +
        `       invariants:  ${m.invariants.join(", ")}\n` +
        `       probes:      ${added.pack.probes.length}` +
        `${added.pack.sentinels.length > 0 ? `   sentinels: ${added.pack.sentinels.length}` : ""}\n`,
    )
    if (added.installedRoot !== undefined) {
      process.stdout.write(`       installed:   ${added.installedRoot}\n`)
    }
    if (added.lockEntry !== undefined) {
      process.stdout.write(
        `       recorded:    ${resolve(process.cwd(), lockfilePath)} (manifest ${added.lockEntry.manifest_hash.slice(0, 12)}…)\n`,
      )
    }
    writeBadgeSummary(added.badges)
    if (added.installedRoot !== undefined) {
      process.stdout.write(`\nRun it:  lodestar harness run --pack ${added.installedRoot}\n`)
    }
    return 0
  } catch (err) {
    if (err instanceof ProbePackError) {
      process.stderr.write(`[pack] add failed: ${err.message}\n`)
      return 1
    }
    throw err
  }
}

/**
 * Print the pack's verification badges after an add (ADR-0020). Advisory: a
 * `verified` badge from a pinned attester is signal; everything else is surfaced as
 * exactly what it is — `unverified` (forged / un-pinned attester / tampered),
 * `not_applicable` (mis-attached — issued over different bytes), or `malformed` — and
 * **never counted as trusted**. No badges prints nothing (a pack need not carry any).
 */
function writeBadgeSummary(badges: BadgeVerification[]): void {
  if (badges.length === 0) return
  const verified = badges.filter((b) => b.status === "verified").length
  process.stdout.write(
    `       badges:      ${verified}/${badges.length} verified (trusted only when verified against a pinned attester)\n`,
  )
  for (const b of badges) {
    const mark = b.status === "verified" ? "✓" : "•"
    const kind = b.badge?.kind ?? "?"
    const attester = b.badge?.attester_id ?? "?"
    const detail =
      b.status === "verified"
        ? `attester '${attester}'`
        : `${b.status}${b.reason ? ` — ${b.reason}` : ""}`
    process.stdout.write(`         ${mark} ${kind} (${b.file}): ${detail}\n`)
  }
}

/**
 * Parse a `pack add` source argument into a {@link PackSourceRef}. Accepts:
 *   - `npm:<pkg>@<version>`   (requires `--integrity <sri>`; optional `--registry`)
 *   - `git:<url>#<40-hex>`    (full immutable commit SHA in the fragment)
 *   - `local:<path>` or a path (a local pack directory / manifest, resolved in place)
 *
 * Returns `{ error }` for a malformed argument; the descriptor's *contents* (exact
 * semver, full SHA, package-name shape) are validated downstream by the schema, so
 * this only catches shape errors the user can fix from the message.
 */
/**
 * Merge operator-pinned author keys from the trust config with `--author-key`
 * flags. Flags come **first** so a command-line key overrides a config entry for
 * the same author (`lookupPinnedKey` returns the first match for an author_id) —
 * the desired precedence for key rotation or a one-off override.
 */
export function mergePinnedAuthorKeys(
  configKeys: PackAuthorKey[],
  flagKeys: PackAuthorKey[],
): PackAuthorKey[] {
  return [...flagKeys, ...configKeys]
}

export function parseSourceArg(
  arg: string,
  opts: { integrity?: string; registry?: string },
): { ref: PackSourceRef } | { error: string } {
  if (arg.startsWith("npm:")) {
    const spec = arg.slice("npm:".length)
    const at = spec.lastIndexOf("@")
    // at <= 0: no version, or only the scope's leading '@' (e.g. "@scope/name").
    if (at <= 0) {
      return { error: `npm source needs a version: 'npm:<package>@<version>' (got '${arg}')` }
    }
    const pkg = spec.slice(0, at)
    const version = spec.slice(at + 1)
    if (opts.integrity === undefined || opts.integrity === "") {
      return {
        error: `npm source requires --integrity <sri> (the pinned tarball hash, e.g. 'sha512-…')`,
      }
    }
    const ref: PackSourceRef = {
      type: "npm",
      package: pkg,
      version,
      integrity: opts.integrity,
    }
    if (opts.registry !== undefined && opts.registry !== "") ref.registry = opts.registry
    return { ref }
  }

  if (arg.startsWith("git:")) {
    const spec = arg.slice("git:".length)
    const hash = spec.lastIndexOf("#")
    if (hash <= 0) {
      return {
        error: `git source needs a pinned commit: 'git:<url>#<full-40-hex-sha>' (got '${arg}')`,
      }
    }
    return {
      ref: { type: "git", url: spec.slice(0, hash), commit: spec.slice(hash + 1) },
    }
  }

  const path = arg.startsWith("local:") ? arg.slice("local:".length) : arg
  return { ref: { type: "local", path: resolve(process.cwd(), path) } }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a signing PKCS#8 PEM private key, or `undefined` when none is supplied. A
 * `--key <path>` is read from disk; otherwise the named env var (`LODESTAR_AUTHOR_KEY`
 * for publish, `LODESTAR_ATTESTER_KEY` for attest) carries the PEM directly. The key
 * material is never an argv value.
 */
async function loadSigningKey(
  keyPath: string | undefined,
  envVar: string,
): Promise<string | undefined> {
  if (keyPath !== undefined && keyPath !== "") {
    return await readFile(resolve(process.cwd(), keyPath), "utf8")
  }
  const fromEnv = process.env[envVar]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv
  return undefined
}

/**
 * Parse an `<id>=<public-key-file>` flag (`--author-key` / `--attester-key`),
 * reading the SPKI PEM from disk. Splits on the FIRST `=` so a key path may itself
 * contain `=`. Returns `{ error }` on a malformed spec or an unreadable file.
 */
async function parseKeyFileFlag(
  spec: string,
  flag: string,
): Promise<{ actorId: string; publicKey: string } | { error: string }> {
  const eq = spec.indexOf("=")
  if (eq <= 0) return { error: `${flag} expects <id>=<public-key-file>, got '${spec}'` }
  const actorId = spec.slice(0, eq)
  const keyPath = spec.slice(eq + 1)
  try {
    const publicKey = await readFile(resolve(process.cwd(), keyPath), "utf8")
    return { actorId, publicKey }
  } catch {
    return { error: `${flag} public-key file not found or unreadable: ${keyPath}` }
  }
}

/** Map operator-pinned attester keys to the shared pinned-key list shape (`actor_id`). */
function attesterKeysAsPinned(keys: PackAttesterKey[]): { actor_id: string; public_key: string }[] {
  return keys.map((k) => ({ actor_id: k.attester_id, public_key: k.public_key }))
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    `usage: lodestar pack keygen  (--author <id> | --attester <id>) [--out <prefix>]
       lodestar pack publish [--pack <dir>] --author <id> [--key <path>]
                             [--source-type <local|npm|git>]
       lodestar pack attest  [--pack <dir>] --kind <probe_results|security_scan>
                             --attester <id> [--key <path>] [--scan <file>]
                             [--author-key <id>=<file>]...
       lodestar pack add <source> [--author-key <id>=<file>]... [--attester-key <id>=<file>]...
                         [--trust-config <path>] [--integrity <sri>] [--registry <url>]
                         [--allow-unsigned] [--lockfile <path>] [--install-dir <dir>] [--no-install]

  Author + consumer + attestation flow for signed trust-packs (ADR-0019 / ADR-0020).

  keygen  — mint an Ed25519 keypair for one role: --author (signs manifests, pinned
            under author_keys) or --attester (signs badges, pinned under attester_keys).

  publish — freeze the pack files, content-digest them, sign the manifest in place,
            and self-verify. The author key comes from --key or LODESTAR_AUTHOR_KEY
            (never argv). Mint one with 'lodestar pack keygen --author'.

  attest  — issue a locally-verifiable signed badge over a pack, written into its
            badges/ directory and bound to the pack's manifest hash:
              probe_results — run the pack's probes and sign the summary.
              security_scan — sign a provided verdict (--scan <result.json>).
            The attester key comes from --key or LODESTAR_ATTESTER_KEY (never argv).

  add     — resolve a PINNED source via a non-executing fetch (no install/lifecycle
            scripts run), verify the signature + content digest against pinned author
            keys BEFORE any pack code could run, then install + record the pin and
            surface the pack's badges (verified against pinned attester keys).
    sources:  npm:<pkg>@<version> --integrity <sri>   git:<url>#<full-40-hex-sha>
              local:<path>  (or a bare path)
    keys:     authors pinned in ${DEFAULT_PACK_TRUST_PATH} (or --trust-config) plus --author-key;
              attesters pinned there too (attester_keys) plus --attester-key (advisory).
              An unsigned pack is rejected unless --allow-unsigned is explicit; badges
              are advisory and never gate the add.
`,
  )
}
