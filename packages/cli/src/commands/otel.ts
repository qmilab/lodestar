import {
  SENSITIVITY_ORDER,
  SessionNotFoundError,
  exportSession,
} from "@qmilab/lodestar-otel-exporter"
import { defaultLogRoot } from "@qmilab/lodestar-trace"

/**
 * `lodestar otel export <session-id> [--project <id>] [--log-root <path>]
 *    [--endpoint <url>] [--header k=v ...] [--sensitivity-ceiling <level>]
 *    [--out <file>] [--stdout]`
 *
 * Project a session's event log into OpenTelemetry GenAI spans and emit
 * them as OTLP/HTTP JSON. With `--endpoint`, POST to a collector / Langfuse
 * / Phoenix; with `--out`, write the JSON to a file; with neither (or
 * `--stdout`), print it to stdout — a dry run that needs no collector.
 *
 * Content above `--sensitivity-ceiling` (default `internal`) is withheld:
 * the span/event ships with structural metadata + the payload hash only.
 */
export async function otelCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(USAGE)
    return sub === undefined ? 2 : 0
  }
  if (sub !== "export") {
    process.stderr.write(`unknown otel subcommand: ${sub}\n${USAGE}`)
    return 2
  }
  return exportCommand(rest)
}

async function exportCommand(argv: string[]): Promise<number> {
  let session_id: string | undefined
  let project_id: string | undefined
  let log_root = defaultLogRoot()
  let endpoint: string | undefined
  let out: string | undefined
  let to_stdout = false
  let ceiling = "internal"
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
    } else if (arg === "--header" || arg === "-H") {
      const next = argv[++i]
      const eq = next ? next.indexOf("=") : -1
      if (!next || eq <= 0) {
        process.stderr.write(`invalid --header (expected k=v): ${next ?? "(missing)"}\n`)
        return 2
      }
      headers[next.slice(0, eq).trim()] = next.slice(eq + 1)
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

  try {
    const summary = await exportSession({
      sessionId: session_id,
      ...(project_id !== undefined ? { projectId: project_id } : {}),
      logRoot: log_root,
      sensitivityCeiling: ceiling as (typeof SENSITIVITY_ORDER)[number],
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(out !== undefined ? { out } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    })

    const tail =
      summary.delivered === "endpoint"
        ? ` → ${endpoint}`
        : summary.delivered === "file"
          ? ` → ${out}`
          : ""
    process.stderr.write(
      `exported ${summary.span_count} spans (${summary.event_count} events, ` +
        `${summary.redacted_count} redacted) — trace ${summary.trace_id}${tail}\n`,
    )

    if (summary.delivered === "none") {
      process.stdout.write(`${JSON.stringify(summary.otlp, null, 2)}\n`)
    }
    return 0
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      process.stderr.write(`no events found for session '${session_id}' under '${log_root}'\n`)
      return 3
    }
    process.stderr.write(
      `otel export failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}

const USAGE = `usage: lodestar otel export <session-id> [options]

Project a session's event log into OpenTelemetry GenAI spans and emit them as
OTLP/HTTP JSON. Pair the epistemic chain with Langfuse, Phoenix, Jaeger, or Tempo.

  <session-id>              the session to export
  --project, -p <id>        project id (skips the project scan when known)
  --log-root, -l <path>     event-log root (default: <cwd>/.lodestar/events)
  --endpoint, -e <url>      OTLP/HTTP base URL (e.g. http://localhost:4318);
                            /v1/traces is appended and the trace is POSTed
  --header, -H k=v          extra HTTP header for the POST (repeatable)
  --sensitivity-ceiling, -s <level>
                            withhold content above this level
                            (public|internal|confidential|secret; default internal)
  --out, -o <file>          write the OTLP JSON to a file instead of POSTing
  --stdout                  print the OTLP JSON to stdout (the default when
                            neither --endpoint nor --out is given)
  --help, -h                show this help

With neither --endpoint nor --out, the OTLP JSON is printed to stdout — a dry run
that needs no collector. Content above the sensitivity ceiling is never exported:
the span/event ships with structural metadata and the payload hash only.
`
