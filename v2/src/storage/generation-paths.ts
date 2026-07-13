/**
 * R169B-STEP1 — Generation store path helpers (extracted from generation-store.ts).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This module is the SINGLE home for the generation store's pure path
 * helpers. It was extracted from `generation-store.ts` in R169B-STEP1 to
 * break the module cycle that existed between the public facade
 * (`generation-store.ts`) and the internal I/O harness
 * (`internal/generation-store-io.ts`). The internal module previously
 * imported path helpers from the public facade; the public facade
 * imported the I/O harness from the internal module. That cycle is now
 * broken by extracting the shared path helpers into this leaf module
 * that depends only on `generation-types.ts` and the Node.js standard
 * library.
 *
 * DEPENDENCY DIRECTION (R169B-STEP1):
 *   types -> paths/validation -> internal I/O -> public facades
 *
 *   - This module imports types from `./generation-types.js`.
 *   - This module imports `node:crypto`, `node:path`, and `node:os` —
 *     no other internal modules.
 *   - The validation module (`./generation-validation.js`) imports from
 *     this module.
 *   - The internal I/O module (`./internal/generation-store-io.js`)
 *     imports from this module.
 *   - The public facade module (`./generation-store.js`) re-exports
 *     these helpers for backward compatibility with R169A callers.
 *
 * SECURITY:
 *   - Project names are NEVER used directly as paths. A deterministic
 *     SHA-256 key is used instead (section 6.1 of the R169A spec).
 *   - `legacyCodeDbPath` containment-checks the resolved path against
 *     the cache root. Rejects empty, absolute, separator-containing,
 *     `.` and `..` project names, plus any resolved path that escapes
 *     `cbmCacheDir`.
 *   - `isLexicallyInside` / `isPathInside` are pure lexical checks
 *     (no filesystem access). Use `assertPathInsideNoSymlinks` (in the
 *     validation module) for security-sensitive paths.
 *
 * R169A-FIX (SEC-R169A-01): All path-resolving functions accept an
 * optional `cacheRoot`. When omitted, the real cache root
 * (XDG_CACHE_HOME or ~/.cache) is used. When provided, all derived
 * paths MUST stay inside the injected cacheRoot.
 *
 * R169B-STEP1: This module is NEW. The path helpers were moved here
 * verbatim from `generation-store.ts` (no behavioral changes). The
 * public facade re-exports them so existing R169A callers and tests
 * continue to work without modification.
 */

import { createHash } from "node:crypto";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { homedir } from "node:os";

import {
  GenerationStoreError,
} from "./generation-types.js";

// --- Constants ---

/** The subdirectory under the cache root for all CBM data. */
export const CBM_CACHE_SUBDIR = "codebase-memory-mcp";

/** The subdirectory under CBM_CACHE_SUBDIR for per-project generation stores. */
export const PROJECTS_SUBDIR = "projects";

/** The manifest filename in each project store directory. */
export const MANIFEST_FILENAME = "active-generation.json";

/** The index-state sidecar filename. */
export const INDEX_STATE_FILENAME = "index-state.json";

/** The generations subdirectory name. */
export const GENERATIONS_SUBDIR = "generations";

/** The tmp subdirectory name for staging DBs. */
export const TMP_SUBDIR = "tmp";

// --- Options ---

/**
 * R169A-FIX (SEC-R169A-01): Unified cacheRoot injection.
 * All path-resolving functions accept an optional cacheRoot. When omitted,
 * the real cache root (XDG_CACHE_HOME or ~/.cache) is used. When provided,
 * all derived paths (cbm cache dir, generation store root, project store,
 * generations, tmp, manifest, index-state, legacy DB) MUST stay inside the
 * injected cacheRoot.
 */
export interface GenerationStoreOptions {
  readonly cacheRoot?: string;
}

// --- Path helpers (section 18A) ---

/**
 * Resolve the cache root directory.
 * Uses XDG_CACHE_HOME if set, otherwise ~/.cache.
 * This is the single source of truth — no other code should duplicate
 * the XDG_CACHE_HOME fallback.
 */
export function getCacheRoot(): string {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/**
 * The CBM cache directory: <cacheRoot>/codebase-memory-mcp/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function cbmCacheDir(cacheRoot?: string): string {
  return join(cacheRoot ?? getCacheRoot(), CBM_CACHE_SUBDIR);
}

/**
 * The generation store root: <cacheRoot>/codebase-memory-mcp/projects/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function generationStoreRoot(cacheRoot?: string): string {
  return join(cbmCacheDir(cacheRoot), PROJECTS_SUBDIR);
}

/**
 * Compute a deterministic, path-safe project storage key.
 * Uses SHA-256 of the UTF-8 project name.
 * This prevents path traversal, separator injection, and collisions.
 */
export function projectStorageKey(project: string): string {
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PROJECT_KEY_INVALID",
      "projectStorageKey",
      String(project),
      "Project name must be a non-empty string",
    );
  }
  return createHash("sha256").update(project, "utf8").digest("hex");
}

/**
 * The per-project store directory.
 * Path: <cacheRoot>/codebase-memory-mcp/projects/<sha256(project)>/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot (NOT storeRoot).
 */
export function projectStoreDir(project: string, cacheRoot?: string): string {
  const key = projectStorageKey(project);
  return join(generationStoreRoot(cacheRoot), key);
}

/**
 * The generations directory for a project.
 * Path: <projectStore>/generations/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function generationsDir(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), GENERATIONS_SUBDIR);
}

/**
 * The tmp directory for a project (staging DBs).
 * Path: <projectStore>/tmp/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function tmpDir(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), TMP_SUBDIR);
}

/**
 * The active manifest path for a project.
 * Path: <projectStore>/active-generation.json
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function activeManifestPath(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), MANIFEST_FILENAME);
}

/**
 * The index-state sidecar path for a project.
 * Path: <projectStore>/index-state.json
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function indexStatePath(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), INDEX_STATE_FILENAME);
}

/**
 * The legacy code DB path (existing behavior, kept for compatibility).
 * Path: <cacheRoot>/codebase-memory-mcp/<project>.db
 *
 * R169A-FIX (SEC-R169A-01): containment-checks the resolved path against
 * the cache root. Rejects:
 *   - empty project
 *   - absolute project (e.g. "/etc/passwd")
 *   - "../escape" project (path traversal)
 *   - any project whose resolved path escapes cbmCacheDir
 *
 * R169A-FIX (API-R169A-02): accepts an optional injected cacheRoot so
 * the resolver uses the same cacheRoot for BOTH generation and legacy
 * paths. The injected cacheRoot is also used by the resolver's legacy
 * containment check.
 *
 * For ordinary project names ("test-project", etc.) with the
 * real cacheRoot, this produces the same path as the sqlite-ro legacy DB path in
 * sqlite-ro.ts — back-compat is preserved.
 */
export function legacyCodeDbPath(project: string, cacheRoot?: string): string {
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      String(project),
      "Project name must be a non-empty string",
    );
  }
  if (isAbsolute(project)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not be absolute: ${project}`,
    );
  }
  // Reject any path separator (forward or backward slash). A valid project
  // name is a single path component.
  if (project.includes("/") || project.includes("\\")) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not contain path separators: ${project}`,
    );
  }
  if (project === "." || project === "..") {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not be "." or ".."`,
    );
  }

  const base = cbmCacheDir(cacheRoot);
  const candidate = resolve(base, `${project}.db`);

  // Defense-in-depth: lexical containment on the resolved candidate.
  // For valid project names this always passes; for a maliciously
  // crafted name that survives the checks above (none currently known),
  // this would still reject.
  if (!isLexicallyInside(base, candidate)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Resolved legacy path escapes cache root: ${candidate}`,
    );
  }
  return candidate;
}

// --- Path safety (R169A-FIX SEC-R169A-02) ---

/**
 * R169A-FIX (SEC-R169A-02): Lexical containment check.
 *
 * Returns true iff `candidate` is lexically inside `root` (i.e. the
 * relative path from root to candidate does not start with ".." and is
 * not absolute). This is the same logic as the original isPathInside.
 *
 * This function does NOT touch the filesystem and does NOT detect
 * symlinks. Use assertPathInsideNoSymlinks (in the validation module)
 * for security-sensitive paths.
 */
export function isLexicallyInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}

/**
 * Back-compat alias: isPathInside = isLexicallyInside.
 * Tests and external callers may continue to use the old name.
 */
export const isPathInside = isLexicallyInside;
