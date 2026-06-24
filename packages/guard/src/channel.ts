/**
 * `@qmilab/lodestar-guard/approval-channel` — the writer-free channel subpath.
 *
 * A re-export-only barrel (no logic of its own) that exposes the approval
 * **transport** seam and the signed-resolution wire reader WITHOUT evaluating the
 * package's `.` barrel. Importing the package root (`@qmilab/lodestar-guard`)
 * evaluates `index.ts`, which re-exports `wrap()` / `runGuarded()` and therefore
 * drags the full write-side runtime (action-kernel, memory-firewall,
 * cognitive-core, harness). A consumer that only moves approval bytes and
 * signature-verifies them *after* transport — an external integrator, a relay or
 * read-side consumer, an integration test exercising the real client — has no
 * business linking that runtime (ADR-0015: an `ApprovalChannel` is UNTRUSTED).
 *
 * Because this module imports only `./approval-channel.js` and
 * `./approvals-channel.js`, its transitive RUNTIME graph is a subset of
 * `{ @qmilab/lodestar-core, zod, node:* }` — the lone action-kernel edge in the
 * graph is a type-only `import type { ApprovalOutcome }`, erased from `dist`.
 * `src/channel.test.ts` asserts that subset holds, so the writer-free property is
 * enforced, not just intended. See ADR-0030.
 *
 * This is the writer-free *alternative* import path, not a move: the `.` barrel
 * still re-exports the same channel symbols for source compatibility.
 */

// The approval transport seam (ADR-0015): ApprovalChannel, ApprovalRef,
// ApprovalChannelConfig{Schema}, SecretValue, FileApprovalChannel,
// HttpApprovalChannel, assertChannelEndpoint, createApprovalChannel,
// httpChannelForbidsUnsigned.
export * from "./approval-channel.js"

// The signed `.approvals/` wire reader (ADR-0010 / ADR-0024 / ADR-0025):
// ApprovalResolution{Schema}, read/write/deleteApprovalResolution,
// approvalResolutionPath, approvalsChannelDir, resolutionToOutcome.
export * from "./approvals-channel.js"
