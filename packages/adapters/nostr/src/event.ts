import { schnorr } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { bech32 } from "@scure/base"

/**
 * NIP-01 event primitives — serialize, id, sign, verify — plus the NIP-19
 * bech32 entity encodings (`npub` / `nsec` / `note`) the adapter needs.
 *
 * Crypto is BIP-340 Schnorr over secp256k1 (NIP-01), via the audited
 * `@noble/curves` / `@noble/hashes` primitives. We hand-roll the thin
 * serialize/id layer (it is a few lines and exact-by-spec) rather than pulling a
 * higher-level client, so the adapter keeps full control of what crosses the
 * trust boundary — mirroring the git adapter hand-rolling its scoped runner.
 *
 * BIP-340 note: `schnorr.sign(message, sk)` signs the message bytes directly (it
 * is BIP-340's `m`, hashed only inside the challenge `H(R‖P‖m)`); there is no
 * separate prehash step (the `prehash` option in @noble belongs to ECDSA
 * `secp256k1.sign`, not schnorr). A Nostr signature is over the event *id* — a
 * 32-byte SHA-256 digest — so we pass that id as `m` exactly as nostr-tools does.
 */

/** An event before it is hashed + signed (NIP-01 fields, no `id`/`sig`). */
export interface UnsignedEvent {
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

/** A complete, signed NIP-01 event ready for the wire. */
export interface NostrEvent extends UnsignedEvent {
  id: string
  sig: string
}

/**
 * NIP-01 canonical serialization: the UTF-8 JSON of
 * `[0, pubkey, created_at, kind, tags, content]` with no extra whitespace.
 * `JSON.stringify` produces exactly the escaping NIP-01 mandates (\n \" \\ \r
 * \t \b \f escaped; everything else, including emoji, literal), so two
 * implementations derive the same id for the same event.
 */
export function serializeEvent(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
}

/** The event id: lowercase hex of SHA-256 over the canonical serialization. */
export function computeEventId(e: UnsignedEvent): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(e))))
}

/** Derive the 32-byte x-only public key (hex) for a secret key. */
export function getPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey))
}

/** A note draft the agent supplies; the adapter fills pubkey + created_at. */
export interface EventDraft {
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

/**
 * Build the canonical event for `secretKey` + `draft`, compute its id, and sign
 * it with BIP-340 Schnorr. The signature carries BIP-340's required auxiliary
 * randomness, so it is non-deterministic by design — verification (and the id,
 * which is a pure hash of the content) stay deterministic.
 */
export function signEvent(secretKey: Uint8Array, draft: EventDraft): NostrEvent {
  const unsigned: UnsignedEvent = {
    pubkey: getPublicKeyHex(secretKey),
    created_at: draft.created_at,
    kind: draft.kind,
    tags: draft.tags,
    content: draft.content,
  }
  const id = computeEventId(unsigned)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { ...unsigned, id, sig }
}

/**
 * Verify an event end-to-end: the id must match the recomputed canonical hash,
 * AND the signature must verify against the claimed pubkey. Returns false on any
 * malformed field rather than throwing — fetched events are untrusted input.
 */
export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (computeEventId(e) !== e.id) return false
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// NIP-19 bech32 entities
// -----------------------------------------------------------------------------

// bech32 defaults to a 90-char limit; Nostr entities (esp. with TLV) exceed it,
// so use the ecosystem-standard generous bound (matches nostr-tools).
const BECH32_LIMIT = 5000

/** Encode a 32-byte hex value as a bech32 entity with the given prefix. */
export function encodeBech32(prefix: string, valueHex: string): string {
  return bech32.encode(prefix, bech32.toWords(hexToBytes(valueHex)), BECH32_LIMIT)
}

/** Decode a bech32 entity to `{ prefix, hex }`. Throws on a bad checksum. */
export function decodeBech32(entity: string): { prefix: string; hex: string } {
  const { prefix, words } = bech32.decode(entity as `${string}1${string}`, BECH32_LIMIT)
  return { prefix, hex: bytesToHex(bech32.fromWords(words)) }
}

/** `note1…` encoding of an event id (UX-facing; never a secret). */
export function noteIdFromHex(eventIdHex: string): string {
  return encodeBech32("note", eventIdHex)
}

/** `npub1…` encoding of an x-only public key (public; never a secret). */
export function npubFromHex(pubkeyHex: string): string {
  return encodeBech32("npub", pubkeyHex)
}
