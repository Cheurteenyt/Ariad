# V2 Architecture — Codebase Memory V2

> **Status:** FOUNDATION / INACTIVE (R169A)
> **Last verified:** 0.75.0 / R169A — generation store foundation merged but NOT active.
> Current behavior (indexer, readers, UI, MCP, CLI) is unchanged from R168.1 and still uses the legacy `<project>.db` path. The R169A foundation is merged but no production code path calls it. `DATA-CARRY-01` (P1) remains open.

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
## 15. R169A — Generation Store Target Architecture (FOUNDATION / INACTIVE)

> **Status: FOUNDATION / INACTIVE.** The target architecture documented
> in this section is **not active**. The foundation code is merged and
> tested, but no production code path calls it. The indexer still writes
> to the legacy `<project>.db` path; readers still open the legacy DB
> directly. This section describes the target, not the current behavior.

### 15.1 Goal

A reader of the code graph must see **either the old complete snapshot
or the new complete snapshot — never a partial publication**. This is
the contract that closes `DATA-CARRY-01` (P1).

### 15.2 Storage layout

All generation-store data lives under the platform cache directory:

```
<XDG_CACHE_HOME or ~/.cache>/
└── codebase-memory-mcp/                       # cbmCacheDir()
    ├── <project>.db                            # legacy DB (current behavior)
    └── projects/                               # generationStoreRoot()
        └── <sha256(project)>/                  # projectStoreDir()
            ├── active-generation.json          # manifest (single pointer)
            ├── index-state.json                # diagnostics sidecar
            ├── generations/
            │   └── generation-<uuid>.db        # immutable published DB
            └── tmp/                            # staging area for new DBs
```

The project directory is named by `sha256(project)`, never by the
project name directly. This prevents path traversal, separator
injection, and length / Unicode issues. The original project name is
stored inside the manifest (`project` field) and validated against the
requested project on every read.

### 15.3 Manifest schema V1

`active-generation.json` is a JSON object with exactly these 13 keys:

| Key | Type | Constraint |
|---|---|---|
| `formatVersion` | integer | Must be `1`. |
| `project` | string | Must match the requested project exactly. |
| `generationId` | string | Canonical UUID v4. |
| `dbFile` | string | Relative path from the project store dir. No `..`, no absolute, no `\`. |
| `createdAt` | string | ISO-8601 **with timezone**. |
| `rootFingerprint` | string | Non-empty. |
| `extractorSemanticsVersion` | integer | `>= 0`. |
| `discoveryPolicyVersion` | integer | `>= 0`. |
| `nodeCount` | integer | `>= 0`. |
| `edgeCount` | integer | `>= 0`. |
| `fileCount` | integer | `>= 0`. |
| `sizeBytes` | integer | `>= 0`. |
| `sha256` | string | 64 lowercase hex chars. |

The exact key set is enforced: missing or extra keys →
`MANIFEST_SCHEMA_ERROR`. A future incompatible change requires bumping
`formatVersion` and a migration plan. The current
`CURRENT_GENERATION_MANIFEST_VERSION = 1` is exported from
`v2/src/indexer/schema.ts`.

### 15.4 State machine

```
START → BUILD_STAGING → VALIDATE → FINALIZE → CAS → MANIFEST → FINAL_STATE
```

- **BUILD_STAGING:** write `generations/generation-<uuid>.db` into
  `tmp/` (not yet visible to readers).
- **VALIDATE:** open the staging DB, run consistency checks (row counts,
  sha256, schema version, root fingerprint).
- **FINALIZE:** `fsync` the staging DB file.
- **CAS:** `rename` the staging DB from `tmp/` to `generations/`
  (atomic on POSIX).
- **MANIFEST:** write `active-generation.json` atomically.
- **FINAL_STATE:** the new generation is live; the old generation is
  now stale and will be collected by GC.

The DB is **fully written and fsynced** before the manifest is touched.
The manifest swap is the **only** visible mutation to readers.

### 15.5 Durability ordering

```
fsync file  →  rename  →  fsync dir
```

Implemented in `writeJsonAtomically(targetPath, value)` in
`v2/src/storage/generation-store.ts`. Any deviation breaks the
durability contract: `rename` before `fsync file` can leave the target
empty on crash; `fsync dir` before `rename` is useless; skipping
`fsync file` can lose file content on crash even if the rename
succeeds.

### 15.6 Reader contract

> **Resolve once. Open the resolved DB. Keep the handle.**

`resolveActiveCodeDb(project)` returns a discriminated union
(`generation | legacy | missing`). The reader opens `resolved.dbPath`
once and keeps the SQLite handle. Even if a concurrent publication
swaps the manifest, the reader's handle still points to the generation
it opened — and that generation is **immutable**.

### 15.7 Legacy migration

| Manifest state | Legacy DB state | Resolver result |
|---|---|---|
| valid | (ignored) | `generation` |
| absent | exists | `legacy` |
| absent | absent | `missing` |
| invalid (any reason) | (ignored) | **FAIL CLOSED** |

An invalid manifest never silently falls back to legacy. The legacy DB
is only used when no manifest exists. Migration to generation-only
operation happens in stages R169B (writer) → R169C (readers) →
R169D–R169E (remove legacy).

### 15.8 Failure taxonomy

Structured error codes, never a single `DB_ERROR` bucket. See
`GenerationStoreErrorCode` in `v2/src/storage/generation-types.ts`:

- `GENERATION_STORE_CONFIG_ERROR`
- `MANIFEST_PARSE_ERROR` / `MANIFEST_SCHEMA_ERROR`
- `MANIFEST_TARGET_MISSING` / `MANIFEST_TARGET_OUTSIDE_STORE`
- `MANIFEST_PROJECT_MISMATCH` / `MANIFEST_UNSUPPORTED_VERSION`
- `MANIFEST_SYMLINK_REJECTED` / `GENERATION_TARGET_SYMLINK_REJECTED`
- `LEGACY_SOURCE_OPEN_FAILED`
- `ATOMIC_WRITE_FAILED` / `ATOMIC_RENAME_FAILED` / `ATOMIC_FSYNC_FAILED`
- `PATH_TRAVERSAL_REJECTED` / `PROJECT_KEY_INVALID`

Each code carries a `phase` (function name) and `project` for
diagnostics.

### 15.9 GC policy

**Keep the active generation plus the two most recent previous
generations.** Older generations are deleted. `tmp/` is swept on every
GC pass for orphan files older than a threshold (default 1 hour). GC is
best-effort and never deletes the active generation. GC is **not**
enabled in R169A.

### 15.10 Recovery

Fail closed and stay closed. No silent fallback, no `--force-legacy`
flag, no `CBM_IGNORE_GENERATION_STORE=1` escape hatch. A manifest that
fails validation must be repaired or deleted before reads succeed for
that project.

### 15.11 Crash matrix (C01–C20)

Twenty crash points are enumerated in
[ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md)
§ 12. The common property: a crash never leaves the reader seeing a
partial publication. The reader sees either the previous complete
snapshot or the new complete snapshot, depending on whether the
manifest rename (C12) survived.

### 15.12 Performance contract

**Zero overhead when unused.** No production code imports
`generation-store.js` at startup. No `fsync`, `mkdir`, or `lstat` runs
on the hot path. The legacy `defaultCodeDbPath` is unchanged and
remains the only path used by the indexer, readers, UI, MCP, and CLI.
Verified by the `R169A — No production behavior change` test block in
`v2/tests/storage/r169a-generation-store.test.ts`.

### 15.13 R170 boundary (lease / fencing)

R169A is single-host only. R170 will add multi-host lease / fencing:
the indexer acquires a lease with a fencing token; the manifest writer
includes the token; a stale indexer cannot overwrite a newer manifest.
The V1 manifest schema is closed, so adding a `leaseToken` field
requires `formatVersion = 2` and a migration. `index-state.json` is
the sidecar where operational state (including lease) lives.

### 15.14 Activation plan

| Round | Scope | Status |
|-------|-------|--------|
| R169A | Path helpers, manifest V1 types, resolver, atomic JSON writer | **MERGED — INACTIVE** |
| R169B | Indexer writes generation DBs under `generations/` + manifest | planned |
| R169C | Readers switch from `legacyCodeDbPath` → `resolveActiveCodeDb` | planned |
| R169D | GC policy (keep active + 2 previous) | planned |
| R169E | Legacy migration finish + `DATA-CARRY-01` close | planned |
| R170  | Multi-host lease / fencing | out of scope |

### 15.15 See also

- [ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md) —
  full target architecture (storage layout, manifest schema, state
  machine, durability ordering, reader contract, legacy migration,
  failure taxonomy, GC policy, recovery, crash matrix C01–C20,
  performance contract, R170 boundary).
- [V2_CURRENT_STATE.md](V2_CURRENT_STATE.md) — R169A section
  (foundation in progress, publication NOT active).
- `v2/src/storage/generation-store.ts` — implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` — test matrix.
