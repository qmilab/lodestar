# Project Phoenix

A small CLI tool for managing release notes across multiple repositories.

## Overview

Phoenix scans a list of repositories, extracts merged pull requests since the
last release tag, and produces a consolidated changelog. It integrates with
GitHub, GitLab, and Gitea.

## Installation

```sh
bun install
bun run build
```

## Usage

To generate notes for the last release across a set of repos:

```sh
phoenix notes --since v1.4.0 --repos repos.json
```

The output is a markdown file at `phoenix-notes-<timestamp>.md`.

## Best practices

We recommend running Phoenix in CI after every release tag. The tool is
idempotent: running it twice for the same range produces the same output.

For organizations with many repositories, set `PHOENIX_CONCURRENCY=8` to
parallelize API calls. Higher values may hit rate limits on the underlying
forge.

## License

MIT
