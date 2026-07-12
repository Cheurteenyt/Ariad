# Codebase Memory V2

> **Package:** `codebase-memory-v2`
> **Status:** pre-release (not yet published to npm)
> **License:** MIT — see [LICENSE](../LICENSE)

Hybrid code intelligence: native WASM indexer (112 languages via tree-sitter),
human memory graph (SQLite), Obsidian sync, and a web-based graph UI.

## Installation

```bash
# From source (development)
cd codebase-mirror/v2
npm ci
npm run build

# From npm (when published)
npm install -g codebase-memory-v2
```

## Quick start

```bash
# Index a project (native WASM indexer — no V1 needed for TS/JS)
cbm-v2 index --project my-app --root /path/to/repo

# Start the graph UI
cbm-v2 ui --project my-app

# Start MCP server
cbm-v2 mcp
```

## MCP integration

The MCP server exposes 7 tools for code graph queries, human memory CRUD,
and Obsidian sync. See [docs/MCP_TOOLS.md](../docs/MCP_TOOLS.md) for the
full reference.

## Graph UI

The web UI is built from `graph-ui/` and embedded in the package at
`dist/ui/`. It is resolved at runtime via `import.meta.url`, so it works
from any working directory after installation.

## Node compatibility

- **Runtime:** Node >= 20.0.0
- **CI tested:** Node 20
- **Native dependencies:** `better-sqlite3` (requires build tools or
  prebuild-install)

## Links

- [Root README](../README.md) — full product overview
- [Architecture](../docs/V2_ARCHITECTURE.md) — system architecture
- [CLI Reference](../docs/CLI_REFERENCE.md) — all CLI commands
- [Current State](../docs/V2_CURRENT_STATE.md) — features + limitations
- [Changelog](CHANGELOG.md) — version history
- [Contributing](../CONTRIBUTING.md) — development workflow

## Pre-release notice

This package is not yet published to npm. The first public release will
be a pre-release (`v0.8.0-alpha.1`) after atomic generation publication
(R169) and project lease/fencing (R170) are complete. See
[Release Policy](../docs/RELEASE_POLICY.md) for details.
