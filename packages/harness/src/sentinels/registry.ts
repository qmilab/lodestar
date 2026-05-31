import type { Sentinel } from "../sentinel.js"
import { AnomalousToolSequenceSentinel } from "./anomalous-tool-sequence.js"
import { LowConfidenceActionSentinel } from "./low-confidence-action.js"
import { SuspiciousMemoryOriginSentinel } from "./suspicious-memory-origin.js"

/**
 * Constructs a fresh sentinel instance with its default options. A
 * factory rather than a shared instance because sentinels are *stateful*
 * (per-session accumulators): each {@link SentinelRunner} needs its own
 * instances, and a pack may be loaded more than once in a process.
 */
export type SentinelFactory = () => Sentinel

/**
 * Registry of first-party sentinels, keyed by the stable id a pack
 * manifest references. A pack declares the sentinel ids it ships (the
 * `sentinels` array in `lodestar.probe-pack.json`); the loader resolves
 * each id to its factory here and fails loudly on an unknown id.
 *
 * Why id-against-a-registry rather than file-against-the-pack (the way
 * probes are carried): a sentinel is a stateful in-process class the
 * `SentinelRunner` instantiates, not a `bun run`-able script driven by an
 * exit code. There is no subprocess contract for it (harness invariant 6
 * is about the *probe* runner), so the pack *declares* which built-in
 * sentinels it ships rather than carrying their source. Per-pack
 * construction-option overrides (the confidence floor, the suspicious-
 * sequence catalogue) and third-party (file-referenced) sentinels are a
 * deliberate later refinement; v0 resolves first-party ids with default
 * options. See `docs/architecture/sentinels.md`.
 *
 * Each key MUST equal the constructed sentinel's `name`, so the manifest
 * id, the registry key, and the `sentinel_name` on every emitted alert are
 * the same string. `registry.test.ts` enforces this.
 */
export const FIRST_PARTY_SENTINELS: Readonly<Record<string, SentinelFactory>> = Object.freeze({
  "low-confidence-action": () => new LowConfidenceActionSentinel(),
  "suspicious-memory-origin": () => new SuspiciousMemoryOriginSentinel(),
  "anomalous-tool-sequence": () => new AnomalousToolSequenceSentinel(),
})
