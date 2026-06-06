export { makeGitStatusTool, registerGitStatusTool, GitStatusOutputSchema } from "./status.js"

// Native git transport tools (forge-agnostic): commit / push / clone. See ADR-0006.
export {
  makeGitCommitTool,
  makeGitPushTool,
  makeGitCloneTool,
  defineGitTransportTools,
  registerGitTransportTools,
  GitCommitOutputSchema,
  GitPushOutputSchema,
  GitCloneOutputSchema,
  type GitCommitOutput,
  type GitPushOutput,
  type GitCloneOutput,
  type GitCommitToolOptions,
  type GitPushToolOptions,
  type GitCloneToolOptions,
  type GitTransportConfig,
} from "./transport.js"
export { type Credential, type PreparedCredential, prepareCredential } from "./credentials.js"
export {
  runGit,
  baseGitEnv,
  redactUrl,
  applyRedactions,
  type GitRunResult,
  type GitRunOptions,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./run.js"
