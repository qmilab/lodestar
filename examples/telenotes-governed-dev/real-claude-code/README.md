# real-claude-code

Wires **real Claude Code** to the Telenotes MCP proxy, so an unmodified coding
agent does the feature work and Lodestar records the epistemic chain — the
live counterpart to `../scripted-run/`.

- `RECIPE.md` — the step-by-step walkthrough. **Read this first.** It covers
  the one load-bearing detail: denying Claude Code's built-in Edit/Write/Bash
  so the agent's only path to the workspace is the governed MCP tools.
- `proxy.config.json` — the `ProxyConfig` for `lodestar guard mcp-proxy --config`
  (two downstream servers, the same `tool_defaults` the scripted run uses).
  Paths are placeholders; fill them in per the recipe.
- `.mcp.json` — the MCP server entry Claude Code reads to spawn the proxy.
- `settings.example.json` — the Claude Code permission config that forces
  MCP-only tool use.
- `captured/` — committed evidence from a real run (rendered report +
  transcript). See `captured/README.md`.

Unlike the scripted run, this path is non-deterministic and needs a live,
billed Claude Code session — it is a human-driven step, not part of CI.
