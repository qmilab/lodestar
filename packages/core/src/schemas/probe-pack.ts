import { z } from "zod"

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
 * Where a pack's probe files come from.
 *
 * `local` — the pack lives on the filesystem; probe `file` paths are
 *   resolved relative to the directory containing the manifest.
 * `npm` — the pack ships as a published package; the loader reads the
 *   manifest from the package's `./lodestar.probe-pack.json` export and
 *   resolves probe files relative to the package root.
 *
 * Both source types are part of the spec from day one so external
 * authors can target a stable schema. The v0 loader resolves `local`
 * only; `npm` resolution follows the first external pack that needs it
 * (see docs/architecture/reflection-pass.md Q6).
 */
export const ProbePackSourceTypeSchema = z.enum(["local", "npm"])
export type ProbePackSourceType = z.infer<typeof ProbePackSourceTypeSchema>

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
    "How the loader resolves probe files. The v0 loader resolves 'local' only.",
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
  sentinels: z
    .array(SentinelEntrySchema)
    .default([])
    .describe(
      "The sentinels this pack ships, referenced by stable id and resolved by the harness against its built-in registry. Optional; defaults to none. Additive since spec '1' — a manifest without this field still loads.",
    ),
})
export type ProbePackManifest = z.infer<typeof ProbePackManifestSchema>

/**
 * The manifest filename a `local` pack carries at its root, and the
 * export key an `npm` pack exposes it under. Defined as a constant so
 * loaders and pack authors agree on the spelling.
 */
export const PROBE_PACK_MANIFEST_FILENAME = "lodestar.probe-pack.json" as const
