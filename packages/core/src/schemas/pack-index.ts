import { z } from "zod"
import { SignatureSchema } from "./actor.js"
import { PackBadgeKindSchema } from "./pack-badge.js"
import { PackSourceRefSchema } from "./probe-pack.js"

/**
 * The pack discovery index (ADR-0021, #87) — the registry's read-side discovery
 * surface, and the last of the six registry children (ADR-0016 step 6).
 *
 * Discovery in the open layer is **a protocol, not a service** (ADR-0016 §1): a
 * fetchable **static signed JSON document** that lists packs and where to resolve
 * them, hostable anywhere (a gist, a repo, an object store) with no Lodestar-hosted
 * dependency. It is the discovery analogue of npm's registry metadata, kept
 * deliberately thin because the hosted search/ranking backend is the commercial
 * surface (ADR-0016 §4).
 *
 * The index is signed with the same Ed25519 lineage as manifests (ADR-0017) and
 * badges (ADR-0020), so a consumer pins an **index-publisher** key and verifies the
 * listing locally (`PackIndexPublisherKeySchema`, pinned under `index_publisher_keys`
 * in `PackTrustConfigSchema`). The publisher key is a *third*, separate trust root:
 * pinning an index publisher governs only whose *advertisement* you trust, never
 * whether a pack loads.
 *
 * The load-bearing decentralization property (ADR-0016 §1, threat-model §5): an index
 * is an **advertisement, not an authority**. A hostile or tampered index can mis-list,
 * omit, or re-point an entry, but it can never make an unsigned or forged pack
 * verify — choosing a discovered pack still routes through source resolution (#86)
 * and verify-on-load (#88) against the consumer's pinned *author* keys. So the worst
 * a bad index does is waste a fetch; the trust is in the pack signature, not the index.
 */

/**
 * The index-format spec version (the schema's own version, not a listed pack's).
 * Bumped only when the index shape changes in a way an older reader cannot parse —
 * the same discipline as {@link PROBE_PACK_SPEC_VERSION}. Adding an optional field is
 * not a bump; removing or re-typing a field is.
 */
export const PACK_INDEX_SPEC_VERSION = "1" as const

/**
 * One operator-pinned **index-publisher** public key — the separate trust root for
 * discovery indexes (ADR-0021). Distinct from both {@link PackAuthorKeySchema} (signs
 * pack *bytes*) and {@link PackAttesterKeySchema} (signs *attestations about* a pack):
 * an index publisher signs a *listing*. The three are pinned separately so an
 * operator can trust a community index's curation without trusting its publisher to
 * author or attest packs. An index is trusted only when its `publisher_id` is pinned
 * here and its signature verifies against this key.
 */
export const PackIndexPublisherKeySchema = z
  .object({
    publisher_id: z
      .string()
      .min(1)
      .describe("The index publisher's signer id; must equal a signed index's publisher_id."),
    public_key: z
      .string()
      .min(1)
      .describe("The publisher's Ed25519 public key in SPKI PEM form (the pinned trust anchor)."),
  })
  .describe("An operator-pinned discovery-index-publisher key.")
export type PackIndexPublisherKey = z.infer<typeof PackIndexPublisherKeySchema>

/**
 * An **advisory** advertisement that a listed pack carries a badge (ADR-0020). It is
 * a hint shown in discovery output, *never* a trust signal: the index is unauthenticated
 * with respect to a pack's badges, so a consumer that wants to trust a badge must
 * resolve the pack and verify the actual `badges/*.badge.json` against its own pinned
 * attester keys (the ADR-0020 path). Carries only the public, non-secret summary
 * (`kind` + `attester_id`) so search can surface "advertises a probe_results badge
 * from attester X" without implying it verified.
 */
export const PackIndexBadgeSummarySchema = z
  .object({
    kind: PackBadgeKindSchema.describe(
      "The advertised badge kind (probe_results / security_scan).",
    ),
    attester_id: z
      .string()
      .min(1)
      .describe(
        "The advertised attesting authority. Advisory only — verified locally, never here.",
      ),
  })
  .describe("An advisory advertisement of a pack's badge; never trusted from the index.")
export type PackIndexBadgeSummary = z.infer<typeof PackIndexBadgeSummarySchema>

/**
 * One pack listing in an index: the human-legible identity + taxonomy a consumer
 * searches over, plus the **immutable source descriptor** that resolves it. `source`
 * is a {@link PackSourceRefSchema} — the same pinned addressing descriptor `pack add`
 * consumes — so a discovered entry resolves directly through #86/#88 with no extra
 * indirection. A *published* (shared) index should advertise `npm` / `git` sources
 * (portable + immutable); a `local` source is valid for a private/local index. The
 * `version` mirrors the pack's manifest version for display and is cross-checked
 * against the resolved manifest at add time (the source ref is the binding, not this).
 */
export const PackIndexEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "pack name must be kebab-case (lowercase alphanumerics separated by single hyphens)",
      )
      .describe("The listed pack's manifest name."),
    version: z
      .string()
      .min(1)
      .describe("The advertised pack version (conventionally the latest), for display."),
    source: PackSourceRefSchema.describe(
      "The immutable, pinned source descriptor that resolves the pack (npm exact version + SRI, git full SHA, or local). Consumed unchanged by `pack add` — the index only advertises it.",
    ),
    author_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The pack's signing author id, when known (advisory; the consumer verifies on add).",
      ),
    description: z.string().min(1).optional().describe("Human-readable one-line summary."),
    coverage_areas: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Free-form tags naming the threat-model / subsystem areas the pack covers (searchable).",
      ),
    invariants: z
      .array(z.string().min(1))
      .default([])
      .describe("Free-form tags naming the Lodestar invariants the pack exercises (searchable)."),
    badges: z
      .array(PackIndexBadgeSummarySchema)
      .optional()
      .describe(
        "Advisory advertisement of the pack's badges. Never trusted from the index (ADR-0020).",
      ),
  })
  .describe("A pack listing: searchable identity + the immutable source that resolves it.")
export type PackIndexEntry = z.infer<typeof PackIndexEntrySchema>

/**
 * A `lodestar.pack-index.json` discovery index.
 *
 * A plain, signable JSON document listing packs. The signature covers the canonical
 * document (every field except `signature`), so `publisher_id`, `generated_at`, and
 * the whole `packs` array are bound — a consumer that pins the publisher key detects
 * any post-signing edit (the tamper defence) and any un-pinned signer (the forgery
 * defence). The three signing fields are additive-optional, like a manifest's: an
 * unsigned index parses and loads only under an explicit `allow_unsigned` opt-out.
 */
export const PackIndexSchema = z
  .object({
    index_version: z
      .literal(PACK_INDEX_SPEC_VERSION)
      .describe("Index-format spec version. A reader rejects a version it does not understand."),
    description: z
      .string()
      .min(1)
      .optional()
      .describe("Human-readable label for the index (who curates it, what it covers)."),
    packs: z
      .array(PackIndexEntrySchema)
      .default([])
      .describe("The pack listings this index advertises."),
    // ── Signing (ADR-0021). Additive-optional since spec "1": an unsigned index
    // still parses, and is loaded only under an explicit allow_unsigned opt-out.
    // publisher_id and generated_at are ordinary fields inside the signed document,
    // so a verifier reproduces the signed bytes from the rest of the index.
    publisher_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The index publisher's signer id. Present on a signed index; the verifier requires it equal signature.signer_id and be in the operator-pinned index_publisher_keys set.",
      ),
    generated_at: z
      .string()
      .datetime()
      .optional()
      .describe("When the index was generated (ISO 8601). Bound by the signature when present."),
    signature: SignatureSchema.optional().describe(
      "Ed25519 signature over the canonical index (every field except this one). Verified on load against operator-pinned index_publisher_keys. Absent on an unsigned (allow_unsigned) index.",
    ),
  })
  .describe("A static, signable discovery index listing packs and where to resolve them.")
export type PackIndex = z.infer<typeof PackIndexSchema>

/**
 * The filename a `local` index conventionally carries, and the export key an `npm`
 * index would expose it under. Defined as a constant so publishers and consumers
 * agree on the spelling, mirroring {@link PROBE_PACK_MANIFEST_FILENAME}.
 */
export const PACK_INDEX_FILENAME = "lodestar.pack-index.json" as const
