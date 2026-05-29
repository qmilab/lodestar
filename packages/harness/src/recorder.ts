import { randomUUID } from "node:crypto"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import { buildProbeRunObservation } from "./observation.js"
import type { ProbeRunRecorder } from "./runner.js"

/**
 * Configuration for the event-log-backed recorder. The probe-run
 * observations are partitioned exactly like any other governed event:
 * by `project_id`, sliced by `session_id`, attributed to `actor_id`.
 * `lodestar report <session_id>` then surfaces the run.
 */
export interface EventLogRecorderConfig {
  /** Event-log root directory (the `.lodestar/events` convention). */
  root: string
  project_id: string
  session_id: string
  actor_id: string
}

/**
 * Build a {@link ProbeRunRecorder} that appends one synthetic
 * `observation.recorded` event per probe run to the NDJSON event log.
 *
 * The harness owns event-log I/O (per the package CLAUDE.md); the runner
 * core stays I/O-free and receives this recorder by injection. Each run
 * is written as a `trust: "synthetic"` Observation so it is auditable but
 * can never promote a real belief.
 */
export function eventLogRecorder(config: EventLogRecorderConfig): ProbeRunRecorder {
  const writer = new EventLogWriter(config.root)
  return async (outcome, pack) => {
    const observation = buildProbeRunObservation({
      pack,
      probe: outcome.name,
      file: outcome.file,
      passed: outcome.passed,
      exit_code: outcome.exit_code,
      signal: outcome.signal,
      duration_ms: outcome.duration_ms,
      started_at: outcome.started_at,
      context: {
        session_id: config.session_id,
        project_id: config.project_id,
        actor_id: config.actor_id,
      },
    })
    await writer.append({
      id: randomUUID(),
      type: "observation.recorded",
      schema_version: "0.1.0",
      project_id: config.project_id,
      session_id: config.session_id,
      actor_id: config.actor_id,
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload: observation,
      payload_hash: canonicalHash(observation),
      versions: { schema_registry_version: "0.1.0" },
    })
  }
}
