# CLI Reference — Codebase Memory V2

All commands are available via `cbm-v2` (or `node dist/cli/index.js` before global install).

## Core Commands

### `cbm-v2 init`
Initialize `.codebase-memory.json` configuration file.

```bash
cbm-v2 init --project my-app
cbm-v2 init --project my-app --vault /custom/vault/path
```

### `cbm-v2 doctor`
Run diagnostics to verify the setup.

```bash
cbm-v2 doctor --project my-app
```

Checks: Node.js version, config file, human DB, code graph DB, vault path writability.

### `cbm-v2 stats`
Show a pretty statistics dashboard.

```bash
cbm-v2 stats --project my-app
cbm-v2 stats --project my-app --json
```

### `cbm-v2 demo`
Create a demo project with sample notes and generate a vault. No V1 codebase needed.

```bash
cbm-v2 demo                    # creates temp files, cleans up after
cbm-v2 demo --keep             # keeps the files
cbm-v2 demo --vault ./my-vault # uses a specific vault path
```

### `cbm-v2 mcp`
Run as MCP server (JSON-RPC 2.0 over stdio). For AI agent integration.

```bash
cbm-v2 mcp --project my-app
```

## Human Memory Commands

### `cbm-v2 human create`
Create a human memory note.

```bash
cbm-v2 human create \
  --project my-app \
  --type ADR \
  --title "ADR-001: Use JWT" \
  --body "We chose JWT because..." \
  --tag security --tag auth \
  --link-cbm 1234 --link-edge DECIDES \
  --status active
```

### `cbm-v2 human list`
List notes with optional filters.

```bash
cbm-v2 human list --project my-app
cbm-v2 human list --project my-app --type ADR --status active --limit 50
```

### `cbm-v2 human show`
Show a single note (JSON output).

```bash
cbm-v2 human show 42 --project my-app
```

### `cbm-v2 human link`
Link a note to a code node.

```bash
cbm-v2 human link 42 --project my-app --to-cbm-node 1234 --edge DECIDES
```

## Obsidian Commands

### `cbm-v2 obsidian init`
Create vault directory structure.

```bash
cbm-v2 obsidian init --project my-app --vault .codebase-memory-vault
```

### `cbm-v2 obsidian sync`
Bidirectional sync (DB ↔ vault). The main sync command.

```bash
cbm-v2 obsidian sync --project my-app
cbm-v2 obsidian sync --project my-app --dry-run
cbm-v2 obsidian sync --project my-app --direction export
cbm-v2 obsidian sync --project my-app --direction import
cbm-v2 obsidian sync --project my-app --no-backup --no-auto-modules
cbm-v2 obsidian sync --project my-app --min-degree 30
```

### `cbm-v2 obsidian export` / `import`
One-shot export (DB → vault) or import (vault → DB).

```bash
cbm-v2 obsidian export --project my-app
cbm-v2 obsidian import --project my-app --dry-run
```

### `cbm-v2 obsidian report`
Print a vault file report.

```bash
cbm-v2 obsidian report --project my-app --format json
```

### `cbm-v2 obsidian create-adr`
Create an ADR note + DB record.

```bash
cbm-v2 obsidian create-adr --project my-app --title "ADR-003: Use Redis" --module auth --status draft
```

### `cbm-v2 obsidian create-module-note`
Create a ModuleNote for a specific module.

```bash
cbm-v2 obsidian create-module-note --project my-app --module auth
```

### `cbm-v2 obsidian create-route-note`
Create a RouteNote for a specific HTTP route.

```bash
cbm-v2 obsidian create-route-note --project my-app --method POST --path /api/login
```

## Report Commands

### `cbm-v2 report hotspots`
List critical modules (high degree + complexity).

```bash
cbm-v2 report hotspots --project my-app --min-degree 30 --limit 100 --format json
```

### `cbm-v2 report undocumented`
List critical code nodes without human notes.

```bash
cbm-v2 report undocumented --project my-app
```

### `cbm-v2 report risk`
Risk report: high coupling, dead code, fragile interfaces, central functions.

```bash
cbm-v2 report risk --project my-app --limit 200 --format json
```

## Backup Commands

### `cbm-v2 backup export`
Export all human notes + edges to a portable JSON file.

```bash
cbm-v2 backup export --project my-app --output backup.json
```

### `cbm-v2 backup import`
Import from a JSON backup file.

```bash
cbm-v2 backup import backup.json --project my-app
cbm-v2 backup import backup.json --project restored-app --dry-run
```

## Global Options

| Option | Description |
|---|---|
| `-V, --version` | Output version number |
| `-h, --help` | Display help for command |

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (validation, DB, filesystem) |
