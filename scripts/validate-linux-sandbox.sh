#!/usr/bin/env bash
#
# Validate the probe-runner OS sandbox (#121, ADR-0023) under REAL bubblewrap.
#
# The Linux backend (`packages/harness/src/sandbox/linux.ts`) can only be
# exercised on Linux with bubblewrap; this harness makes that reproducible from
# any machine and runnable in CI. It asserts the load-bearing Linux guarantee:
# a sandboxed probe CANNOT read host files outside its read-root allowlist —
# including trees under `/opt` and `/usr/src` that the *narrowed* runtime binds
# must not expose (#121, the Codex P1) — while its own pack directory stays
# readable. It also runs the `runner-sandboxes-probe-filesystem-and-network`
# locking probe under real bwrap.
#
# Usage:
#   bash scripts/validate-linux-sandbox.sh
#       Any host with Docker (e.g. macOS dev): runs the checks inside an
#       `oven/bun` + bubblewrap container.
#   LODESTAR_SANDBOX_NATIVE=1 bash scripts/validate-linux-sandbox.sh
#       Linux host/CI with `bun` + `bwrap` already present: runs directly, no
#       Docker. (Auto-selected when uname is Linux and bwrap is on PATH.)
#
# Env: LODESTAR_SANDBOX_IMAGE overrides the container image (default oven/bun:debian).
#
# Exits non-zero on any containment failure, so it works as a CI gate.
set -uo pipefail

IMAGE="${LODESTAR_SANDBOX_IMAGE:-oven/bun:debian}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd)"

native_checks() {
  command -v bwrap >/dev/null 2>&1 || { echo "FAIL: bwrap not found"; exit 3; }
  command -v bun >/dev/null 2>&1 || { echo "FAIL: bun not found"; exit 3; }
  echo "host: $(uname -srm) | bun $(bun --version) | bwrap $(command -v bwrap)"

  # Workspace deps (present in CI / a dev checkout; installed in a fresh container).
  [ -d node_modules ] || bun install >/tmp/ls-install.log 2>&1 || {
    echo "FAIL: bun install"; tail -20 /tmp/ls-install.log; exit 4; }

  echo "mechanism: $(bun -e 'import("@qmilab/lodestar-harness").then(m=>process.stdout.write(String(m.detectSandboxMechanism())))')"

  # Plant "host secrets" OUTSIDE the read-root allowlist, under the broad prefixes
  # a too-coarse bind would expose (the round-8 P1 target). sudo only when needed.
  local sudo=""; [ "$(id -u)" -eq 0 ] || sudo="sudo"
  $sudo mkdir -p /opt/app /usr/src/app
  echo "OPT-APP-SECRET" | $sudo tee /opt/app/secret.txt >/dev/null
  echo "USR-SRC-SECRET" | $sudo tee /usr/src/app/secret.txt >/dev/null

  # The probe file must live INSIDE the repo so `bun run` resolves
  # @qmilab/lodestar-harness to the LOCAL workspace source (the code under test) —
  # a file under /tmp would resolve via bun's npm auto-install and silently test
  # the PUBLISHED package instead, which predates this feature.
  local adv; adv="$PWD/.ls-adv-$$.ts"
  cat > "$adv" <<'TS'
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadProbePack, runPack } from "@qmilab/lodestar-harness"
const dir = await mkdtemp(join(tmpdir(), "ls-adv-"))
await writeFile(
  join(dir, "lodestar.probe-pack.json"),
  JSON.stringify({ name: "adv", version: "0.0.0", spec_version: "1", source_type: "local", coverage_areas: ["t"], invariants: ["t"], probes: [{ name: "r", file: "r.ts" }] }),
)
await writeFile(
  join(dir, "r.ts"),
  `
import { readFileSync } from "node:fs"
const r = (p) => { try { readFileSync(p, "utf8"); return "READ" } catch (e) { return "DENIED:" + e.code } }
console.log("OPT=" + r("/opt/app/secret.txt"))
console.log("USRSRC=" + r("/usr/src/app/secret.txt"))
console.log("OWNPACK=" + (r(import.meta.path) === "READ" ? "READ" : "DENIED"))
process.exit(0)
`,
)
const pack = await loadProbePack(dir, { allowUnsigned: true })
const out = (await runPack(pack, { sandbox: {} })).outcomes[0]
console.log(out.stdout.trim())
if (out.stderr.trim()) console.log("[stderr] " + out.stderr.trim())
const ok =
  out.exit_code === 0 &&
  out.stdout.includes("OPT=DENIED") &&
  out.stdout.includes("USRSRC=DENIED") &&
  out.stdout.includes("OWNPACK=READ")
console.log(ok ? "ADVERSARIAL_PASS" : "ADVERSARIAL_FAIL")
process.exit(ok ? 0 : 1)
TS
  echo "--- adversarial fs-read under real bwrap (/opt + /usr/src must be DENIED; own pack READ) ---"
  bun run "$adv"; local rc=$?
  rm -f "$adv"
  $sudo rm -rf /opt/app /usr/src/app 2>/dev/null || true
  [ "$rc" -eq 0 ] || { echo "FAIL: read confinement breached"; exit 1; }

  echo "--- locking probe under real bwrap ---"
  bun run packs/lodestar-core/probes/runner-sandboxes-probe-filesystem-and-network.ts | tail -4
  echo "OK: Linux OS-sandbox validation passed"
}

if [ "${LODESTAR_SANDBOX_NATIVE:-}" = "1" ] || { [ "$(uname -s)" = "Linux" ] && command -v bwrap >/dev/null 2>&1; }; then
  cd "$REPO"
  native_checks
else
  command -v docker >/dev/null 2>&1 || {
    echo "Docker not found. On a Linux host with bwrap+bun, run:"
    echo "  LODESTAR_SANDBOX_NATIVE=1 bash scripts/validate-linux-sandbox.sh"
    exit 2
  }
  echo "Running Linux OS-sandbox validation in Docker ($IMAGE) — repo mounted read-only…"
  exec docker run --rm --privileged -v "$REPO:/host:ro" "$IMAGE" bash -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap git ca-certificates >/dev/null
    mkdir -p /work && tar -C /host --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -C /work -xf -
    cd /work && LODESTAR_SANDBOX_NATIVE=1 bash scripts/validate-linux-sandbox.sh'
fi
