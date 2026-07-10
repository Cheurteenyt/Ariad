# V2 Current State — Codebase Memory V2

> **Authoritative snapshot of the current product state.** Updated R153 (2026-07-11).
> For the historical roadmap, see [V2_ROADMAP.md](V2_ROADMAP.md) (archive, 0.15.9 era).
> For the authoritative version and bug count, see `v2/package.json` and `v2/CHANGELOG.md`.

## Architecture

Codebase Memory V2 is a **hybrid** code intelligence system:

1. **V2 Native WASM Indexer** — 112 languages via `tree-sitter-wasm`. Partially autonomous: can index TS/JS projects without V1.
2. **V1 C Engine** — 158 languages via tree-sitter C. Fallback for languages V2 doesn't cover natively.
3. **V2 Human Memory Layer** — ADRs, bug notes, refactor plans, conventions, risk assessments. Obsidian vault sync. Graph UI. 7 MCP tools.

Both indexers write to the same V1-compatible SQLite schema, so `CodeGraphReader` reads either transparently.

## R153 — Alias History + Warning Propagation

R153 (round 78) closes the silent historical-target deletion vector introduced
by R152. When a symlink alias was previously valid and is now broken (ENOENT
or ELOOP on realpath), the old canonical target's data is preserved:

- **`alias_history` table** (`schema.ts`): persists `alias_path`,
  `canonical_target`, `target_kind`, `last_seen_success_at` across full
  reindexes. Garbage-collected entries for aliases no longer on disk.
- **Discovery tracking** (`wasm-extractor.ts`): `resolvedAliases` (realpath
  succeeded) and `brokenAliases` (ENOENT/ELOOP) are returned in
  `DiscoveryResult`.
- **Indexer protection** (`indexer.ts`): for each broken alias with a
  history entry, the old canonical target is added to a protected paths
  set. File targets get exact-match protection; directory targets get
  subtree-prefix protection. In incremental mode, protected paths are
  filtered from `deletedRelPaths`. In full mode, any protected path
  forces `hasUncertainty=true` (abort the full to preserve the graph).

R153 also completes the warning propagation work started in R152:

- **All return paths** now include `warnings` (dry-run, partial discovery,
  full uncertainty, no-op, deletion-only, main).
- **All warning codes** now carry a root-relative path (ENOENT_LSTAT,
  ENOENT_STAT, ENOENT_IDENTITY, ENOENT_REALPATH_DIR added).
- **Typed `outcome` field** in `IndexResult`: `SUCCESS` |
  `SUCCESS_WITH_WARNINGS` | `STALE` | `PARTIAL` | `FAILED`. The CLI prints
  warnings BEFORE the outcome banner, and the banner text reflects the
  outcome.
- **Dry-run shows warnings** (R152 gated them with `!opts.dryRun`).
- **Exact sample count**: `count - samplePaths.length` instead of `count - 5`.

### Known limitations (R153)

- **Alias history cold start**: a v8 DB upgraded to R153 has an empty
  `alias_history` until the next successful run populates it. The first
  R153 run with a broken alias won't protect any target (no history yet).
  This is acceptable — the alias_history is populated on the first
  successful run and protects subsequent runs.
- **No cross-process alias_history lock**: concurrent indexers on the same
  project could race on the alias_history table. This is the same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): a crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. The README's "shared V1-compatible
  schema" claim is partially true — `CodeGraphReader` reads both, but a
  V1 DB cannot be migrated to V2 in-place. Future round will add
  `GraphDbDialect` detection.

## Current versions

| Component | Version | Source of truth |
|---|---|---|
| Package | see `v2/package.json` | `v2/package.json` |
| Extractor semantics | 8 | `v2/src/indexer/schema.ts` `CURRENT_EXTRACTOR_SEMANTICS_VERSION` |
| Bugs fixed | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Indexer tests | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Project tests | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Node.js | ≥18.6.0 (engines) | `v2/package.json` |
| Tested on | Node 22/24, Linux | CI + local |

Do NOT hardcode version numbers or test counts in documentation — always reference the authoritative sources above.

## Stable features

### Native indexer (V2 WASM)
- 112 languages via pre-built tree-sitter WASM grammars
- Cross-file CALLS resolution: persistent `call_sites`, `imports`, `exports` tables; resolver matches call-sites to definitions
- Module validity lock: duplicate exports, default marker collisions, unresolved star sources, invalid builtins
- Type/value default separation: `interface`/`type alias` defaults excluded from runtime count
- Builtin truth lock: `isBuiltin()` from `node:module`; `node:fake` rejected, `node:test` accepted
- Incremental indexing: content hash + mtime_ns fast-skip; deletion-only fast path
- Parallel workers: multi-threaded WASM parsing for >20 changed files
- Semantics versioning: incremental forces full reindex when extractor output changes
- Discovery completeness lock: `DiscoveryResult` with structured errors; partial discovery preserves graph
- Canonical root propagation: symlinked roots produce `file_path` without `..`
- File identity contract: `dev:ino` dedup with `0:0` fallback; deterministic hardlink selection
- Persistent discovery state: `cross_file_calls_stale` and `extractor_semantics_version` persisted in DB; Graph Status reads them

### Human memory layer
- 11 node types (ADR, BugNote, RefactorPlan, Convention, LegacyNote, RiskNote, etc.)
- Obsidian-compatible Markdown vault sync (bidirectional, `## HUMAN NOTES` preserved)
- FTS5 full-text search (BM25 ranking)
- Graph UI (2D d3-force, dashboard, filters, WebSocket)
- 7 MCP tools (including flagship `prepare_edit_context`)
- Reports: hotspots, undocumented, risk
- Backup: export/import JSON

### Security
- Path traversal protection (`assertPathInsideRoot` with `path.relative` containment)
- Root discovery validation (`assertDiscoveryRoot`: stat + isDirectory + realpath + readdir)
- Discovery completeness lock (partial discovery preserves graph)
- Stale flag persistence (root failure + partial discovery persist `cross_file_calls_stale=1`)
- Backup rotation (max 5 `.bak` per note)
- Dry-run on sync/export/import/backup

## Limitations

- V2 native indexer is most precise on **TypeScript/JavaScript**. Other languages are parsed structurally without cross-file resolution.
- For full 158-language precision, use V1 C binary as fallback.
- Graph UI capped at ~2000 nodes for performance.
- CI runs on Ubuntu/Node 20 only (no Windows/macOS matrix yet).
- No lockfile committed (dependency versions may drift).
- Full index publication is not atomic (DATA-CARRY-01, P1 — open).

## Blockers (open carryovers)

| ID | Priority | Summary |
|---|---|---|
| DATA-CARRY-01 | P1 | Full index publication not atomic (clear → discover → extract; crash mid-way loses graph) |
| IDX-CARRY-01 | P1 | String-literal export names (`export { foo as "default" }`) not handled |
| IDX-CARRY-02 | P1 | Interface default exports in type namespace clauses |
| IDX-CARRY-03 | P1 | Module requests (non-star imports/re-exports) not validated globally |
| PKG-CARRY-01 | P1 | No lockfile, no CI matrix, no Docker smoke test |
| SEC-CARRY-01 | P2 | TOCTOU: path strings between check and usage |

## Roadmap (next rounds)

- **R144** — Deterministic file identity (multi-extension contract, collision detection)
- **R145** — Atomic full publication (`project.db.next` → validate → atomic rename)
- **R146** — Type namespace + module requests (IDX-CARRY-01/02/03)
- **R147** — CI multi-OS / Node matrix / lockfile (PKG-CARRY-01)
- **R148** — Performance caches / benchmarks (resolver cache, discovery benchmark)

## Workflow Git (hybrid)

```
GitHub HTTPS  →  clone / history (fast)
GitLab SSH    →  push / MR (deploy key)
git -C <abs>  →  bash loses CWD between calls
timeout       →  paramiko wrapper for SSH
SHA verify    →  local SHA = remote SHA after push
```

See [MAINTAINERS_GUIDE.md](../MAINTAINERS_GUIDE.md) for the full workflow.

## Validation date

This document was validated at R143 (2026-07-11). Always cross-check with `v2/CHANGELOG.md` for the latest state.
