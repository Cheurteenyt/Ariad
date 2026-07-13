/**
 * R169A — Atomic Generation Publication: generation store public facade.
 *
 * STATUS: FOUNDATION / INACTIVE
 * This module re-exports the path helpers, validators, trust-root
 * validators, and the read-only resolver / atomic writers that compose
 * the R169A generation store. No production code calls these functions
 * yet — the indexer and readers still use the legacy DB path.
 *
 * R169B-STEP1 — Module cycle broken.
 *
 * History: R169A originally placed ALL generation-store code in this
 * file (path helpers, validators, trust-root validators, atomic writer,
 * resolver, layout durability, project listing). The R169A-FIX-R8 audit
 * pass extracted the internal I/O harness into
 * `./internal/generation-store-io.ts` but kept the path helpers,
 * validators, and trust-root validators in this public facade. The
 * internal module then imported those symbols back from this facade —
 * creating a module cycle:
 *
 *   generation-store.ts -> internal/generation-store-io.ts (PROD_OPS, *Internal)
 *   internal/generation-store-io.ts -> generation-store.ts (paths, validators,
 *       trust-root checks)
 *
 * R169B-STEP1 breaks the cycle by extracting the shared helpers into
 * two new leaf modules:
 *
 *   - `./generation-paths.ts` — pure path helpers (getCacheRoot,
 *     cbmCacheDir, generationStoreRoot, projectStorageKey,
 *     projectStoreDir, generationsDir, tmpDir, activeManifestPath,
 *     indexStatePath, legacyCodeDbPath, isLexicallyInside, isPathInside)
 *     plus the layout constants and the GenerationStoreOptions
 *     interface. Depends only on `./generation-types.ts` and the Node
 *     standard library.
 *   - `./generation-validation.ts` — validators (validateGenerationManifest,
 *     validateIndexAttemptState, parseGenerationManifest), path-safety
 *     checks (assertPathInsideNoSymlinks, assertNotSymlink,
 *     assertTrustedRootNoSymlinks, assertGenerationStoreRootTrusted,
 *     assertLayoutDirPermissions), size/length bounds, and the O_NOFOLLOW /
 *     O_DIRECTORY platform flags. Depends on `./generation-types.ts`
 *     and `./generation-paths.ts`.
 *
 * New dependency direction (acyclic):
 *
 *   types -> paths/validation -> internal I/O -> public facades
 *
 *   - `./generation-types.ts`         — leaf (no internal deps)
 *   - `./generation-paths.ts`         — imports types
 *   - `./generation-validation.ts`    — imports types + paths
 *   - `./internal/generation-store-io.ts` — imports types + paths + validation
 *   - `./generation-store.ts` (this file) — imports types + paths + validation + internal
 *
 * NO module imports from a later stage. The internal I/O module does
 * NOT import from this public facade. The cycle is broken.
 *
 * Backward compatibility (R169A):
 *   Every symbol that R169A exported from this module is still exported
 *   from this module — either defined here (the public facades) or
 *   re-exported from paths / validation / types. Existing R169A callers
 *   and tests continue to work without modification.
 *
 *   The public API surface (the generated `.d.ts`) is unchanged for
 *   R169A public symbols. The internal symbols that R169A-FIX-R8
 *   already removed from the public surface (`AtomicFileOps`,
 *   `WriterTestHook`, `PROD_OPS`, the `*Internal` functions, etc.)
 *   remain non-exported from this facade; they live in the internal
 *   module as before.
 *
 * Section references are to the R169A specification (GPT 5.6 report).
 *
 * Security:
 *   - Project names are NEVER used directly as paths. A deterministic
 *     SHA-256 key is used instead (section 6.1).
 *   - All paths are containment-checked against the injected cache root
 *     (R169A-FIX SEC-R169A-01: unified cacheRoot parameter).
 *   - Symlinks in manifests and generation targets are rejected, and
 *     symlink CHAINS in any path component are also rejected
 *     (R169A-FIX SEC-R169A-02: assertPathInsideNoSymlinks walks every
 *     component with lstatSync).
 *   - R169A-FIX-R2 (SEC-R169A-R2-01): The trust root itself is validated
 *     by assertTrustedRootNoSymlinks.
 *   - Path traversal (`..`) and absolute paths in dbFile are rejected.
 *   - dbFile MUST be the canonical form `generations/generation-<uuid>.db`
 *     (R169A-FIX DATA-R169A-01: no aliasing).
 *   - Legacy DB path is containment-checked against cacheRoot
 *     (R169A-FIX SEC-R169A-01: legacyCodeDbPath rejects ../escape, absolute).
 */

import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// R169B-STEP1: Symbols imported below are USED in the public facades
// defined in this file (resolveActiveCodeDb, ensureGenerationStoreLayoutDurable,
// writeIndexStateAtomically, listProjectStoreKeys). All other R169A
// symbols (path helpers, validators, trust-root checks, layout constants)
// are re-exported via `export { ... } from "..."` statements further down
// — they are NOT imported into this module's local scope.

// Types used in the public facade function signatures.
import {
  IndexAttemptStateV1,
  ResolvedCodeDb,
  GenerationStoreError,
} from "./generation-types.js";

// Path helpers used directly by the public facades.
import {
  GenerationStoreOptions,
  getCacheRoot,
  cbmCacheDir,
  generationStoreRoot,
  projectStoreDir,
  activeManifestPath,
  legacyCodeDbPath,
  isLexicallyInside,
} from "./generation-paths.js";

// Validators / trust-root checks used directly by the public facades.
import {
  assertTrustedRootNoSymlinks,
  assertPathInsideNoSymlinks,
  assertGenerationStoreRootTrusted,
  parseGenerationManifest,
} from "./generation-validation.js";

// R169A-FIX-R8 (GPT 5.6 final audit pass): Internal I/O harness.
// The following symbols are imported from the internal module and are
// NOT re-exported. They are used only by the public facade functions
// (`writeIndexStateAtomically`, `ensureGenerationStoreLayoutDurable`)
// below. Tests that need direct access to `AtomicFileOps`,
// `WriterTestHook`, `PROD_OPS`, or the `*Internal` functions import
// them from `./internal/generation-store-io.js`.
//
// R169B-STEP1: The internal module now imports paths/validation/types
// directly (it no longer imports from this public facade). The module
// cycle is broken.
import {
  PROD_OPS,
  ensureGenerationStoreLayoutDurableInternal,
  writeIndexStateAtomicallyInternal,
} from "./internal/generation-store-io.js";

// ─── Re-exports for backward compatibility (R169A) ──────────────────────
//
// R169B-STEP1: Every symbol that R169A exported from this module is
// still exported here. Path helpers and layout constants are
// re-exported from `./generation-paths.js`. Validators and trust-root
// checks are re-exported from `./generation-validation.js`. Types are
// re-exported from `./generation-types.js`. The public facades
// (resolveActiveCodeDb, ensureGenerationStoreLayoutDurable,
// writeIndexStateAtomically, listProjectStoreKeys) are defined below.

// Re-export types for convenience
export type {
  GenerationManifestV1,
  IndexAttemptStateV1,
  IndexAttemptStaleReasonV1,
  IndexAttemptFailureV1,
  IndexAttemptOutcome,
  IndexRecoveryAction,
  IndexPublicationState,
  ResolvedCodeDb,
} from "./generation-types.js";
export {
  GenerationStoreError,
  MANIFEST_V1_KEYS,
  INDEX_STATE_V1_KEYS,
  isManifestV1Key,
  isIndexStateV1Key,
} from "./generation-types.js";

// Re-export path helpers and layout constants
export {
  GenerationStoreOptions,
  getCacheRoot,
  cbmCacheDir,
  generationStoreRoot,
  projectStorageKey,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  indexStatePath,
  legacyCodeDbPath,
  isLexicallyInside,
  isPathInside,
  CBM_CACHE_SUBDIR,
  PROJECTS_SUBDIR,
  MANIFEST_FILENAME,
  INDEX_STATE_FILENAME,
  GENERATIONS_SUBDIR,
  TMP_SUBDIR,
} from "./generation-paths.js";

// Re-export validators, trust-root checks, path-safety checks, size bounds.
// NOTE: `assertLayoutDirPermissions` is NOT re-exported here. It was an
// internal symbol in R169A (defined in the internal I/O module, used by
// the trust-root validators, NOT part of the public API surface). It
// remains internal in R169B-STEP1 — it just lives in
// `./generation-validation.js` now (moved to break the module cycle).
// The public facade does NOT re-export it; the R169A source-inspection
// test `INTERNAL_SYMBOLS` list still includes it.
export {
  MAX_GENERATION_MANIFEST_BYTES,
  O_NOFOLLOW,
  O_DIRECTORY,
  assertPathInsideNoSymlinks,
  assertNotSymlink,
  assertTrustedRootNoSymlinks,
  assertGenerationStoreRootTrusted,
  validateGenerationManifest,
  validateIndexAttemptState,
  parseGenerationManifest,
} from "./generation-validation.js";

// ─── Resolver (section 18D) ─────────────────────────────────────────────

/**
 * Resolve the active code DB for a project.
 *
 * Contract:
 *   - manifest valid -> generation
 *   - manifest absent + legacy exists -> legacy
 *   - manifest absent + no legacy -> missing
 *   - manifest invalid -> FAIL CLOSED (never fall back to legacy)
 *   - manifest target missing -> FAIL CLOSED
 *   - manifest target outside store -> FAIL CLOSED
 *   - manifest target not a regular file -> FAIL CLOSED
 *     (R169A-FIX DATA-R169A-01)
 *   - manifest project mismatch -> FAIL CLOSED
 *   - symlink manifest or any parent -> rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - symlink generation target or any parent -> rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - legacy path fails validation -> LEGACY_SOURCE_INVALID
 *     (R169A-FIX-R2 API-R169A-R2-01: renamed from LEGACY_SOURCE_OPEN_FAILED;
 *      R169A validates path + regular-file identity only — actual SQLite
 *      open validation occurs in R169D reader cutover.)
 *
 * R169A-FIX (SEC-R169A-01): The `cacheRoot` option, when provided, is
 * used for BOTH the generation store paths AND the legacy DB path.
 *
 * R169A-FIX-R2 (SEC-R169A-R2-01): The resolver validates the trust root
 * (cacheRoot -> cbm -> projects -> project-key) BEFORE checking manifest
 * or legacy. This closes the bypass where a parent of the trust root
 * is a symlink.
 */
export function resolveActiveCodeDb(
  project: string,
  options?: GenerationStoreOptions,
): ResolvedCodeDb {
  const phase = "resolveActiveCodeDb";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();

  // R169A-FIX-R2 (SEC-R169A-R2-01): Validate the trust root BEFORE any
  // manifest / legacy check.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const manifestPath = activeManifestPath(project, cacheRoot);
  const legacyPath = legacyCodeDbPath(project, cacheRoot);

  // R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check
  // on the manifest path. Walk from generationStoreRoot (a higher trust
  // root) all the way to the manifest file.
  const storeRoot = generationStoreRoot(cacheRoot);
  const projectDir = projectStoreDir(project, cacheRoot);
  assertPathInsideNoSymlinks(
    storeRoot,
    manifestPath,
    project,
    phase,
    "MANIFEST_SYMLINK_REJECTED",
  );

  // Check if manifest exists (using lstat to detect symlinks).
  let manifestExists = false;
  try {
    const stat = lstatSync(manifestPath);
    manifestExists = true;
    if (stat.isSymbolicLink()) {
      throw new GenerationStoreError(
        "MANIFEST_SYMLINK_REJECTED",
        phase,
        project,
        `Manifest path is a symlink: ${manifestPath}`,
      );
    }
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Manifest doesn't exist — fall through to legacy check.
    } else {
      // EACCES, EIO, ENOTDIR, etc. -> fail closed.
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        project,
        `Cannot stat manifest path "${manifestPath}": ${(e as Error).message}`,
      );
    }
  }

  if (manifestExists) {
    // Parse and validate the manifest — fail closed on any error.
    // R169A-FIX-R3 (SEC-R169A-R3-03): parseGenerationManifest opens with
    // O_NOFOLLOW + fstat to close the TOCTOU window.
    const manifest = parseGenerationManifest(manifestPath, project);

    // Resolve the generation DB path
    const dbPath = resolve(projectDir, manifest.dbFile);

    // Containment check: the resolved DB path must be inside the project store
    if (!isLexicallyInside(projectDir, dbPath)) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_OUTSIDE_STORE",
        phase,
        project,
        `Generation DB path escapes project store: ${dbPath}`,
      );
    }

    // R169A-FIX (SEC-R169A-02): Strict chain walk on dbPath from the
    // store root.
    assertPathInsideNoSymlinks(
      storeRoot,
      dbPath,
      project,
      phase,
      "GENERATION_TARGET_SYMLINK_REJECTED",
    );

    // R169A-FIX (DATA-R169A-01): Target must be a regular file.
    let dbStat;
    try {
      dbStat = lstatSync(dbPath);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        throw new GenerationStoreError(
          "MANIFEST_TARGET_MISSING",
          phase,
          project,
          `Generation DB file not found: ${dbPath}`,
        );
      }
      throw new GenerationStoreError(
        "MANIFEST_TARGET_MISSING",
        phase,
        project,
        `Cannot stat generation DB "${dbPath}": ${(e as Error).message}`,
      );
    }

    if (dbStat.isSymbolicLink()) {
      // Should be caught by assertPathInsideNoSymlinks above, but defense
      // in depth.
      throw new GenerationStoreError(
        "GENERATION_TARGET_SYMLINK_REJECTED",
        phase,
        project,
        `Generation DB is a symlink: ${dbPath}`,
      );
    }
    if (!dbStat.isFile()) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_NOT_REGULAR",
        phase,
        project,
        `Generation DB target is not a regular file: ${dbPath} (mode=0o${dbStat.mode.toString(8)})`,
      );
    }

    return {
      source: "generation",
      project,
      dbPath,
      generationId: manifest.generationId,
      manifest,
    };
  }

  // No manifest — check for legacy DB.
  // R169A-FIX-R2 (API-R169A-R2-01): Validate the legacy path the same
  // way we validate generation paths. Any failure -> LEGACY_SOURCE_INVALID
  // (renamed from LEGACY_SOURCE_OPEN_FAILED). R169A validates path +
  // regular-file identity only; actual SQLite open validation occurs in
  // R169D reader cutover.
  try {
    assertPathInsideNoSymlinks(
      cbmCacheDir(cacheRoot),
      legacyPath,
      project,
      phase,
      "LEGACY_SOURCE_INVALID",
    );
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      // Re-wrap as LEGACY_SOURCE_INVALID unless it already is.
      if (e.code !== "LEGACY_SOURCE_INVALID") {
        throw new GenerationStoreError(
          "LEGACY_SOURCE_INVALID",
          phase,
          project,
          `Legacy path failed validation: ${e.message}`,
        );
      }
      throw e;
    }
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy path validation error: ${(e as Error).message}`,
    );
  }

  let legacyStat;
  try {
    legacyStat = lstatSync(legacyPath);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Neither manifest nor legacy DB exists.
      return {
        source: "missing",
        project,
        dbPath: null,
        generationId: null,
      };
    }
    // EACCES, EIO, etc. -> fail closed.
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Cannot stat legacy DB "${legacyPath}": ${(e as Error).message}`,
    );
  }

  if (legacyStat.isSymbolicLink()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy DB is a symlink: ${legacyPath}`,
    );
  }
  if (!legacyStat.isFile()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy DB target is not a regular file: ${legacyPath}`,
    );
  }

  return {
    source: "legacy",
    project,
    dbPath: legacyPath,
    generationId: null,
  };
}

// ─── Layout durability (R169A-FIX-R2 DUR-R169A-R2-01, R169A-FIX-R3) ──────

/**
 * R169A-FIX-R2 (DUR-R169A-R2-01): Ensure the per-project store layout
 * (project store, generations, tmp) exists AND is durable. Public
 * facade — delegates to `ensureGenerationStoreLayoutDurableInternal`
 * (in the internal I/O module) with `PROD_OPS`.
 *
 * For each directory in the chain:
 *   1. If it doesn't exist, mkdir with mode 0700.
 *      Failure -> STORE_LAYOUT_CREATE_FAILED.
 *   2. If mkdir returned EEXIST (concurrent writer), revalidate.
 *   3. For EXISTING directories (found via lstat before mkdir),
 *      revalidate the same way.
 *   4. fsync the directory.
 *      Failure -> STORE_LAYOUT_DURABILITY_UNKNOWN.
 *   5. If the directory was newly created, fsync its PARENT directory.
 *      Failure -> STORE_LAYOUT_DURABILITY_UNKNOWN.
 *
 * Returns the list of directories that were newly created (in creation
 * order). Tests use this to assert that the parent-fsync step only runs
 * for newly created directories.
 */
export function ensureGenerationStoreLayoutDurable(
  project: string,
  options?: GenerationStoreOptions,
): { created: string[] } {
  return ensureGenerationStoreLayoutDurableInternal(project, options, PROD_OPS);
}

/**
 * R169A-FIX-R3 (API-R169A-R3-01): Public typed writer for the index-state
 * sidecar.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-02): This is the ONLY public writer in
 * R169A. Index-state is diagnostics (not graph data, not publication) —
 * writing it does not constitute a publication act. The manifest writer
 * `writeGenerationManifestAtomically` is internal (NOT a publication
 * API); R169B will own `publishPreparedGeneration`.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-01): Calls
 * `prepareIndexStateForWrite(state, project)` BEFORE any filesystem I/O.
 *
 * If preparation or validation fails, NO temp / layout / target is
 * created — the on-disk state is unchanged.
 *
 * On success, writes `state` to `<projectStore>/index-state.json`
 * atomically (temp-rename-fsync pattern, temp file mode 0600).
 *
 * R169A-FIX-R5 (API-R169A-R5-02): The `ops` and `hook` parameters are
 * `@internal` — they exist for test fault injection and race injection
 * only. Production callers MUST omit them.
 *
 * R169A-FIX-R6 (API-R169A-R6-01): Public facade with EXACTLY 3 parameters.
 * The `ops` and `hook` parameters are NOT part of the public API.
 * They are only accessible via the internal (non-exported) function
 * `writeIndexStateAtomicallyInternal`, which tests access through
 * a local cast. The generated `.d.ts` will show only 3 parameters.
 */
export function writeIndexStateAtomically(
  project: string,
  state: IndexAttemptStateV1,
  options?: GenerationStoreOptions,
): void {
  writeIndexStateAtomicallyInternal(project, state, options, PROD_OPS, undefined);
}

// R169A-FIX-R5 (API-R169A-R5-01): The `__test__` export is REMOVED.
// The manifest writer `writeGenerationManifestAtomically` and the
// `prepare*ForWrite` helpers are no longer accessible to production
// code. Tests that need a manifest on disk use the test helper
// `v2/tests/helpers/r169-generation-fixtures.ts` (writeFileSync-based).
// Atomic writer mechanic tests use `writeIndexStateAtomically` (the
// only public writer) which exercises the same internal writer code.
// A source inspection test verifies `__test__` and
// `writeGenerationManifestAtomically` are NOT exported.

// ─── Project listing (section 9.4, future; R169A-FIX OPS-R169A-01) ──────

/**
 * List all projects that have a generation store.
 * Returns an array of project store directory names (SHA-256 hex keys),
 * filtered to the canonical 64-lowercase-hex form and sorted
 * lexicographically.
 *
 * R169A-FIX (OPS-R169A-01):
 *   - Filter to `^[0-9a-f]{64}$` only — non-conforming entries are ignored.
 *   - Sort lexicographically for deterministic output.
 *   - Only ENOENT (store root doesn't exist yet) returns []. EACCES,
 *     EIO, ENOTDIR -> throw GenerationStoreError (fail closed).
 *
 * R169A-FIX-R3 (OPS-R169A-R3-01): The trust root (cacheRoot -> cbm ->
 * projects) is validated BEFORE readdirSync.
 */
export function listProjectStoreKeys(cacheRoot?: string): string[] {
  const phase = "listProjectStoreKeys";
  const root = cacheRoot ?? getCacheRoot();

  // R169A-FIX-R3 (OPS-R169A-R3-01): Validate the trust root BEFORE
  // readdirSync.
  assertGenerationStoreRootTrusted(root, phase);

  let entries;
  try {
    entries = readdirSync(generationStoreRoot(root), { withFileTypes: true });
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return [];
    throw new GenerationStoreError(
      "GENERATION_STORE_CONFIG_ERROR",
      phase,
      "",
      `Failed to read project store root "${generationStoreRoot(root)}": ${(e as Error).message}`,
    );
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort();
}
