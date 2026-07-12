# V2 Architecture — Codebase Memory V2

> **Status:** current
> **Last verified:** 0.74.1 / R168.3

## 1. System Context

Codebase Memory V2 is a hybrid code intelligence system that combines:

- A **native WASM indexer** (112 languages via tree-sitter) that builds a
  code graph in SQLite without requiring a C engine.
- A **human memory graph** (SQLite) for notes, ADRs, and Obsidian sync.
- An **MCP server** exposing 7 tools for code graph queries and human
  memory CRUD.
- A **web-based graph UI** (React/Vite) served by the V2 backend.

The V1 C engine is retained as a **reference and fallback** for languages
not yet covered by the WASM indexer, but V2 is fully autonomous for
TypeScript/JavaScript projects.

## 2. Monorepo Components

```
v2/             Core: CLI, indexer, MCP, human memory, UI server
graph-ui/       Frontend: React/Vite graph visualization
v1-reference/   Historical C engine (reference + fallback)
scripts/ci/     Infrastructure automation (mirror state machine)
docs/           Documentation
```

## 3. V2 Native WASM Indexer

The indexer does NOT require V1. It uses tree-sitter WASM parsers to
extract:

- **Exports** (functions, classes, types, constants)
- **Imports** (named, default, namespace)
- **Call sites** (function/method calls with resolved targets)
- **Aliases** (symlinks, path mappings)

Key modules:
- `v2/src/indexer/wasm-extractor.ts` — tree-sitter WASM parsing, discovery
- `v2/src/indexer/fast-walker.ts` — AST walker for exports/imports/calls
- `v2/src/indexer/cross-file-resolver.ts` — matches call-sites to definitions
- `v2/src/indexer/indexer.ts` — orchestrator: full/incremental, parallel workers
- `v2/src/indexer/schema.ts` — SQLite schema, `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`

## 4. V1 C Engine — Fallback/Reference

The V1 C engine (`v1-reference/`) is retained for:
- Languages not yet supported by the WASM indexer
- Performance comparison benchmarks
- Historical reference

V2 detects V1 (presence of `<project>.db`) and can use it as a read-only
code graph source via the bridge module. V2 can also write the code graph
independently of V1.

## 5. SQLite Code Graph

The code graph is stored in a SQLite database (`<project>.db`) with:

- `nodes` — exported symbols (functions, classes, types)
- `edges` — call relationships (caller → callee)
- `file_hashes` — file content hashes for incremental indexing
- `projects` — project metadata (root path, fingerprint, stale flag)
- `alias_history` — historical alias targets for protection

Schema version: `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`
Discovery policy version: `CURRENT_DISCOVERY_POLICY_VERSION = 2`

## 6. Human Memory Graph

A separate SQLite database (`<project>.human.db`) stores:
- Notes with labels (decision, risk, question, etc.)
- ADRs (Architecture Decision Records)
- Links to code graph nodes
- Obsidian frontmatter sync

## 7. Obsidian Integration

V2 syncs human memory to/from Obsidian vaults:
- **Generator**: writes human memory nodes as Markdown files with frontmatter
- **Importer**: reads Obsidian files back into the human memory graph
- **Wikilinks**: resolves `[[note]]` references
- **Path safety**: validates against path traversal attacks

## 8. MCP Server

The MCP (Model Context Protocol) server exposes 7 tools:

1. `search_code` — search the code graph
2. `get_node` — get a specific code node
3. `get_edges` — get call relationships
4. `list_projects` — list indexed projects
5. `add_note` — add a human memory note
6. `list_notes` — list human memory notes
7. `sync_obsidian` — sync with Obsidian vault

## 9. Graph UI

A React/Vite application (`graph-ui/`) served by the V2 backend:

- **Force-directed graph** visualization (d3-force)
- **Real-time updates** via WebSocket
- **Project switcher** with health indicators
- **Human memory** tab (notes, ADRs)
- **Index status** with stale/recovery info

The UI is built and embedded in the npm package at `dist/ui/`. Runtime
resolution uses `import.meta.url` so it works from any working directory.

## 10. Publication (current state + R169 target)

### Current state

The indexer writes to the active SQLite database in stages:
1. Clear old data (`clearProjectData`)
2. Insert nodes
3. Insert edges
4. Insert file hashes
5. Update project metadata

A crash between steps can leave a partial graph. The `stale` flag and
`alias_history` table provide some protection, but the publication is
not atomic.

### R169 target (Atomic Generation Publication)

```
reader sees:
  old complete snapshot
  OR
  new complete snapshot
  never a partial publication
```

Architecture: generation DB + manifest + atomic rename + fsync + GC.

## 11. CI / Mirror

- **GitHub** is the canonical repository (source of truth, CI, PRs, merges)
- **GitLab** is a passive mirror of `main` only (no pipelines, no MRs)
- **Mirror workflow** (`mirror-main-to-gitlab.yml`) triggers on CI success
  via `workflow_run`, fast-forwards the validated SHA to GitLab with
  `-o ci.no_pipeline`
- **Mirror state machine** is in `scripts/ci/mirror-main-to-gitlab.sh`
  (testable with bare repos)

See [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) for
the full architecture, postmortem, and diagnostic matrix.

## 12. Packaging

- **npm package**: `v2/package.json` with `files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"]`
- **Build**: `npm run build:package` (via `scripts/build-package.mjs`)
  builds graph-ui + v2 backend + copies UI assets to `dist/ui/`
- **Docker**: 3-stage build (ui-builder → builder → runtime)
- **Lockfiles**: `v2/package-lock.json` + `graph-ui/package-lock.json`
  committed for reproducibility

See [RELEASE_POLICY.md](RELEASE_POLICY.md) for release governance.

## 13. Security

- SSH credentials: dedicated GitLab mirror key (not shared with GitHub)
- GitHub Actions: actions pinned by immutable SHA
- Dependabot: github-actions ecosystem, weekly PRs
- Branch protection: `main` protected, fast-forward only for mirror

## 14. Limitations

- No atomic generation publication (R169 target)
- No project lease/fencing (R170 target)
- Node 20 only in CI (Node 22/24 matrix deferred)
- No GitHub Release yet (pre-release after R169 + R170)
- Repository name `codebase-mirror` is misleading (rename deferred)
