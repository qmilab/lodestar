import { z } from "zod"
import { SignatureSchema } from "./actor.js"

/**
 * The probe-pack format spec version. This is the version of the
 * *manifest schema itself*, not of any given pack. A loader declares
 * which spec versions it understands; a manifest declares which one it
 * was written against. v0 of the harness understands spec "1" only.
 *
 * Bump this when the manifest shape changes in a way older loaders
 * cannot read. Adding an optional field is not a bump; removing or
 * re-typing a field is.
 */
export const PROBE_PACK_SPEC_VERSION = "1" as const

/**
 * Where a pack's probe files come from — the manifest's self-declaration of
 * its intended distribution channel. Distinct from {@link PackSourceRefSchema},
 * which is the *consumer's* pinned addressing descriptor used to resolve the
 * bytes (ADR-0016 §1, #86). The loader cross-checks the two: a pack resolved via
 * an `npm` ref must declare `source_type: "npm"`.
 *
 * `local` — the pack lives on the filesystem; probe `file` paths are
 *   resolved relative to the directory containing the manifest.
 * `npm` — the pack ships as a published package; the loader reads the
 *   manifest from the package's `./lodestar.probe-pack.json` export and
 *   resolves probe files relative to the extracted package root.
 * `git` — the pack ships in a git repository, resolved at a pinned full
 *   commit SHA (a mutable branch/tag is rejected; ADR-0016 §1).
 *
 * All source types are part of the spec from day one so external authors can
 * target a stable schema. `npm` and `git` resolution landed in #86 (ADR-0018);
 * once the bytes are on disk every source type loads identically.
 */
export const ProbePackSourceTypeSchema = z.enum(["local", "npm", "git"])
export type ProbePackSourceType = z.infer<typeof ProbePackSourceTypeSchema>

/**
 * A consumer's pinned, immutable addressing descriptor for resolving a pack to
 * bytes (ADR-0016 §1, #86 / ADR-0018). This is *resolution input* — how an
 * operator points the loader at a pack that lives elsewhere — and is distinct
 * from a manifest's own {@link ProbePackSourceTypeSchema} self-declaration. The
 * load-bearing property is **immutability**: source resolution is otherwise an
 * unauthenticated step that could deliver different contents under a still-valid
 * manifest signature, so every non-local ref pins an immutable artifact (an exact
 * npm version + SRI integrity, or a full git commit SHA). After resolution the
 * loader recomputes the signed `content_digest` over the fetched files, so a
 * swapped artifact under a re-pointed ref is caught even if the signature still
 * verifies.
 */
export const LocalPackSourceSchema = z
  .object({
    type: z.literal("local"),
    path: z.string().min(1).describe("Filesystem path to the pack directory or its manifest file."),
  })
  .describe("A pack already on the local filesystem; no fetch, resolved in place.")

export const NpmPackSourceSchema = z
  .object({
    type: z.literal("npm"),
    package: z
      .string()
      .min(1)
      .regex(
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
        "must be a valid npm package name (optionally scoped)",
      )
      .describe("Published package name, e.g. '@qmilab/some-pack' or 'some-pack'."),
    version: z
      .string()
      // EXACT version only: a range (`^1.2.3`, `~1.2`, `*`, `latest`) is not an
      // immutable artifact, so resolution would not be reproducible. The npm
      // registry's version endpoint requires an exact version anyway.
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
        "must be an EXACT semver version — a range, tag, or 'latest' is rejected (resolution must be immutable)",
      )
      .describe("Exact published version. A range or dist-tag is rejected."),
    integrity: z
      .string()
      .regex(
        /^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/,
        "must be a Subresource-Integrity hash, e.g. 'sha512-<base64>'",
      )
      .describe(
        "SRI integrity hash the downloaded tarball must match (the pin). Compared both against the registry's advertised integrity and the bytes actually downloaded.",
      ),
    registry: z
      .string()
      .url()
      .optional()
      .describe("Registry base URL. Defaults to the public npm registry when absent."),
  })
  .describe("A published npm package, pinned to an exact version + tarball SRI integrity.")

export const GitPackSourceSchema = z
  .object({
    type: z.literal("git"),
    url: z.string().min(1).describe("Git remote URL (https / ssh / file)."),
    commit: z
      .string()
      .regex(
        /^[0-9a-f]{40}$/,
        "git source must pin a FULL 40-hex commit SHA — a branch, tag, or short SHA can be force-moved and is rejected",
      )
      .describe(
        "Full 40-hex commit SHA. A mutable ref (branch/tag/short SHA) is rejected: it is not an immutable artifact (ADR-0016 §1).",
      ),
  })
  .describe("A git repository, pinned to a full immutable commit SHA.")

export const PackSourceRefSchema = z.discriminatedUnion("type", [
  LocalPackSourceSchema,
  NpmPackSourceSchema,
  GitPackSourceSchema,
])
export type PackSourceRef = z.infer<typeof PackSourceRefSchema>
export type LocalPackSource = z.infer<typeof LocalPackSourceSchema>
export type NpmPackSource = z.infer<typeof NpmPackSourceSchema>
export type GitPackSource = z.infer<typeof GitPackSourceSchema>

/**
 * One probe entry in a pack manifest.
 *
 * `name` is the probe's stable identifier, unique within the pack — the
 * harness runner reports results under it and external references
 * address probes by `<pack>/<name>`. `file` is the probe source,
 * relative to the pack root.
 */
export const ProbeEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "probe name must be kebab-case (lowercase alphanumerics separated by single hyphens)",
    )
    .describe("Stable probe identifier, unique within the pack."),
  file: z
    .string()
    .min(1)
    // Must be relative to the pack root: a pack that names an absolute
    // path loads on its author's machine but breaks once moved or
    // published. Reject POSIX (`/`), UNC/Windows-root (`\`), and
    // drive-letter (`C:`) prefixes so the contract holds cross-platform.
    .refine((f) => !/^([/\\]|[A-Za-z]:)/.test(f), {
      message:
        "probe file must be a relative path inside the pack (absolute paths are not allowed)",
    })
    .describe(
      "Probe source file, relative to the pack root (the directory containing the manifest).",
    ),
})
export type ProbeEntry = z.infer<typeof ProbeEntrySchema>

/**
 * One sentinel entry in a pack manifest.
 *
 * Unlike a probe — a `bun run`-able script the pack carries as a `file` —
 * a sentinel is a stateful in-process class the harness instantiates and
 * feeds the event stream. There is no subprocess contract for it, so the
 * manifest references a sentinel by a stable `id` and the harness resolves
 * that id against its built-in registry of first-party sentinels
 * (`FIRST_PARTY_SENTINELS` in `@qmilab/lodestar-harness`). A pack thus
 * *declares* which built-in sentinels it ships rather than carrying their
 * source.
 *
 * Per-pack construction-option overrides and third-party (file-referenced)
 * sentinels are a deliberate later refinement — see the harness loader and
 * `docs/architecture/sentinels.md`. v0 resolves first-party ids only.
 */
export const SentinelEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "sentinel id must be kebab-case (lowercase alphanumerics separated by single hyphens)",
    )
    .describe(
      "Stable id of a first-party sentinel, resolved by the harness against its built-in registry. Matches the sentinel's own `name`.",
    ),
})
export type SentinelEntry = z.infer<typeof SentinelEntrySchema>

/**
 * One file's hash in a pack's content digest: a probe `file` path (relative to
 * the pack root, as declared in the manifest) and the sha-256 hex of its bytes.
 */
export const PackFileDigestSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Probe file path, relative to the pack root, as written in the manifest."),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters")
    .describe("sha-256 hex of the file's bytes."),
})
export type PackFileDigest = z.infer<typeof PackFileDigestSchema>

/**
 * The content digest a signed manifest binds (ADR-0016 §2 / ADR-0017).
 *
 * A sorted per-file sha-256 list over every probe `file` the manifest declares.
 * Because `content_digest` is part of the canonical manifest the signature
 * covers, signing the manifest transitively authenticates the shipped probe
 * *bytes*, not merely their names — so a re-pointed git tag or re-published npm
 * artifact that swaps a probe's bytes under a still-valid signature is caught at
 * load. The list is stored (not just a combined hash) so the loader can name the
 * offending file on mismatch and so the binding is auditable.
 *
 * Sentinels are out of the digest by construction: a pack references them by id
 * and the harness resolves them against its in-process registry, so the pack
 * ships no sentinel bytes. v0 scope is the declared probe files; whole-tree
 * hashing (catching an undeclared helper a probe imports) is a documented
 * hardening follow-up.
 */
export const PackContentDigestSchema = z.object({
  algorithm: z.literal("sha256").describe("Digest algorithm. v0 is sha-256 only."),
  files: z
    .array(PackFileDigestSchema)
    .describe(
      "Per-file sha-256 over every probe file the manifest declares, sorted by path. The loader recomputes this from the resolved files and rejects a mismatch.",
    ),
})
export type PackContentDigest = z.infer<typeof PackContentDigestSchema>

/**
 * A `lodestar.probe-pack.json` manifest.
 *
 * This is the on-disk / on-wire contract every probe pack — first-party
 * and external — is written against. It is deliberately declarative:
 * the manifest names probes and their files but contains no executable
 * logic. The harness loader (in `@qmilab/lodestar-harness`) reads it,
 * validates it against this schema, and resolves the probe files; the
 * runner (Batch 4 step 5) executes them.
 *
 * `coverage_areas` and `invariants` are free-form taxonomy tags the
 * pack author declares. They are not validated against a closed list —
 * the harness uses them for `lodestar harness list` grouping and for
 * answering "which pack exercises invariant X?", not for gating. Keeping
 * them open lets external packs name coverage the core taxonomy has not
 * yet enumerated.
 */
export const ProbePackManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "pack name must be kebab-case (lowercase alphanumerics separated by single hyphens)",
    )
    .describe("Pack identifier, e.g. 'lodestar-core'."),
  version: z
    .string()
    .min(1)
    .describe("Pack version (the author's, not the spec version). Conventionally semver."),
  spec_version: z
    .literal(PROBE_PACK_SPEC_VERSION)
    .describe(
      "Manifest-schema spec version. v0 loaders accept only '1' and reject unknown versions with a clear error rather than guessing.",
    ),
  source_type: ProbePackSourceTypeSchema.describe(
    "The pack's self-declared distribution channel (local / npm / git). A non-local resolution cross-checks this against the consumer's PackSourceRef.",
  ),
  description: z
    .string()
    .min(1)
    .optional()
    .describe("Human-readable one-liner shown by `lodestar harness list`."),
  coverage_areas: z
    .array(z.string().min(1))
    .describe("Free-form tags naming the threat-model / subsystem areas this pack covers."),
  invariants: z
    .array(z.string().min(1))
    .describe("Free-form tags naming the Lodestar invariants this pack's probes exercise."),
  probes: z
    .array(ProbeEntrySchema)
    .min(1, "a pack must declare at least one probe")
    .describe("The probes this pack ships."),
  // `.optional()` rather than `.default([])` on purpose: a default makes the
  // field REQUIRED in the `z.infer` *output* type, so external TS code that
  // constructs a manifest without `sentinels` would fail to compile — breaking
  // the "additive optional field is free" promise. Keeping it optional leaves
  // the public type backward-compatible; the loader treats an absent value as
  // "no sentinels". Do not reintroduce `.default([])`.
  sentinels: z
    .array(SentinelEntrySchema)
    .optional()
    .describe(
      "The sentinels this pack ships, referenced by stable id and resolved by the harness against its built-in registry. Optional; an absent field means the pack ships no sentinels. Additive since spec '1' — a manifest without it still loads.",
    ),
  // ── Signing (ADR-0017, #88). All three are additive-optional since spec "1":
  // an older loader still reads a manifest without them, and an unsigned
  // first-party pack omits all three. They appear together on a signed pack and
  // are bound to each other — `author_id` and `content_digest` are part of the
  // canonical document the `signature` covers (everything except `signature`),
  // so a verifier reproduces the signed bytes from the rest of the manifest.
  author_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The pack author's signer id. Present on a signed pack; the loader requires it equal signature.signer_id and be in the operator-pinned author-key set.",
    ),
  content_digest: PackContentDigestSchema.optional().describe(
    "Per-file sha-256 over the declared probe files. Bound by the signature; recomputed and compared by the loader. Present on a signed pack.",
  ),
  signature: SignatureSchema.optional().describe(
    "Ed25519 signature over the canonical manifest (every field except this one, content_digest included). Verified on load against operator-pinned author keys. Absent on an unsigned (allow_unsigned) pack.",
  ),
})
export type ProbePackManifest = z.infer<typeof ProbePackManifestSchema>

/**
 * The manifest filename a `local` pack carries at its root, and the
 * export key an `npm` pack exposes it under. Defined as a constant so
 * loaders and pack authors agree on the spelling.
 */
export const PROBE_PACK_MANIFEST_FILENAME = "lodestar.probe-pack.json" as const
