import { SENSITIVITY_ORDER, type Sensitivity } from "@qmilab/lodestar-core"
import { SessionNotFoundError, shipSession } from "@qmilab/lodestar-ship"
import { defaultLogRoot } from "@qmilab/lodestar-trace"

/**
 * Substrings that mark a header name as carrying a credential — RFC auth/cookie
 * plus the common API-key / token families (`X-API-Key`, `X-Auth-Token`,
 * `Private-Token`, AWS `…-Security-Token`, etc.). A credential value must never
 * be read from argv (shell history, process listings expose it): `--header`
 * refuses these names and points the operator at the env-backed paths
 * (`--token-env` for a bearer token, `--secret-header NAME=ENV` for anything
 * else). Deliberately substring-based and a bit broad — the safe fallback always
 * exists, so over-matching costs nothing while under-matching leaks.
 */
const CREDENTIAL_HEADER_HINTS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "api-key",
  "apikey",
  "api_key",
]

function looksLikeCredentialHeader(name: string): boolean {
  const n = name.toLowerCase()
  return CREDENTIAL_HEADER_HINTS.some((hint) => n.includes(hint))
}

/**
 * `lodestar ship <session-id> [--project <id>] [--log-root <path>]
 *    [--endpoint <url>] [--header k=v ...] [--token-env <NAME>]
 *    [--sensitivity-ceiling <level>] [--out <file>] [--stdout]`
 *
 * Transfer a session's raw event-log envelopes to a remote collector as the
 * `lodestar.session_ship@1` NDJSON wire format. With `--endpoint`, POST to a
 * collector; with `--out`, write the NDJSON to a file; with neither (or
 * `--stdout`), print it — a dry run that needs no collector.
 *
 * Content above `--sensitivity-ceiling` (default `internal`) is withheld
 * client-side before egress: the record ships redacted (structure + the
 * original payload hash only). The bearer token is read from `--token-env`
 * (default `LODESTAR_SHIP_TOKEN`), never argv, and never logged.
 */
export async function shipCommand(argv: string[]): Promise<number> {
  let session_id: string | undefined
  let project_id: string | undefined
  let log_root = defaultLogRoot()
  let endpoint: string | undefined
  let out: string | undefined
  let to_stdout = false
  let ceiling = "internal"
  let token_env = "LODESTAR_SHIP_TOKEN"
  let token_env_explicit = false
  const headers: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE)
      return 0
    }
    if (arg === "--project" || arg === "-p") {
      project_id = argv[++i]
    } else if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg === "--endpoint" || arg === "-e") {
      endpoint = argv[++i]
    } else if (arg === "--out" || arg === "-o") {
      out = argv[++i]
    } else if (arg === "--stdout") {
      to_stdout = true
    } else if (arg === "--sensitivity-ceiling" || arg === "-s") {
      const next = argv[++i]
      if (next) ceiling = next
    } else if (arg === "--token-env") {
      const next = argv[++i]
      if (next) {
        token_env = next
        token_env_explicit = true
      }
    } else if (arg === "--header" || arg === "-H") {
      const next = argv[++i]
      const eq = next ? next.indexOf("=") : -1
      if (!next || eq <= 0) {
        process.stderr.write(`invalid --header (expected k=v): ${next ?? "(missing)"}\n`)
        return 2
      }
      const name = next.slice(0, eq).trim()
      // A credential must not come from argv (shell history / process listings).
      // Refuse credential-looking names and point at the env-backed channels.
      if (looksLikeCredentialHeader(name)) {
        process.stderr.write(
          `refusing --header ${name}: it looks like a credential. Use --secret-header ${name}=ENV_VAR (or --token-env for a bearer token) so the value stays out of argv\n`,
        )
        return 2
      }
      headers[name] = next.slice(eq + 1)
    } else if (arg === "--secret-header") {
      // The env-backed channel for ANY custom credential header: the VALUE is
      // read from the named env var, never argv.
      const next = argv[++i]
      const eq = next ? next.indexOf("=") : -1
      if (!next || eq <= 0) {
        process.stderr.write(
          `invalid --secret-header (expected NAME=ENV_VAR): ${next ?? "(missing)"}\n`,
        )
        return 2
      }
      const hname = next.slice(0, eq).trim()
      const envName = next.slice(eq + 1).trim()
      const value = envName ? process.env[envName] : undefined
      if (value) {
        headers[hname] = value
      } else {
        process.stderr.write(
          `warning: --secret-header ${hname}: env var ${envName || "(missing)"} is empty/unset; header not sent\n`,
        )
      }
    } else if (arg && !arg.startsWith("-") && !session_id) {
      session_id = arg
    }
  }

  if (!session_id) {
    process.stderr.write(USAGE)
    return 2
  }

  if (!(SENSITIVITY_ORDER as readonly string[]).includes(ceiling)) {
    process.stderr.write(
      `invalid --sensitivity-ceiling: ${ceiling} (expected one of ${SENSITIVITY_ORDER.join(", ")})\n`,
    )
    return 2
  }

  // The three delivery targets are mutually exclusive: POST to --endpoint,
  // write --out, or print to stdout (the default).
  if (to_stdout && (endpoint || out)) {
    process.stderr.write("--stdout cannot be combined with --endpoint or --out\n")
    return 2
  }
  if (endpoint && out) {
    process.stderr.write("--endpoint and --out are mutually exclusive\n")
    return 2
  }

  // Resolve the bearer token from the named env var (never argv) and add it as
  // an Authorization header. If --token-env was given explicitly but the
  // variable is empty/unset, warn — the operator expected to authenticate.
  const token = process.env[token_env]
  if (token) {
    headers.authorization = `Bearer ${token}`
  } else if (token_env_explicit) {
    process.stderr.write(
      `warning: --token-env ${token_env} is empty/unset; sending no Authorization header\n`,
    )
  }

  try {
    const summary = await shipSession({
      sessionId: session_id,
      ...(project_id !== undefined ? { projectId: project_id } : {}),
      logRoot: log_root,
      sensitivityCeiling: ceiling as Sensitivity,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(out !== undefined ? { out } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    })

    const tail =
      summary.delivered === "endpoint"
        ? ` → ${endpoint}/v1/events`
        : summary.delivered === "file"
          ? ` → ${out}`
          : ""
    process.stderr.write(
      `shipped ${summary.event_count} events (${summary.redacted_count} redacted, ` +
        `${summary.byte_count} bytes, ceiling ${summary.ceiling}) — ` +
        `session ${summary.session_id}${tail}\n`,
    )

    if (summary.delivered === "none") {
      process.stdout.write(summary.ndjson)
    }
    return 0
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      process.stderr.write(`no events found for session '${session_id}' under '${log_root}'\n`)
      return 3
    }
    process.stderr.write(`ship failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

const USAGE = `usage: lodestar ship <session-id> [options]

Transfer a session's raw event-log envelopes to a remote collector as the
lodestar.session_ship@1 NDJSON wire format. Move a whole governed session to a
shared collector, a remote viewer, or an archive — losslessly, with every
payload hash intact.

  <session-id>              the session to ship
  --project, -p <id>        project id (skips the project scan when known)
  --log-root, -l <path>     event-log root (default: <cwd>/.lodestar/events)
  --endpoint, -e <url>      collector base URL; the NDJSON body is POSTed to
                            {url}/v1/events as application/x-ndjson
  --token-env <NAME>        env var holding the bearer token (default
                            LODESTAR_SHIP_TOKEN); sent as Authorization: Bearer,
                            never read from argv and never logged
  --header, -H k=v          extra NON-secret HTTP header for the POST (repeatable);
                            credential-looking names (authorization, cookie, *token*,
                            *api-key*, *secret*, …) are refused here — argv leaks
  --secret-header N=ENV      add header N with its value read from env var ENV (never
                            argv); the env-backed channel for custom credential headers
  --sensitivity-ceiling, -s <level>
                            withhold content above this level
                            (public|internal|confidential|secret; default internal)
  --out, -o <file>          write the NDJSON to a file instead of POSTing
  --stdout                  print the NDJSON to stdout (the default when neither
                            --endpoint nor --out is given)
  --help, -h                show this help

With neither --endpoint nor --out, the NDJSON is printed to stdout — a dry run
that needs no collector. Content above the sensitivity ceiling never leaves the
machine: the record ships redacted (structure + the original payload hash only).
`
