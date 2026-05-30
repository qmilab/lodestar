import { randomUUID } from "node:crypto"
import { SENTINEL_ALERTED_EVENT_TYPE, SENTINEL_ALERTED_SCHEMA_VERSION } from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import type { SentinelAlert, SentinelAlertSink } from "./sentinel.js"

/**
 * Configuration for the event-log-backed sentinel sink.
 *
 * Unlike the probe-run recorder, the partition (`project_id`) and session
 * (`session_id`) are NOT taken from config — they ride on each
 * {@link SentinelAlert}, lifted from the event that triggered it, so an
 * alert lands in the same session slice as the events it flags. The only
 * thing config supplies is the actor the alert is attributed to.
 */
export interface EventLogAlertSinkConfig {
  /** Event-log root directory (the `.lodestar/events` convention). */
  root: string
  /**
   * `actor_id` for emitted alert envelopes. Defaults to the harness
   * sentinel identity — an alert is neither a human nor an agent action.
   */
  actor_id?: string
}

const DEFAULT_SENTINEL_ACTOR = "lodestar-sentinel"

/**
 * Build a {@link SentinelAlertSink} that appends one `sentinel.alerted@1`
 * event per alert to the NDJSON event log.
 *
 * Mirrors `eventLogRecorder` for probe runs: the harness owns event-log I/O
 * (per the package CLAUDE.md), so the runner core stays I/O-free and
 * receives this sink by injection. The alert's `observed_event_ids` become
 * the envelope's `causal_parent_ids`, so `lodestar report` can walk from an
 * alert back to the events that triggered it.
 */
export function eventLogAlertSink(config: EventLogAlertSinkConfig): SentinelAlertSink {
  const writer = new EventLogWriter(config.root)
  const actorId = config.actor_id ?? DEFAULT_SENTINEL_ACTOR
  return async (alert: SentinelAlert) => {
    await writer.append({
      id: randomUUID(),
      type: SENTINEL_ALERTED_EVENT_TYPE,
      schema_version: SENTINEL_ALERTED_SCHEMA_VERSION,
      project_id: alert.project_id,
      session_id: alert.session_id,
      actor_id: actorId,
      timestamp: alert.payload.detected_at,
      causal_parent_ids: alert.causal_parent_ids,
      payload: alert.payload,
      payload_hash: canonicalHash(alert.payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }
}
