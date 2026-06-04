import { type Sensitivity, SensitivitySchema } from "@qmilab/lodestar-core"

/**
 * The content-sensitivity scale, lowest → highest, derived straight from
 * the canonical enum so it can never drift from the schema:
 *
 *   public < internal < confidential < secret
 *
 * Sensitivity is a *content* attribute (it describes what a claim/belief
 * says, not its lifecycle state). The OTel export gates on it: content
 * whose source sensitivity outranks the configured ceiling is withheld.
 */
export const SENSITIVITY_ORDER: readonly Sensitivity[] = SensitivitySchema.options

/**
 * Rank of a sensitivity level. Unknown values fail closed (treated as
 * maximally sensitive) so a future enum value can never leak by default.
 */
export function sensitivityRank(s: Sensitivity): number {
  const i = SENSITIVITY_ORDER.indexOf(s)
  return i === -1 ? SENSITIVITY_ORDER.length : i
}

/** True when `source` content is too sensitive to export under `ceiling`. */
export function isAboveCeiling(source: Sensitivity, ceiling: Sensitivity): boolean {
  return sensitivityRank(source) > sensitivityRank(ceiling)
}

/**
 * The Action contract's coarse `data_sensitivity` (public/private/secret)
 * mapped onto the content scale, so action inputs gate the same way as
 * belief/claim content. `private` maps to `confidential` — the
 * conservative reading.
 */
export function contentSensitivityForAction(
  dataSensitivity: "public" | "private" | "secret",
): Sensitivity {
  switch (dataSensitivity) {
    case "public":
      return "public"
    case "private":
      return "confidential"
    case "secret":
      return "secret"
  }
}
