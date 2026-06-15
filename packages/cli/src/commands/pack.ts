import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type PackAuthorKey,
  type PackSourceRef,
  type ProbePackSourceType,
  ProbePackSourceTypeSchema,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import {
  DEFAULT_PACK_LOCKFILE_PATH,
  DEFAULT_PACK_TRUST_PATH,
  ProbePackError,
  addProbePack,
  publishProbePack,
  readPackTrustConfig,
} from "@qmilab/lodestar-harness"

/** Env var holding the author's PKCS#8 PEM private key (off argv; never logged). */
const AUTHOR_KEY_ENV = "LODESTAR_AUTHOR_KEY"

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
 * `lodestar pack` — the trust-pack author + consumer flow (#90, ADR-0019).
 *
 *   lodestar pack keygen  --author <id> [--out <prefix>]
 *   lodestar pack publish [--pack <dir>] --author <id> [--key <path>] [--source-type <local|npm|git>]
 *   lodestar pack add <source> [--author-key <id>=<file>]... [--trust-config <path>]
 *                     [--integrity <sri>] [--registry <url>] [--allow-unsigned]
 *                     [--lockfile <path>] [--install-dir <dir>] [--no-install]
 *
 * `publish` signs a pack's manifest in place (freeze files → content digest → sign
 * → self-verify); `add` resolves a pinned source via a non-executing fetch,
 * verifies the signature + content digest against operator-pinned author keys
 * **before any pack code could run**, then surfaces / installs / records the pin.
 * `keygen` mints an author keypair, mirroring `approve keygen`.
 *
 * The logic lives in `@qmilab/lodestar-harness`; this is the thin CLI shell.
 *
 * Exit codes:
 *   0  — success
 *   1  — runtime / verification failure (the publish or add did not complete)
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
 * Mint an Ed25519 author keypair. The private key signs pack manifests; the public
 * key is what a consumer pins in their trust config (`pack-trust.json`). Mirrors
 * `approve keygen` — same key format and the same temp+rename 0600 discipline for
 * the private key — but labels the printed pin for the pack trust config.
 */
async function keygenCommand(argv: string[]): Promise<number> {
  let author: string | undefined
  let outPath: string | undefined
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--author" || arg === "-a") {
        author = takeValue(argv, i, arg)
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
  if (author === undefined || author === "") {
    process.stderr.write(
      "missing required --author <id> for 'keygen'\n          (the author_id the key signs as; it must match your later 'pack publish --author')\n",
    )
    return 2
  }

  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
  const pin = JSON.stringify({ actor_id: author, public_key: publicKeyPem }, null, 2)

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
      `[pack] wrote author keypair:\n  private (keep secret, mode 0600): ${privPath}\n  public  (give to consumers):       ${pubPath}\n\n` +
        `Sign with it:   lodestar pack publish --pack <dir> --author ${author} --key ${privPath}\n` +
        `Consumers pin it in ${DEFAULT_PACK_TRUST_PATH} under author_keys:\n${pin}\n`,
    )
    return 0
  }

  process.stdout.write(
    `# Ed25519 pack-author keypair. Keep the PRIVATE key secret (a secret store / a 0600 file).
# Sign with:  lodestar pack publish --pack <dir> --author ${author} --key <private-key-file>
#       or:  ${AUTHOR_KEY_ENV}="$(cat <private-key-file>)" lodestar pack publish ...

# --- PRIVATE KEY (PKCS#8) ---
${privateKeyPem}
# --- PUBLIC KEY (SPKI) — consumers pin this in ${DEFAULT_PACK_TRUST_PATH} ---
${publicKeyPem}
# pack-trust.json author_keys entry:
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
    privateKeyPem = await loadAuthorKey(keyPath)
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
        // `--author-key <author-id>=<spki-pem-file>` (repeatable). Split on the
        // FIRST '=' so a key path may itself contain '='.
        const spec = takeValue(argv, i, arg)
        i++
        const eq = spec.indexOf("=")
        if (eq <= 0) {
          process.stderr.write(
            `--author-key expects <author-id>=<public-key-file>, got '${spec}'\n`,
          )
          return 2
        }
        const actorId = spec.slice(0, eq)
        const keyPath = spec.slice(eq + 1)
        let publicKey: string
        try {
          publicKey = await readFile(resolve(process.cwd(), keyPath), "utf8")
        } catch {
          process.stderr.write(`--author-key public-key file not found or unreadable: ${keyPath}\n`)
          return 2
        }
        authorKeyFlags.push({ actor_id: actorId, public_key: publicKey })
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
  try {
    const trust = await readPackTrustConfig(trustConfigPath ?? DEFAULT_PACK_TRUST_PATH, {
      required: trustConfigPath !== undefined,
    })
    pinnedKeys = mergePinnedAuthorKeys(trust.author_keys, authorKeyFlags)
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
 * Resolve the author's PKCS#8 PEM private key, or `undefined` when none is
 * supplied. A `--key <path>` is read from disk; otherwise `LODESTAR_AUTHOR_KEY`
 * carries the PEM directly. The key material is never an argv value.
 */
async function loadAuthorKey(keyPath: string | undefined): Promise<string | undefined> {
  if (keyPath !== undefined && keyPath !== "") {
    return await readFile(resolve(process.cwd(), keyPath), "utf8")
  }
  const fromEnv = process.env[AUTHOR_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv
  return undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    `usage: lodestar pack keygen  --author <id> [--out <prefix>]
       lodestar pack publish [--pack <dir>] --author <id> [--key <path>]
                             [--source-type <local|npm|git>]
       lodestar pack add <source> [--author-key <id>=<file>]... [--trust-config <path>]
                         [--integrity <sri>] [--registry <url>] [--allow-unsigned]
                         [--lockfile <path>] [--install-dir <dir>] [--no-install]

  Author + consumer flow for signed trust-packs (ADR-0019).

  publish — freeze the pack files, content-digest them, sign the manifest in place,
            and self-verify. The author key comes from --key or LODESTAR_AUTHOR_KEY
            (never argv). Mint one with 'lodestar pack keygen'.

  add     — resolve a PINNED source via a non-executing fetch (no install/lifecycle
            scripts run), verify the signature + content digest against pinned author
            keys BEFORE any pack code could run, then install + record the pin.
    sources:  npm:<pkg>@<version> --integrity <sri>   git:<url>#<full-40-hex-sha>
              local:<path>  (or a bare path)
    keys:     pinned in ${DEFAULT_PACK_TRUST_PATH} (or --trust-config), plus --author-key.
              An unsigned pack is rejected unless --allow-unsigned is explicit.
`,
  )
}
