import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Credential model for the egress-capable git tools (`git.push`, `git.clone`).
 *
 * Security-relevant settings have NO silent default (CLAUDE.md rule): the
 * operator MUST choose a credential kind explicitly. Everything here is
 * operator-supplied — the agent never sees or chooses a credential.
 *
 * The token never reaches argv. For `https-token` it flows to git through a
 * generated `GIT_ASKPASS` helper that reads the secret from the *scoped
 * subprocess env*, so it does not appear in `ps`, and it is redacted out of any
 * captured output before it can reach an observation or log.
 *
 * Forward direction (recorded in ADR-0006): the Action Kernel already models
 * opaque secret handles (`ToolContext.capabilities`, "tools never see raw secret
 * values"). Once kernel capability *resolution* is implemented, the resolver
 * seam below (`token` may be a function) is the bridge: a production host passes
 * `() => secretStore.fetch(...)` so the token is fetched at push time, not
 * persisted in config.
 */
export type Credential =
  | { kind: "none" }
  | {
      kind: "https-token"
      /** A PAT / OAuth token. A function is resolved per push (fetch at use time). */
      token: string | (() => string | Promise<string>)
      /** HTTP username. Most forges accept any non-empty value with a PAT. */
      username?: string
    }
  | {
      kind: "ssh-key"
      /** Path to the private key. Passed to ssh via `-i`, never read by this code. */
      keyPath: string
      /** Optional pinned known_hosts; without it, host-key checking still applies. */
      knownHostsPath?: string
    }

/**
 * A credential prepared for use. `baseEnv` holds the non-secret env additions
 * known up front (the askpass path, the ssh command); `resolve()` produces the
 * per-execute secret env plus the strings to redact from captured output.
 */
export interface PreparedCredential {
  baseEnv: Record<string, string>
  resolve(): Promise<{ env: Record<string, string>; redactions: string[] }>
}

const ASKPASS_SCRIPT = `#!/bin/sh
# Lodestar git askpass. git invokes this with the prompt text as $1; we echo the
# credential from the scoped env so the token never appears in argv (ps-safe).
case "$1" in
  Username*) printf '%s' "\${LODESTAR_GIT_USERNAME}" ;;
  *) printf '%s' "\${LODESTAR_GIT_PASSWORD}" ;;
esac
`

const EMPTY = { env: {}, redactions: [] as string[] }

/**
 * Prepare a credential for the adapter. `askpassDir` is a directory the adapter
 * controls (the scoped temp HOME) where the askpass helper is written once.
 */
export function prepareCredential(cred: Credential, askpassDir: string): PreparedCredential {
  switch (cred.kind) {
    case "none":
      // baseGitEnv already sets GIT_TERMINAL_PROMPT=0, so a missing credential
      // fails fast rather than blocking on a prompt.
      return { baseEnv: {}, resolve: async () => EMPTY }

    case "https-token": {
      const askpassPath = join(askpassDir, "lodestar-git-askpass.sh")
      writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 })
      chmodSync(askpassPath, 0o700)
      const username = cred.username ?? "x-access-token"
      return {
        baseEnv: { GIT_ASKPASS: askpassPath },
        resolve: async () => {
          const token = typeof cred.token === "function" ? await cred.token() : cred.token
          return {
            env: { LODESTAR_GIT_USERNAME: username, LODESTAR_GIT_PASSWORD: token },
            redactions: token.length > 0 ? [token] : [],
          }
        },
      }
    }

    case "ssh-key": {
      // StrictHostKeyChecking stays on (honest default); IdentitiesOnly stops ssh
      // from trying ambient agent keys. Paths are quoted for the shell git uses to
      // parse GIT_SSH_COMMAND.
      const parts = [
        "ssh",
        "-i",
        `"${cred.keyPath}"`,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
      ]
      if (cred.knownHostsPath !== undefined) {
        parts.push("-o", `UserKnownHostsFile="${cred.knownHostsPath}"`)
      }
      return { baseEnv: { GIT_SSH_COMMAND: parts.join(" ") }, resolve: async () => EMPTY }
    }
  }
}
