/**
 * @qmilab/lodestar-harness
 *
 * The Lodestar Harness: probe packs, sentinels, and calibrators that
 * exercise and audit the epistemic chain. This is the developer entry
 * point that turns the probe scripts (now the first-party pack
 * `packs/lodestar-core/`) into an installable, packageable surface
 * external authors can plug into.
 *
 * Batch 4 step 3 ships the probe-pack format: the loader here reads and
 * validates a `lodestar.probe-pack.json` manifest (schema in
 * `@qmilab/lodestar-core`) and resolves its probe files. The Probe base
 * class, runner, and `lodestar harness run` CLI follow in step 5.
 */

export {
  loadProbePack,
  ProbePackError,
  type LoadedProbe,
  type LoadedProbePack,
} from "./pack/loader.js"
