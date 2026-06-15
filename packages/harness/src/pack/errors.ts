/**
 * Raised for every failure mode of pack loading and source resolution: a missing
 * or malformed manifest, a schema-invalid manifest, an unsupported source type, a
 * probe file that escapes the pack root, a missing probe file, a duplicate probe
 * name, a sentinel that is unknown or declared twice, a signature/content-digest
 * verification failure, or a fetch/extract/clone failure during source resolution.
 *
 * A single typed error lets callers (the CLI, a runner) distinguish "this pack is
 * broken or could not be resolved" from an unexpected crash. It lives in its own
 * module so the loader and the source resolvers can share it without an import
 * cycle (the loader imports the resolvers, which raise this error).
 */
export class ProbePackError extends Error {
  override readonly name = "ProbePackError"
}
