import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PACK_BADGES_DIRNAME,
  PROBE_PACK_SPEC_VERSION,
  type ProbePackManifest,
  generateEd25519KeyPair,
} from "@qmilab/lodestar-core"
import {
  buildProbeResultsBadge,
  buildSecurityScanBadge,
  readPackBadges,
  verifyPackBadges,
  writePackBadge,
} from "./badges.js"
import type { PackRunResult } from "./runner.js"

const AT = "2026-01-01T00:00:00.000Z"
const ATTESTER = "acme-attester"

// A signed, content-bound manifest — the state a pack is in after loadProbePack has
// verified it. Badges are trusted only over a *signed* pack: only then has the loader
// authenticated content_digest against disk (ADR-0020). verifyPackBadges checks the
// signature's presence (not its bytes — that is loadProbePack's job already done), so
// the dummy values below stand in for "this pack loaded as signed + verified".
function manifest(): ProbePackManifest {
  return {
    name: "demo-pack",
    version: "1.0.0",
    spec_version: PROBE_PACK_SPEC_VERSION,
    source_type: "local",
    coverage_areas: ["x"],
    invariants: ["y"],
    probes: [{ name: "p", file: "probes/p.ts" }],
    author_id: "author",
    content_digest: {
      algorithm: "sha256",
      files: [{ path: "probes/p.ts", sha256: "a".repeat(64) }],
    },
    signature: {
      signer_id: "author",
      payload_hash: "x",
      algorithm: "ed25519",
      signature: "y",
      at: AT,
    },
  }
}

function runResult(): PackRunResult {
  return {
    pack: "demo-pack",
    ok: true,
    total: 2,
    passed: 2,
    failed: 0,
    duration_ms: 5,
    outcomes: [
      {
        name: "p",
        file: "probes/p.ts",
        passed: true,
        exit_code: 0,
        signal: null,
        duration_ms: 2,
        started_at: AT,
        stdout: "",
        stderr: "",
      },
      {
        name: "q",
        file: "probes/q.ts",
        passed: true,
        exit_code: 0,
        signal: null,
        duration_ms: 3,
        started_at: AT,
        stdout: "",
        stderr: "",
      },
    ],
  }
}

describe("buildProbeResultsBadge", () => {
  test("summarises the run, binds the manifest hash, signs as the attester", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const badge = buildProbeResultsBadge(manifest(), runResult(), {
      attesterId: ATTESTER,
      privateKeyPem,
      at: AT,
      harnessVersion: "0.3.0",
    })
    expect(badge.kind).toBe("probe_results")
    expect(badge.attester_id).toBe(ATTESTER)
    expect(badge.signature.signer_id).toBe(ATTESTER)
    expect(badge.subject.pack).toBe("demo-pack")
    expect(badge.subject.manifest_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(badge.result).toMatchObject({ ok: true, total: 2, passed: 2, failed: 0 })
    expect(badge.result.probes).toEqual(["p", "q"])
  })

  test("refuses an unsigned manifest, even one carrying a content_digest", () => {
    // Codex review (PR #118): a content_digest is only authenticated when the pack is
    // signed (the loader validates it against disk only then). So presence of the
    // field is not enough — issuing a badge requires a signed pack.
    const { privateKeyPem } = generateEd25519KeyPair()
    const { signature: _drop, ...unsigned } = manifest() // keeps content_digest
    expect(() =>
      buildProbeResultsBadge(unsigned, runResult(), {
        attesterId: ATTESTER,
        privateKeyPem,
        at: AT,
        harnessVersion: "0.3.0",
      }),
    ).toThrow(/not signed/)
  })
})

describe("write + read + verify round trip", () => {
  test("a badge from a pinned attester verifies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
      const m = manifest()
      const badge = buildProbeResultsBadge(m, runResult(), {
        attesterId: ATTESTER,
        privateKeyPem,
        at: AT,
        harnessVersion: "0.3.0",
      })
      const written = await writePackBadge(dir, badge)
      expect(written).toContain(`${PACK_BADGES_DIRNAME}/${ATTESTER}.probe_results.badge.json`)

      const raw = await readPackBadges(dir)
      expect(raw).toHaveLength(1)
      expect(raw[0]?.badge?.kind).toBe("probe_results")

      const verifications = await verifyPackBadges(
        { manifest: m, root: dir },
        { authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: publicKeyPem }] },
      )
      expect(verifications).toHaveLength(1)
      expect(verifications[0]?.status).toBe("verified")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an un-pinned attester is surfaced as unverified, never trusted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      const { privateKeyPem } = generateEd25519KeyPair()
      const m = manifest()
      await writePackBadge(
        dir,
        buildProbeResultsBadge(m, runResult(), {
          attesterId: ATTESTER,
          privateKeyPem,
          at: AT,
          harnessVersion: "0.3.0",
        }),
      )
      // No attester pinned at all → the signed badge is surfaced but not trusted.
      const verifications = await verifyPackBadges({ manifest: m, root: dir })
      expect(verifications[0]?.status).toBe("unverified")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a badge over a different manifest is not_applicable (mis-attach)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
      const m = manifest()
      // Issue a valid badge over m…
      await writePackBadge(
        dir,
        buildProbeResultsBadge(m, runResult(), {
          attesterId: ATTESTER,
          privateKeyPem,
          at: AT,
          harnessVersion: "0.3.0",
        }),
      )
      // …but verify against a pack whose manifest differs (bumped version) → the
      // recomputed manifest hash no longer matches the badge subject.
      const moved = { ...m, version: "2.0.0" }
      const verifications = await verifyPackBadges(
        { manifest: moved, root: dir },
        { authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: publicKeyPem }] },
      )
      expect(verifications[0]?.status).toBe("not_applicable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a malformed badge file is surfaced as malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      await mkdir(join(dir, PACK_BADGES_DIRNAME), { recursive: true })
      await writeFile(join(dir, PACK_BADGES_DIRNAME, "junk.badge.json"), "{not json", "utf8")
      const verifications = await verifyPackBadges({ manifest: manifest(), root: dir })
      expect(verifications).toHaveLength(1)
      expect(verifications[0]?.status).toBe("malformed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a missing badges/ directory yields no verifications", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      expect(await verifyPackBadges({ manifest: manifest(), root: dir })).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no badge is trusted over an unsigned pack, even with a hand-written content_digest", async () => {
    // Consumer-side closure for Codex finding #1 (round 3): a content_digest the
    // loader never validated (an --allow-unsigned pack) must not make a badge
    // trustworthy. Even a validly-signed, applicable badge is downgraded to
    // unverified when the pack it verifies against is unsigned.
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
      const m = manifest()
      await writePackBadge(
        dir,
        buildProbeResultsBadge(m, runResult(), {
          attesterId: ATTESTER,
          privateKeyPem,
          at: AT,
          harnessVersion: "0.3.0",
        }),
      )
      // Verify against the same pack but UNSIGNED — signature stripped, content_digest
      // kept. The manifest_hash still matches (it excludes the signature), but the
      // pack's bytes were never authenticated, so the badge must not be trusted.
      const { signature: _drop, ...unsigned } = m
      const verifications = await verifyPackBadges(
        { manifest: unsigned, root: dir },
        { authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: publicKeyPem }] },
      )
      expect(verifications[0]?.status).toBe("unverified")
      expect(verifications[0]?.reason).toContain("not authenticated")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a non-directory `badges` path is surfaced as malformed, never thrown (advisory)", async () => {
    // Codex review (PR #118): a pack can ship `badges` as a regular file (or an
    // EACCES dir / malformed archive entry); readdir throws ENOTDIR/EACCES, not
    // ENOENT. That must NOT gate an otherwise-verified pack — it is advisory.
    const dir = await mkdtemp(join(tmpdir(), "lodestar-badges-"))
    try {
      await writeFile(join(dir, PACK_BADGES_DIRNAME), "i am a file, not a directory", "utf8")
      const verifications = await verifyPackBadges({ manifest: manifest(), root: dir })
      expect(verifications).toHaveLength(1)
      expect(verifications[0]?.status).toBe("malformed")
      expect(verifications[0]?.reason).toContain("not readable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("buildSecurityScanBadge", () => {
  test("signs a provided scan verdict", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const badge = buildSecurityScanBadge(
      manifest(),
      { status: "clean", findings_count: 0, scanner: "demo-scanner" },
      { attesterId: ATTESTER, privateKeyPem, at: AT },
    )
    expect(badge.kind).toBe("security_scan")
    expect(badge.result.status).toBe("clean")
    expect(badge.signature.signer_id).toBe(ATTESTER)
  })
})
