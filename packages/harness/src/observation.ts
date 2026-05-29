import { type Observation, PROBE_PACK_SPEC_VERSION, registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * Observation schema for a single probe run.
 *
 * The runner records every probe invocation as an Observation so probe
 * runs are themselves auditable through `lodestar report`. The
 * observation is always emitted with `trust: "synthetic"` (the
 * observation-trust analogue of the `synthetic_probe` evidence quality):
 * a probe run is genuine evidence that the harness ran, but it must
 * never feed real beliefs. The auto-observation gate and the firewall's
 * no-self-promotion rule both key off this trust level.
 */
export const PROBE_RUN_OBSERVATION_SCHEMA_KEY = "harness.probe_run@1" as const

export const ProbeRunObservationPayloadSchema = z.object({
  pack: z.string().min(1).describe("The probe pack the run belongs to."),
  probe: z.string().min(1).describe("The probe's stable name within the pack."),
  file: z
    .string()
    .min(1)
    .describe("The probe source file, relative to the pack root, as declared in the manifest."),
  passed: z.boolean().describe("Whether the probe exited 0 (pass) or non-zero / signalled (fail)."),
  exit_code: z
    .number()
    .int()
    .nullable()
    .describe("Process exit code, or null when the probe was terminated by a signal."),
  signal: z
    .string()
    .nullable()
    .describe("Terminating signal (e.g. 'SIGKILL'), or null when the probe exited normally."),
  duration_ms: z.number().nonnegative().describe("Wall-clock duration of the probe subprocess."),
  spec_version: z
    .literal(PROBE_PACK_SPEC_VERSION)
    .describe("Probe-pack spec version the run was driven under."),
})
export type ProbeRunObservationPayload = z.infer<typeof ProbeRunObservationPayloadSchema>

// Register on import, following the adapter precedent (the git adapter
// registers `git.status@1` the same way). Guarded so importing the
// harness twice in one process — or alongside a probe that registers the
// same key — does not throw on the registry's no-replace rule.
const alreadyRegistered = registry.lookup(PROBE_RUN_OBSERVATION_SCHEMA_KEY)
if (!alreadyRegistered) {
  registry.register(PROBE_RUN_OBSERVATION_SCHEMA_KEY, ProbeRunObservationPayloadSchema)
} else if (alreadyRegistered !== ProbeRunObservationPayloadSchema) {
  // Re-importing this module is a no-op (same schema object). But a
  // *different* schema under our key means someone squatted it — fail
  // loudly rather than silently validating probe-run payloads against a
  // foreign schema.
  throw new Error(
    `schema registry: key '${PROBE_RUN_OBSERVATION_SCHEMA_KEY}' is already registered with a different schema`,
  )
}

/** Everything needed to mint a probe-run Observation, minus the boilerplate. */
export interface ProbeRunObservationInput {
  pack: string
  probe: string
  file: string
  passed: boolean
  exit_code: number | null
  signal: string | null
  duration_ms: number
  started_at: string
  context: { session_id: string; project_id: string; actor_id: string }
}

/**
 * Build the synthetic Observation the runner records for a probe run.
 * Emitted as the payload of an `observation.recorded` event so it lands
 * in the same projection `lodestar report` already understands.
 */
export function buildProbeRunObservation(input: ProbeRunObservationInput): Observation {
  const payload: ProbeRunObservationPayload = {
    pack: input.pack,
    probe: input.probe,
    file: input.file,
    passed: input.passed,
    exit_code: input.exit_code,
    signal: input.signal,
    duration_ms: input.duration_ms,
    spec_version: PROBE_PACK_SPEC_VERSION,
  }
  return {
    id: crypto.randomUUID(),
    schema: PROBE_RUN_OBSERVATION_SCHEMA_KEY,
    payload,
    source: {
      tool: "lodestar-harness",
      invocation_id: crypto.randomUUID(),
      captured_at: input.started_at,
    },
    context: input.context,
    // A probe run never promotes a real belief; mark it synthetic so the
    // firewall and the auto-observation gate treat it as probe-derived.
    trust: "synthetic",
    sensitivity: "internal",
  }
}
