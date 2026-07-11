# V2 Current State — Codebase Memory V2

> **Authoritative snapshot of the current product state.** Updated R158 (2026-07-11).
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

### Known limitations (R153, closed in R154)

- ~~**Alias history cold start**~~: **CLOSED in R154**. The cold-start lock
  now fires when `alias_history_initialized=0` OR
  `discovery_policy_version < CURRENT_DISCOVERY_POLICY_VERSION` AND there
  are broken aliases AND existing nodes. The lock blocks all deletions
  (incremental) and forces hasUncertainty (full) until a successful run
  populates the history and sets the version.
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

## R154 — Bootstrap + Root Identity + Atomic State

R154 (round 79) closes the cold-start, root-identity, contribution, visibility,
and atomicity gaps identified in the R153 audit:

- **Cold-start lock** (`MIG-R154-01`): added `alias_history_initialized` and
  `discovery_policy_version` columns to the projects table. The indexer reads
  the bootstrap state: if not initialized AND broken aliases AND existing nodes,
  the cold-start lock fires (blocks all deletions, forces full-mode uncertainty).
  After a successful run, both are set and normal protection applies.
- **Root fingerprint** (`ALIAS-R154-01`): added `root_fingerprint` column
  (`canonicalRoot:st_dev`). The UNIQUE constraint is now
  `(project, root_fingerprint, alias_path)`. Reusing the same project name
  with a different root does NOT inherit stale history.
- **Contribution filter** (`ALIAS-R154-02`): only contributive aliases are
  historized — file aliases require `detectLanguage !== null`; directory
  aliases require at least one discovered file under the prefix. Non-contributive
  aliases (txt, FIFO, empty dir) are still tracked as warnings but NOT persisted.
- **Target visibility check** (`ALIAS-R154-03`): broken aliases with a still-visible
  target (directly or via another alias) do NOT force stale. Only genuinely
  absent targets are protected.
- **Atomicity** (`TX-R154-01`, `TX-R154-02`): try/finally around persistAliasHistory
  guarantees db.close() even on exception. The residual non-atomicity (graph fresh
  before history persist) is documented; a full atomic transaction is deferred to R160.
- **Run-id GC** (`PERF-R154-01`): replaced `NOT IN (?, ?, ...)` dynamic GC
  with `last_observed_run_id` stamping + `DELETE WHERE run_id != current`.
  O(1) SQL regardless of alias count.
- **Outcome contract** (`OUTCOME-R154-01`): `--allow-partial` now ONLY masks
  PARTIAL. FAILED is always exit 1, STALE is always exit 2.
- **CHECK constraint** (`SCHEMA-R154-01`): `target_kind` has
  `CHECK(target_kind IN ('file', 'directory'))`.

`CURRENT_DISCOVERY_POLICY_VERSION = 1` (separate from extractor semantics v8 —
tracks policy, not AST output).

## R155 — Atomic Alias State + Fingerprint v2 + Special File Safety

R155 (round 80) closes the atomicity, root-identity, special-file, and
scalability gaps identified in the R154 audit:

- **Atomic alias state commit** (`TX-R155-01`): new
  `commitAliasStateAtomically()` helper combines alias_history UPSERT + GC +
  project stats (fresh + initialized + policy + root_fingerprint) in a SINGLE
  transaction. If persist fails, the ENTIRE transaction rolls back — the graph
  stays stale, `alias_history_initialized` stays 0, `last_successful_index_at`
  is NOT advanced. The next run's cold-start check correctly detects the
  uninitialized state. All 3 success paths (no-op, deletion-only, main) use
  this helper.
- **Root fingerprint v2** (`ROOT-R155-01`): fingerprint is now
  `canonicalRoot:st_dev:st_ino` (was `canonicalRoot:st_dev`). On recreate,
  `st_ino` changes on most filesystems, producing a new fingerprint. On
  untrustworthy filesystems (dev=0, ino=0), falls back to
  `canonicalRoot:untrusted`. Discovery policy version bumped to 2.
- **Special file type safety** (`ALIAS-R155-01`): `resolvedAliases.push` moved
  INTO the `isFile()` and `isDirectory()` branches. Special files (FIFO,
  socket, device) are never historized.
- **Scalable GC** (`PERF-R155-01`): replaced `IN (?, ?, ...)` dynamic stamping
  with a prepared UPDATE per alias. No dynamic SQL, no variable limit.
- **Legacy row cleanup** (`MIG-R155-01`): GC now uses
  `last_observed_run_id IS NULL OR != ?` to catch legacy NULL rows. A separate
  `DELETE WHERE root_fingerprint=''` cleans up pre-R154 rows.
- **UUID runId** (`CONC-R155-01`): `runId = randomUUID()` instead of
  `Date.now()`. `last_observed_run_id` column type changed from INTEGER to TEXT.
- **EXISTS bootstrap** (`PERF-R155-04`): cold-start lock uses
  `SELECT EXISTS(... LIMIT 1)` instead of `COUNT(*)`. Also checks `file_hashes`.
- **STALE outcome contract** (`OUTCOME-R155-01`): STALE outcome now uses
  `errors: []` (was `errors: [{...}]`). The contract `errors>0 → FAILED` is
  respected.
- **Dry-run failure banner** (`OUTCOME-R155-02`): dry-run with errors shows
  "Dry-run failed" instead of "Dry-run complete".

`CURRENT_DISCOVERY_POLICY_VERSION = 2` (bumped from 1 — fingerprint format
change forces re-population of alias_history).

## R156 — CI Hotfix + Truthful State + Directory Alias + Graph UI Bridge

R156 (round 81) closes the CI blocker, the truthful-state gap, and the
directory-alias duplicate identified in the R155 audit, plus adds the
GitHub ↔ GitLab branch bridge for graph-ui contributions:

- **CI blocker fix** (`CI-R156-01`): R155 imported `mkfifoSync` from
  `node:fs`, which doesn't exist in Node.js. The TypeScript typecheck
  failed, blocking ALL backend CI on every MR. Fixed by replacing
  `mkfifoSync` with `spawnSync('mkfifo', ...)` wrapped in a `createFifo()`
  helper that returns `false` on Windows/macOS.
- **Truthful state on commit failure** (`TX-R156-01`): the indexer now
  pre-marks `cross_file_calls_stale=1` BEFORE extraction (only on the
  main path). If `commitAliasStateAtomically` fails, the pre-marked
  stale=1 remains truthfully set — the graph IS stale (extraction
  committed in its own transaction, but the projects row can't rollback
  to stale=0). The catch block also best-effort persists the commit
  error message. If the commit succeeds, it clears stale=0 atomically.
- **Directory alias duplicate historization** (`ALIAS-R156-01`):
  `resolvedAliases.push` is now BEFORE the `visitedDirs.has` dedup check.
  Two aliases (aliasA, aliasB) to the same directory are BOTH historized
  — history and traversal are separate concerns.
- **Structured staleReason + recovery** (`OBS-R156-01`): `IndexResult`
  now carries `staleReason?: { code, message, paths }` and
  `recovery?: 'retry_incremental' | 'fix_filesystem' | 'full_reindex' |
  'none'`. The full-uncertainty return builds a structured staleReason
  with code in {DISCOVERY_UNCERTAIN, HISTORICAL_ALIAS_BROKEN,
  COLD_START_LOCK}. The CLI displays the message, affected paths, and
  recovery recommendation.
- **Non-circular cold-start message** (`AVAIL-R156-01`): the cold-start
  lock message now says "Fix or remove the broken symlinks (see paths
  below), then rerun." instead of the circular "run a successful full
  index first". The recovery field is `'fix_filesystem'`.
- **GitLab MR CI gate** (`CI-FLOW-R156-01`): replaced the echo-only
  `mr-preflight` job with a real `github-ci-gate` job that pushes the
  MR's SHA to a temporary GitHub branch, triggers the `gitlab-mr-ci`
  workflow via `repository_dispatch`, polls for the conclusion, and
  fails the GitLab pipeline if GitHub CI failed. The new
  `gitlab-mr-ci.yml` workflow runs backend + frontend typecheck/build/test
  on the MR's SHA. Transitional: `allow_failure: true` until the
  workflow is on GitHub main.
- **graph-ui branch sync** (`CI-FLOW-R156-01`): new
  `sync-graph-ui-to-gitlab.yml` workflow runs after the upstream `CI`
  workflow succeeds on a `graph-ui/**` branch. It pushes the SHA to
  GitLab under the same name and creates/updates a GitLab MR. Uses
  `workflow_run` trigger to access repository secrets safely. See
  [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) for
  the architecture and security model.

### Known limitations (R156)

- **`github-ci-gate` is `allow_failure: true`** (transitional): until the
  `gitlab-mr-ci.yml` workflow is on GitHub main (after this MR merges and
  mirrors), the gate is non-blocking. A follow-up commit should remove
  `allow_failure: true`.
- **graph-ui sync only triggers on `graph-ui/**` branches**: other
  branches don't get the GitHub PR → GitLab MR bridge.
- **`persistAliasHistory` is dead code** (`QUAL-R156-01`): R155 replaced
  it with `commitAliasStateAtomically` for all success paths. Kept as a
  stable API for external callers (MCP tools).

## R158 — Publication Orchestrator + Unified staleReason Classifier

R158 (round 83) closes the residual publication-state and classifier gaps
that R157 left in place. R157 added catch blocks to the three success
paths (no-op, deletion-only, main), but the catches only wrapped
`commitAliasStateAtomically`, used hand-rolled `staleCode` builders with
inconsistent priority, and left the `errors[]` array empty on
publication failure (making programmatic triage impossible).

### Publication orchestrator + unified classifier (`indexer.ts`)

- **Unified `classifyStaleReason()` function** (`OBS-R158-01/02/03`):
  a single function with priority order
  SEMANTICS_MISMATCH → HISTORICAL_ALIAS_BROKEN → COLD_START_LOCK →
  DISCOVERY_UNCERTAIN → PREVIOUSLY_STALE. All three stale return paths
  (no-op, deletion-only, main) now call it with the same params. R157's
  no-op path always returned `PREVIOUSLY_STALE` (even when the real
  cause was semantics mismatch or historical alias), and its
  deletion-only path returned `SEMANTICS_MISMATCH` with an empty
  message for non-semantics cases. The classifier also adds
  HISTORICAL_ALIAS_BROKEN and COLD_START_LOCK to the fast paths (R157
  only emitted them on the full-uncertainty path).
- **Structured `failure` field on `IndexResult`** (`OUTCOME-R158-01`):
  `failure?: { code: 'PERSIST_FAILURE' | 'EXTRACTION_CRASH' | 'DB_ERROR'
  | 'UNKNOWN'; message: string; phase: string }`. All three catch blocks
  (no-op-commit, deletion-only-commit, main-commit) populate it.
  `errors[]` is now reserved for per-file extraction errors only —
  R157's `errors: []` on publication failure made programmatic triage
  impossible (consumers had to string-match `staleReason.message`).
- **`staleReason.paths` capped at 100** (`PERF-R158-01`): a repo with
  thousands of broken symlinks used to produce a multi-MB `IndexResult`
  that MCP and Graph UI serialized through stdout/websocket, causing OOM
  and GC pauses. Now capped at `MAX_STALE_PATHS = 100` — the field is
  for human triage, not exhaustive enumeration.
- **Premark UPSERT updates `root_path`** (`ROOT-R158-01`): R157's
  premark `INSERT ... ON CONFLICT DO UPDATE SET` clause set
  `cross_file_calls_stale`, `last_index_attempt_at`, and
  `last_index_error` but NOT `root_path`. A project reconfigured to a
  new root kept the old `root_path` until the final commit. If the
  final commit failed, the DB was left with stale=1 and the OLD
  root_path, so Graph Status showed the wrong root. R158 adds
  `root_path = excluded.root_path` to the ON CONFLICT clause in BOTH
  premark UPSERTs (main path + deletion-only path).

### Graph UI bridge hardening (`.github/workflows/sync-graph-ui-to-gitlab.yml`)

- **Full fetch instead of `--depth=1`** (`SYNC-R158-01`): R157's path
  guard ran `git fetch origin main --depth=1` then
  `git diff --name-only origin/main...HEAD`. If main had advanced since
  the branch was created, the shallow fetch had no merge-base and the
  diff failed. R158 uses a full fetch (`git fetch origin main`).
- **`remove_source_branch=true` on PUT too** (`SYNC-R158-02`): R157
  added the flag to the POST (create) call but not the PUT (update)
  call. An MR created before R157 wouldn't have the flag set, so the
  source branch wouldn't be auto-deleted on merge. R158 adds it to PUT.
- **Fail loudly if `MR_COUNT > 1`** (`SYNC-R158-03`): R157 silently
  took the first MR when duplicates existed — masking the duplication.
  R158 fails the workflow with a diagnostic message and the JSON list.

### Tests

16 new tests in
`tests/indexer/r158-publication-orchestrator-classifier.test.ts`:

- 4 tests for `classifyStaleReason` priority (SEMANTICS_MISMATCH,
  HISTORICAL_ALIAS_BROKEN, COLD_START_LOCK, PREVIOUSLY_STALE) — each
  triggered indirectly via `indexProjectWasm` to verify the runtime
  code path.
- 3 tests for `failure` field on FAILED outcome (no-op, deletion-only,
  main path) — using `vi.mock` + `vi.hoisted` to inject
  `commitAliasStateAtomically` failures.
- 1 test for `staleReason.paths` cap at 100 (150+ broken aliases →
  exactly 100 paths).
- 2 tests for `root_path` UPSERT propagation (main + deletion-only
  path).
- 6 source-inspection regression tests guarding against accidental
  removal of the `failure` type, the three catch-block `failure:`
  assignments, the `classifyStaleReason` call sites, `MAX_STALE_PATHS`,
  `root_path = excluded.root_path` in both UPSERTs, and the
  sync-graph-ui workflow changes.

### Known limitations (R158)

- **`failure.code = 'EXTRACTION_CRASH' | 'DB_ERROR' | 'UNKNOWN'` not yet
  emitted** (carryover): only `PERSIST_FAILURE` is emitted today. The
  other codes are reserved for future use (extraction crashes that
  bypass the worker pool, raw DB errors not from publication, etc.).
- **`classifyStaleReason` is a private helper** (design choice): not
  exported. Tested indirectly via `IndexResult.staleReason.code`. If
  MCP/UI consumers need to call it directly, export it in a follow-up.
- **`staleReason.paths` cap is silent** (UX): the cap doesn't add a
  `truncated: true` flag. A future round may add it so consumers can
  display "(showing 100 of N)".

## Current versions

| Component | Version | Source of truth |
|---|---|---|
| Package | see `v2/package.json` | `v2/package.json` |
| Extractor semantics | 8 | `v2/src/indexer/schema.ts` `CURRENT_EXTRACTOR_SEMANTICS_VERSION` |
| Discovery policy | 2 | `v2/src/indexer/schema.ts` `CURRENT_DISCOVERY_POLICY_VERSION` |
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

This document was validated at R158 (2026-07-11). Always cross-check with `v2/CHANGELOG.md` for the latest state.
