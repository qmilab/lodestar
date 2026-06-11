/**
 * The sensitivity gate graduated to `@qmilab/lodestar-core` (it derives from
 * core's `SensitivitySchema`, and the session shipper + any future egress path
 * apply the same ceiling). This module re-exports it so the exporter's own
 * imports and public surface are unchanged — the move is non-breaking.
 */
export {
  contentSensitivityForAction,
  isAboveCeiling,
  isSensitivity,
  SENSITIVITY_ORDER,
  sensitivityRank,
} from "@qmilab/lodestar-core"
