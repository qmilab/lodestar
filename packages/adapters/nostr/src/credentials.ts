import { hexToBytes } from "@noble/hashes/utils.js"
import { decodeBech32, getPublicKeyHex } from "./event.js"

/**
 * Credential model for the egress-capable Nostr tools. On Nostr the **signing
 * key is the credential**: whoever holds the secret key can publish as that
 * identity. So this mirrors the git adapter's credential rules exactly —
 *
 *   - **No silent default** (CLAUDE.md rule): the operator MUST supply the key
 *     explicitly; the agent never sees, picks, or supplies it.
 *   - **Never in argv / never in output.** Signing happens *in-process* (BIP-340
 *     Schnorr), so the secret never crosses a process boundary or the wire — only
 *     the derived public key and the signature do. As defence in depth the
 *     resolved secret (in every form it was supplied) is redacted from any
 *     captured output before it can reach an observation or log.
 *   - **Resolver seam.** `key` may be a `() => Promise<string>` so a production
 *     host fetches it from a secret store at publish time rather than persisting
 *     it in config. This is the bridge to the Action Kernel's capability handles
 *     (`ToolContext.capabilities`, `kind: "sign"`) once kernel capability
 *     resolution lands — the same forward direction ADR-0006 recorded for git.
 *
 * The union has a single variant today (`secret-key`) but is shaped to grow:
 * a NIP-46 remote signer ("bunker") or a NIP-49 `ncryptsec` passphrase are the
 * natural future kinds, and neither would hand the raw key to the agent.
 */
export type NostrCredential = {
  kind: "secret-key"
  /**
   * The secret key as 64-char lowercase hex OR a NIP-19 `nsec1…` string. A
   * function is resolved per publish (fetch at use time). Either form is
   * accepted; whichever is supplied is redacted from output.
   */
  key: string | (() => string | Promise<string>)
}

/** A credential resolved for one publish: the key bytes, the derived public
 * key, and the strings to redact from captured output. */
export interface ResolvedSigner {
  secretKey: Uint8Array
  /** x-only public key (hex) — public, safe to surface. */
  pubkey: string
  /** Literal secret strings to strip from any captured output. */
  redactions: string[]
}

export interface PreparedSigner {
  /** Resolve the secret afresh (honours a resolver function each call). */
  resolve(): Promise<ResolvedSigner>
}

const HEX64 = /^[0-9a-f]{64}$/

/** Normalize a supplied key (hex or `nsec1…`) to 32 secret-key bytes, plus the
 * set of literal strings that must never surface (every form we saw). */
function toSecretKey(raw: string): { secretKey: Uint8Array; redactions: string[] } {
  const value = raw.trim()
  const redactions = new Set<string>([raw, value])
  let hex: string
  if (value.startsWith("nsec1")) {
    const decoded = decodeBech32(value)
    if (decoded.prefix !== "nsec") {
      throw new Error(`nostr credential: expected an 'nsec' bech32 key, got '${decoded.prefix}'`)
    }
    hex = decoded.hex
    redactions.add(hex)
  } else {
    hex = value.toLowerCase()
    if (!HEX64.test(hex)) {
      throw new Error(
        "nostr credential: secret key must be 64-char hex or a NIP-19 'nsec1…' string",
      )
    }
    redactions.add(hex)
  }
  const secretKey = hexToBytes(hex)
  if (secretKey.length !== 32) {
    throw new Error("nostr credential: secret key must decode to 32 bytes")
  }
  return { secretKey, redactions: [...redactions].filter((s) => s.length > 0) }
}

/** Prepare a credential for the adapter. The secret is read (and any resolver
 * invoked) only inside `resolve()`, never retained on the returned object. */
export function prepareSigner(cred: NostrCredential): PreparedSigner {
  return {
    resolve: async () => {
      const raw = typeof cred.key === "function" ? await cred.key() : cred.key
      const { secretKey, redactions } = toSecretKey(raw)
      return { secretKey, pubkey: getPublicKeyHex(secretKey), redactions }
    },
  }
}
