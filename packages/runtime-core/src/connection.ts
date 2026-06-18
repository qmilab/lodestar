import type { Readable, Writable } from "node:stream"

/**
 * The transport seam between the gate server and a runtime hook.
 *
 * The gate logic in `gate.ts` is transport-agnostic: it consumes inbound
 * messages and emits outbound ones through an {@link RpcChannel}. Two
 * implementations:
 *
 *   - {@link stdioChannel} — newline-delimited JSON over a process's
 *     stdin/stdout, the wire the `lodestar runtime gate` CLI uses (the native
 *     hook spawns the gate as a child process).
 *   - {@link createLoopbackPair} — an in-process pair of cross-wired channels,
 *     so the `runtime-gate-enforces-two-phase` probe can drive the REAL gate
 *     over the REAL protocol with an in-TS stand-in for the hook, no subprocess
 *     needed.
 *
 * Messages cross the channel as already-JSON values (the stdio implementation
 * does the framing). `send` is fire-and-forget; ordering is preserved.
 */
export interface RpcChannel {
  /** Send one message. On the wire it becomes one newline-framed JSON line. */
  send(msg: unknown): void
  /** Register the single handler invoked for each inbound message. */
  onMessage(handler: (msg: unknown) => void): void
  /** Register a handler invoked once when the channel closes. */
  onClose(handler: () => void): void
  /** Close the channel (and signal the peer where the transport supports it). */
  close(): void
}

/**
 * A channel over a Readable (inbound) + Writable (outbound), framed as
 * newline-delimited JSON. The gate's CLI wires `process.stdin` / `process.stdout`
 * here. A malformed inbound line is dropped (the gate stays up); the gate logs
 * diagnostics to stderr, never to the protocol stream.
 */
export function stdioChannel(input: Readable, output: Writable): RpcChannel {
  let onMsg: ((msg: unknown) => void) | undefined
  let onClose: (() => void) | undefined
  let buffer = ""
  let closed = false

  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    buffer += chunk
    let idx: number
    // biome-ignore lint/suspicious/noAssignInExpressions: standard line-split loop
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A torn / non-JSON line: drop it. The protocol is one object per line;
        // diagnostics go to stderr so they never corrupt the wire.
        process.stderr.write("[runtime-gate] dropping non-JSON line\n")
        continue
      }
      onMsg?.(parsed)
    }
  })
  const fireClose = (): void => {
    if (closed) return
    closed = true
    onClose?.()
  }
  input.on("end", fireClose)
  input.on("close", fireClose)

  return {
    send(msg: unknown): void {
      if (closed) return
      output.write(`${JSON.stringify(msg)}\n`)
    },
    onMessage(handler): void {
      onMsg = handler
    },
    onClose(handler): void {
      onClose = handler
    },
    close(): void {
      fireClose()
    },
  }
}

/**
 * Two cross-wired in-process channels: anything `a.send`s arrives at `b`'s
 * message handler and vice versa. Delivery is deferred to a microtask so the
 * caller's stack unwinds first — this faithfully models the async, interleaved
 * delivery of a real transport (and is what lets the concurrency-correlation
 * probe exercise overlapping in-flight calls). Ordering per direction is
 * preserved.
 *
 * Returns `{ gate, hook }`: hand `gate` to {@link RuntimeGate.serve} and drive
 * the other end through `hook`.
 */
export function createLoopbackPair(): { gate: RpcChannel; hook: RpcChannel } {
  const a = makeEndpoint()
  const b = makeEndpoint()
  a.peer = b
  b.peer = a
  return { gate: a.channel, hook: b.channel }
}

interface Endpoint {
  channel: RpcChannel
  peer?: Endpoint
  deliver(msg: unknown): void
  fireClose(): void
}

function makeEndpoint(): Endpoint {
  let onMsg: ((msg: unknown) => void) | undefined
  let onClose: (() => void) | undefined
  let closed = false
  const self: Endpoint = {
    deliver(msg: unknown): void {
      // Round-trip through JSON so the in-process path matches the wire path
      // exactly (no shared object references leaking across the seam).
      const copy: unknown = JSON.parse(JSON.stringify(msg))
      queueMicrotask(() => onMsg?.(copy))
    },
    fireClose(): void {
      if (closed) return
      closed = true
      queueMicrotask(() => onClose?.())
    },
    channel: {
      send(msg: unknown): void {
        if (closed) return
        self.peer?.deliver(msg)
      },
      onMessage(handler): void {
        onMsg = handler
      },
      onClose(handler): void {
        onClose = handler
      },
      close(): void {
        if (closed) return
        self.peer?.fireClose()
        self.fireClose()
      },
    },
  }
  return self
}
