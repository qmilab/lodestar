#!/usr/bin/env bun
/**
 * Probe: policy_version_signature_required
 *
 * `v02-delta.md` §5 lists policy versions among the artifacts that REQUIRE an
 * Ed25519 signature. The Policy Kernel enforces this at the gate: a policy
 * whose signature is missing or invalid (tampered / stale payload_hash, or a
 * failed cryptographic check) is rejected at `compile()`. Unsigned drafts are
 * usable only under an explicit, logged `allow_unsigned: true` opt-in.
 *
 * Assertions:
 * 1. An unsigned policy is rejected by `compile()` (no silent default).
 * 2. The same unsigned policy compiles under `allow_unsigned: true` (the
 *    documented development draft path).
 * 3. A policy signed over its canonical document compiles.
 * 4. Tampering with a rule AFTER signing invalidates the signature — the
 *    recomputed canonical hash no longer matches `payload_hash` → rejected.
 * 5. An injected `verifySignature` that returns false rejects an otherwise
 *    structurally-valid signed policy (the cryptographic hook has teeth).
 * 6. A signed policy survives JSON persistence: the canonical hash is
 *    invariant to an optional field present as `undefined` vs omitted (JSON
 *    drops undefined keys), so a round-tripped signed policy still verifies.
 *
 * Why this matters: a function cannot be signed; a document can. Policy
 * substitution is a real threat (`v02-delta.md` §5), and a wrong/forged
 * policy must not be silently honoured.
 */

import type { Policy, Signature } from "@qmilab/lodestar-core"
import { PolicyCompileError, canonicalPolicyHash, compile } from "@qmilab/lodestar-policy-kernel"

interface ProbeResult {
  passed: boolean
  details: string
}

const UNSIGNED: Policy = {
  id: "p",
  version: "1",
  rules: [{ match: { required_level_lte: 3 }, effect: "allow", reason: "auto up to L3" }],
}

function sign(policy: Policy, signer = "signer-1"): Policy {
  const signature: Signature = {
    signer_id: signer,
    payload_hash: canonicalPolicyHash(policy),
    algorithm: "ed25519",
    signature: "c2lnbmF0dXJlLWJ5dGVz", // base64 placeholder; crypto is the injected verifier's job
    at: "2026-06-04T00:00:00Z",
  }
  return { ...policy, signature, signed_by: signer }
}

function compiles(
  policy: Policy,
  opts: { allow_unsigned?: boolean; verifySignature?: (p: Policy) => boolean } = {},
): {
  ok: boolean
  err?: string
} {
  try {
    compile(policy, { decider_id: "d", ...opts })
    return { ok: true }
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) }
  }
}

async function run(): Promise<ProbeResult> {
  // 1. Unsigned, no opt-in → rejected.
  const c1 = compiles(UNSIGNED)
  if (c1.ok)
    return {
      passed: false,
      details: "[1] compile() accepted an unsigned policy with no allow_unsigned opt-in.",
    }
  if (!/unsigned|signed/i.test(c1.err ?? "")) {
    return {
      passed: false,
      details: `[1] rejected, but the error did not mention signing: ${c1.err}`,
    }
  }

  // 2. Unsigned + explicit opt-in → compiles.
  if (!compiles(UNSIGNED, { allow_unsigned: true }).ok) {
    return {
      passed: false,
      details: "[2] compile() rejected an unsigned policy even under allow_unsigned: true.",
    }
  }

  // 3. Correctly signed → compiles.
  const signed = sign(UNSIGNED)
  const c3 = compiles(signed)
  if (!c3.ok)
    return { passed: false, details: `[3] compile() rejected a correctly-signed policy: ${c3.err}` }

  // 4. Tamper after signing → payload_hash mismatch → rejected.
  const tampered: Policy = {
    ...signed,
    rules: [{ match: {}, effect: "allow", reason: "allow EVERYTHING (smuggled in after signing)" }],
  }
  const c4 = compiles(tampered)
  if (c4.ok)
    return {
      passed: false,
      details: "[4] compile() accepted a policy whose rules were changed after signing.",
    }
  if (!/payload_hash|tamper|canonical/i.test(c4.err ?? "")) {
    return {
      passed: false,
      details: `[4] tampered policy rejected, but not for a hash mismatch: ${c4.err}`,
    }
  }

  // 5. Injected verifier rejects → rejected.
  const c5 = compiles(signed, { verifySignature: () => false })
  if (c5.ok)
    return {
      passed: false,
      details: "[5] compile() accepted a policy whose injected verifySignature returned false.",
    }
  if (!/cryptographic|verification/i.test(c5.err ?? "")) {
    return {
      passed: false,
      details: `[5] verifier rejection used an unexpected message: ${c5.err}`,
    }
  }
  if (!(c1.err && /PolicyCompileError|unsigned/i.test(c1.err))) {
    // Sanity: rejections are PolicyCompileError, not a stray runtime error.
    return {
      passed: false,
      details: `[*] expected PolicyCompileError-class rejection; got: ${c1.err}`,
    }
  }
  // Belt-and-braces: the thrown type is PolicyCompileError.
  try {
    compile(UNSIGNED, { decider_id: "d" })
  } catch (err) {
    if (!(err instanceof PolicyCompileError)) {
      return {
        passed: false,
        details: `[*] unsigned rejection threw ${err instanceof Error ? err.name : typeof err}, not PolicyCompileError.`,
      }
    }
  }

  // 6. A signed policy survives JSON persistence — the canonical hash must be
  //    invariant to an optional field present as `undefined` vs omitted, since
  //    JSON.stringify drops undefined keys. A rule built with an explicit
  //    `approval: undefined` (e.g. a config merge) is signed, then round-
  //    tripped through JSON (which drops the key); reload must still verify.
  const withUndef = {
    id: "p",
    version: "2",
    rules: [
      { match: { required_level_lte: 3 }, effect: "allow", reason: "auto", approval: undefined },
    ],
  } as unknown as Policy
  const signedUndef = sign(withUndef)
  const persisted = JSON.parse(JSON.stringify(signedUndef)) as Policy
  if ("approval" in (persisted.rules[0] ?? {})) {
    return {
      passed: false,
      details: "[6] test setup: JSON.stringify did not drop the undefined `approval` key.",
    }
  }
  const c6 = compiles(persisted)
  if (!c6.ok) {
    return {
      passed: false,
      details: `[6] a signed policy was rejected after a JSON round-trip that dropped an explicit-undefined optional field: ${c6.err}. The canonical hash must skip undefined keys.`,
    }
  }

  return {
    passed: true,
    details:
      "Unsigned policy rejected (allow_unsigned opt-in aside); a canonically-signed policy compiled and survived a JSON round-trip (undefined keys hashed like omitted); post-signing tampering and an injected verifier rejection were both caught as PolicyCompileError.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: policy_version_signature_required")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
