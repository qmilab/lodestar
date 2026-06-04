import { startViewer } from "@qmilab/lodestar-viewer"

/**
 * `lodestar view [session-id] [--log-root <path>] [--port <n>] [--host <h>] [--open]`
 *
 * Start the read-side Governing UI — a local, strictly read-only web
 * viewer over the event log. It is the live, interactive sibling of
 * `lodestar report`: it renders the epistemic chain in the browser, with
 * drill-down, a live tail, and a read-only view of pending approvals.
 *
 * Binds to loopback by default. The log can carry `secret`-sensitivity
 * beliefs, so localhost is the trust boundary — exactly as for
 * `lodestar report`. Never expose this without an auth layer in front;
 * authenticated, multi-user exposure (and resolving approvals) is the
 * separate write-side surface.
 */
export async function viewCommand(argv: string[]): Promise<number> {
  let session_id: string | undefined
  let log_root: string | undefined
  let host = "127.0.0.1"
  let port: number | undefined
  let open = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE)
      return 0
    }
    if (arg === "--log-root" || arg === "-l") {
      const next = argv[++i]
      if (next) log_root = next
    } else if (arg === "--port") {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
        process.stderr.write(`invalid --port: ${next ?? "(missing)"}\n`)
        return 2
      }
      port = parsed
    } else if (arg === "--host") {
      const next = argv[++i]
      if (next) host = next
    } else if (arg === "--open") {
      open = true
    } else if (arg && !arg.startsWith("-") && !session_id) {
      session_id = arg
    }
  }

  let handle: Awaited<ReturnType<typeof startViewer>>
  try {
    handle = await startViewer({
      ...(log_root !== undefined ? { logRoot: log_root } : {}),
      host,
      ...(port !== undefined ? { port } : {}),
    })
  } catch (err) {
    process.stderr.write(
      `failed to start viewer: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const target = session_id ? `${handle.url}/#s=${encodeURIComponent(session_id)}` : handle.url

  const banner = [
    "",
    "  Lodestar Governing UI — read-only",
    `  ${target}`,
    `  log root: ${handle.logRoot}`,
    "",
    "  Read-only: this viewer never writes the event log.",
    "  Press Ctrl-C to stop.",
    "",
    "",
  ].join("\n")
  process.stdout.write(banner)

  if (handle.host === "0.0.0.0" || handle.host === "::") {
    process.stderr.write(
      "  warning: bound to a non-loopback interface. The event log can contain\n" +
        "  secret-sensitivity beliefs and this viewer has no auth — do not expose it.\n\n",
    )
  }

  if (open) openBrowser(target)

  await waitForShutdown()
  await handle.stop()
  return 0
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url]
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
  } catch {
    // best-effort; the URL is already printed
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done)
      process.off("SIGTERM", done)
      resolve()
    }
    process.on("SIGINT", done)
    process.on("SIGTERM", done)
  })
}

const USAGE = `usage: lodestar view [session-id] [--log-root <path>] [--port <n>] [--host <h>] [--open]

Start the read-side Governing UI: a local, read-only web viewer over the
event log. Renders the live epistemic chain and trust report in the browser.

  session-id      open this session on load (optional)
  --log-root, -l  event-log root (default: <cwd>/.lodestar/events)
  --port          port to bind (default: 4319; 0 for an ephemeral port)
  --host          interface to bind (default: 127.0.0.1)
  --open          open the URL in the default browser
  --help, -h      show this help
`
