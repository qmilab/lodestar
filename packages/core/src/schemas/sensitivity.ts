import type { DataSensitivityForAction } from "./action.js"
import { type Sensitivity, SensitivitySchema } from "./common.js"

/**
 * The content-sensitivity scale, lowest → highest, derived straight from
 * the canonical enum so it can never drift from the schema:
 *
 *   public < internal < confidential < secret
 *
 * Sensitivity is a *content* attribute (it describes what a claim/belief
 * says, not its lifecycle state). Export and egress paths gate on it:
 * content whose source sensitivity outranks a configured ceiling is
 * withheld. The gate and these ordering helpers live here in core so every
 * surface that applies the locked v0.2 sensitivity ceiling — the OTel
 * exporter, the session shipper, any future egress path — shares one
 * implementation instead of re-deriving it.
 */
export const SENSITIVITY_ORDER: readonly Sensitivity[] = SensitivitySchema.options

/**
 * Runtime type guard for a sensitivity level. TypeScript types do not
 * survive into a JS caller or an env/config-derived value, so a ceiling
 * read from config must be validated at runtime before it is used as a
 * gate (see {@link sensitivityRank} for why the ceiling specifically must
 * be a known value).
 */
export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITY_ORDER as readonly string[]).includes(value)
}

/**
 * Rank of a sensitivity level.
 *
 * Unknown values rank *above* every real level (maximally sensitive).
 * That is fail-closed for a content **source** — an unrecognised source is
 * withheld, so a future enum value can never leak by default. It is the
 * WRONG behaviour for the **ceiling**, where ranking an unknown value at
 * the top would make nothing exceed it and silently export everything;
 * the ceiling must therefore be validated with {@link isSensitivity}
 * before it reaches the gate.
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
 * belief/claim content.
 *
 * This is the canonical cross-alphabet mapping: `public → public`,
 * `private → internal`, `secret → secret`. In particular `private` maps to
 * `internal` (NOT `confidential`) so that ordinary private tool calls — the
 * common Guard/MCP filesystem case — keep their intent and inputs visible at
 * the default `internal` ceiling; only `secret` actions are withheld by
 * default. The action-kernel's `sensitivityForContract` is the same mapping
 * by construction (it predates this graduation and stays for its callers).
 */
export function contentSensitivityForAction(
  dataSensitivity: DataSensitivityForAction,
): Sensitivity {
  switch (dataSensitivity) {
    case "public":
      return "public"
    case "private":
      return "internal"
    case "secret":
      return "secret"
  }
}
