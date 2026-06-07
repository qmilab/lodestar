/**
 * @qmilab/lodestar-adapter-http — governed HTTP transport tools for the Lodestar
 * Action Kernel. P2 slice 4 (ADR-0008).
 *
 * - `http.fetch` (L1) — read a URL; the body is UNTRUSTED external content.
 * - `http.request` (L4) — egress: send a request body to a pinned host, held
 *   until approved.
 *
 * Governance: operator host pinning + scheme allowlist (SSRF guard), per-hop
 * redirect re-validation, host-bound credentials (resolver seam, redacted),
 * bounded capture. A TS-level governance boundary, not network containment.
 */
export {
  makeHttpFetchTool,
  makeHttpRequestTool,
  defineHttpTools,
  registerHttpTools,
  HttpResponseOutputSchema,
  type HttpResponseOutput,
  type HttpFetchToolOptions,
  type HttpRequestToolOptions,
  type HttpToolsConfig,
  type MutatingMethod,
} from "./tools.js"
export {
  type HttpCredential,
  type PreparedCredentials,
  type ResolvedHeader,
  prepareCredentials,
  applyRedactions,
} from "./credentials.js"
export {
  type UrlPolicy,
  compileUrlPolicy,
  assertAllowedUrl,
  normalizeHost,
} from "./url.js"
export {
  type HttpResponseCapture,
  type PerformRequestOptions,
  performRequest,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
} from "./client.js"
