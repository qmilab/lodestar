// `toWireProjection` + `WireProjection` graduated to @qmilab/lodestar-trace
// (issue #139) — a pure `Set → array` serialization in the same family as
// `projectChain`, the serializer the stable `projectChain` contract points at,
// so a consumer that only wants to JSON-serialize a projection need not depend
// on the viewer's HTTP server. Re-exported here unchanged for source
// compatibility (the server still imports it from here).
export { toWireProjection } from "@qmilab/lodestar-trace"
export type { WireProjection } from "@qmilab/lodestar-trace"
