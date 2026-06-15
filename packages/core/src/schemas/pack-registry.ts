import { z } from "zod"
import { PackSourceRefSchema } from "./probe-pack.js"

/**
 * Consumer-side registry formats — the two persisted JSON artifacts the
 * `lodestar pack add` consumer flow reads and writes (ADR-0019, #90). They are
 * pure wire formats (no I/O), so they live in core beside the manifest schema
 * (ADR-0016 §6); the readers/writers that touch the filesystem live in
 * `@qmilab/lodestar-harness`.
 *
 * Neither is a forgery boundary on its own. The trust config *names* which author
 * keys an operator pins, but the cryptographic check is the manifest signature
 * verified on load (ADR-0017); the lockfile *records* what was pinned and verified,
 * for reproducibility and audit, but a consumer re-verifies on every load rather
 * than trusting the lockfile's word.
 */

/**
 * One operator-pinned pack-author public key: the `author_id` a signed manifest
 * must declare and the SPKI PEM its `signature` must verify against. Mirrors the
 * proxy's `approvals.authorized_keys` entry shape (ADR-0010) so an operator who
 * already pins approver keys knows this format.
 */
export const PackAuthorKeySchema = z
  .object({
    actor_id: z
      .string()
      .min(1)
      .describe("The pack author's signer id; must equal the manifest's author_id."),
    public_key: z
      .string()
      .min(1)
      .describe("The author's Ed25519 public key in SPKI PEM form (the pinned trust anchor)."),
  })
  .describe("An operator-pinned pack-author key.")
export type PackAuthorKey = z.infer<typeof PackAuthorKeySchema>

/**
 * The consumer trust config (`.lodestar/pack-trust.json` by default). Where an
 * operator pins the author keys `lodestar pack add` verifies a pack against, with
 * the same fail-closed default as the proxy's approver config: an unsigned pack is
 * rejected unless `allow_unsigned` is set explicitly.
 */
export const PackTrustConfigSchema = z
  .object({
    author_keys: z
      .array(PackAuthorKeySchema)
      .default([])
      .describe("Operator-pinned author keys a pack's manifest signature is verified against."),
    allow_unsigned: z
      .boolean()
      .optional()
      .describe(
        "Explicit opt-out: accept an unsigned pack. No silent default — absent means a signed pack is required.",
      ),
  })
  .describe("Consumer-side pack trust config: pinned author keys + the unsigned opt-out.")
export type PackTrustConfig = z.infer<typeof PackTrustConfigSchema>

/**
 * The lockfile spec version. Bumped only when the entry shape changes in a way an
 * older reader cannot understand (same discipline as `PROBE_PACK_SPEC_VERSION`).
 */
export const PACK_LOCKFILE_VERSION = "1" as const

/**
 * One recorded pack pin: what `lodestar pack add` resolved, verified, and
 * installed. The `source` is the immutable {@link PackSourceRefSchema} descriptor
 * (exact npm version + integrity, or a full git commit SHA), and `manifest_hash`
 * is the canonical manifest hash that verified — together they make the install
 * reproducible and bind the lockfile entry to exactly the bytes that were trusted.
 */
export const PackLockEntrySchema = z
  .object({
    name: z.string().min(1).describe("The pack's manifest name."),
    version: z.string().min(1).describe("The pack's manifest version."),
    author_id: z
      .string()
      .min(1)
      .optional()
      .describe("The signing author id, when the pack was signed (absent for an unsigned pack)."),
    source: PackSourceRefSchema.describe("The immutable, pinned source descriptor that resolved."),
    manifest_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "manifest_hash must be 64 lowercase hex characters")
      .describe(
        "sha-256 hex of the canonical manifest that verified — the binding to trusted bytes.",
      ),
    added_at: z.string().datetime().describe("When this pin was recorded (ISO 8601)."),
  })
  .describe("A recorded, verified pack pin.")
export type PackLockEntry = z.infer<typeof PackLockEntrySchema>

/**
 * The pack lockfile (`.lodestar/packs.lock.json` by default): the set of pins a
 * consumer has added. Keyed by pack name on write (a re-add of the same name
 * replaces its entry), so the file lists at most one pin per pack.
 */
export const PackLockfileSchema = z
  .object({
    lockfile_version: z
      .literal(PACK_LOCKFILE_VERSION)
      .describe("Lockfile spec version. A reader rejects a version it does not understand."),
    packs: z.array(PackLockEntrySchema).default([]).describe("The recorded pack pins."),
  })
  .describe("The consumer's pack lockfile: recorded, verified pins.")
export type PackLockfile = z.infer<typeof PackLockfileSchema>
