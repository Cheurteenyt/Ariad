/**
 * R169A — Atomic Generation Publication: generation store core.
 *
 * STATUS: FOUNDATION / INACTIVE
 * This module provides path helpers, manifest validation, a read-only
 * resolver, and an atomic JSON writer. No production code calls these
 * functions yet — the indexer and readers still use the legacy DB path.
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
 *   - Path traversal (`..`) and absolute paths in dbFile are rejected.
 *   - dbFile MUST be the canonical form `generations/generation-<uuid>.db`
 *     (R169A-FIX DATA-R169A-01: no aliasing).
 *   - Legacy DB path is containment-checked against cacheRoot
 *     (R169A-FIX SEC-R169A-01: legacyCodeDbPath rejects ../escape, absolute).
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { homedir } from "node:os";

import {
  GenerationManifestV1,
  MANIFEST_V1_KEYS,
  ResolvedCodeDb,
  GenerationStoreError,
  GenerationStoreErrorCode,
} from "./generation-types.js";

// Re-export types for convenience
export type { GenerationManifestV1, ResolvedCodeDb } from "./generation-types.js";
export { GenerationStoreError } from "./generation-types.js";

// ─── Constants ──────────────────────────────────────────────────────────

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

// ─── Options ────────────────────────────────────────────────────────────

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

// ─── Injectable filesystem operations ───────────────────────────────────

/**
 * R169A-FIX (DUR-R169A-02): Injectable atomic file operations.
 *
 * Production code uses the real Node.js `fs` bindings (see PROD_OPS below).
 * Tests inject controlled failures at specific checkpoints (open, write,
 * fsync, close, rename, dir-fsync) to verify the atomic writer's durability
 * contract under fault.
 */
export interface AtomicFileOps {
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}

/** Production filesystem operations: thin wrappers over node:fs. */
const PROD_OPS: AtomicFileOps = {
  openSync: (p, f, m) => openSync(p, f, m),
  writeSync: (fd, b, o, l, p) => writeSync(fd, b, o, l, p),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  renameSync: (f, t) => renameSync(f, t),
  unlinkSync: (p) => unlinkSync(p),
  mkdirSync: (p, opts) => mkdirSync(p, opts),
};

// ─── Path helpers (section 18A) ─────────────────────────────────────────

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
 * For ordinary project names ("test-project", "プロジェクト") with the
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

// ─── Path safety (R169A-FIX SEC-R169A-02) ───────────────────────────────

/**
 * R169A-FIX (SEC-R169A-02): Lexical containment check.
 *
 * Returns true iff `candidate` is lexically inside `root` (i.e. the
 * relative path from root to candidate does not start with ".." and is
 * not absolute). This is the same logic as the original isPathInside.
 *
 * This function does NOT touch the filesystem and does NOT detect
 * symlinks. Use assertPathInsideNoSymlinks for security-sensitive paths.
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

/**
 * R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check.
 *
 * Walks every path component from `root` to `candidate` with lstatSync.
 * Rejects if ANY component in the chain is a symbolic link. After the
 * walk, uses realpathSync.native on both endpoints for a final
 * containment check.
 *
 * Error policy (fail-closed):
 *   - ENOENT  → treat as "absent"; return without throwing. The caller
 *               is responsible for distinguishing "missing target" from
 *               "present target" via lstatSync of the final component.
 *   - EACCES  → fail closed with PATH_TRAVERSAL_REJECTED
 *   - EIO     → fail closed with PATH_TRAVERSAL_REJECTED
 *   - ENOTDIR → fail closed with PATH_TRAVERSAL_REJECTED
 *   - ELOOP   → fail closed with PATH_TRAVERSAL_REJECTED
 *   - any other error → fail closed with PATH_TRAVERSAL_REJECTED
 *
 * The `symlinkCode` argument controls which error code is thrown when a
 * symlink is detected — typically MANIFEST_SYMLINK_REJECTED for the
 * manifest path or GENERATION_TARGET_SYMLINK_REJECTED for the target DB.
 * Traversal errors always use PATH_TRAVERSAL_REJECTED.
 */
export function assertPathInsideNoSymlinks(
  root: string,
  candidate: string,
  project: string,
  phase: string,
  symlinkCode: GenerationStoreErrorCode = "MANIFEST_SYMLINK_REJECTED",
): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);

  // If rel is "" the candidate IS the root, which is trivially inside.
  // If rel starts with ".." or is absolute, the candidate is outside
  // the root lexically — reject before touching the filesystem.
  if (rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `Path escapes root lexically: root=${resolvedRoot}, candidate=${resolvedCandidate}`,
    );
  }

  // Walk each component from root to candidate. The candidate itself is
  // included as the final component (rel.split gives all non-empty parts).
  if (rel !== "") {
    const parts = rel.split(sep).filter(Boolean);
    let current = resolvedRoot;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (e) {
        const errCode = (e as NodeJS.ErrnoException).code;
        if (errCode === "ENOENT") {
          // This component (and everything below it) does not exist.
          // The caller will separately check existence; we just exit
          // the walk without error.
          return;
        }
        // EACCES, EIO, ENOTDIR, ELOOP, etc. — fail closed.
        throw new GenerationStoreError(
          "PATH_TRAVERSAL_REJECTED",
          phase,
          project,
          `Cannot stat path component "${current}": ${(e as Error).message}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new GenerationStoreError(
          symlinkCode,
          phase,
          project,
          `Symlink detected in path chain at "${current}"`,
        );
      }
    }
  }

  // Final realpath containment check. If the candidate does not exist
  // on disk, realpathSync will throw ENOENT — treat as "absent" and
  // return without error. Any other error → fail closed.
  let realCandidate: string;
  try {
    realCandidate = realpathSync.native(resolvedCandidate);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `realpath failed for candidate "${resolvedCandidate}": ${(e as Error).message}`,
    );
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolvedRoot);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `realpath failed for root "${resolvedRoot}": ${(e as Error).message}`,
    );
  }
  const realRel = relative(realRoot, realCandidate);
  if (realRel === ".." || realRel.startsWith(".." + sep) || isAbsolute(realRel)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `Realpath escapes root: realRoot=${realRoot}, realCandidate=${realCandidate}`,
    );
  }
}

/**
 * R169A-FIX (SEC-R169A-02): Reject a path if it is a symlink.
 * Unlike assertPathInsideNoSymlinks, this only checks the final path
 * component (not the chain) and is intended for use after existence is
 * already confirmed.
 *
 * Error policy (fail-closed):
 *   - ENOENT  → return silently (path does not exist)
 *   - EACCES, EIO, ENOTDIR, ELOOP, etc. → throw (fail closed)
 *   - isSymbolicLink → throw with the supplied `code`
 */
export function assertNotSymlink(
  path: string,
  code: GenerationStoreErrorCode,
  project: string,
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    // R169A-FIX (SEC-R169A-02): do NOT swallow EACCES/EIO/ENOTDIR/ELOOP.
    throw new GenerationStoreError(
      code,
      "assertNotSymlink",
      project,
      `Cannot stat "${path}": ${(e as Error).message}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new GenerationStoreError(
      code,
      "assertNotSymlink",
      project,
      `Symlink rejected: ${path}`,
    );
  }
}

// ─── Manifest parser and validator (section 18C) ────────────────────────

/** UUID v4 regex (canonical form, lowercase). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256 regex (64 lowercase hex). */
const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * ISO-8601 timestamp with timezone regex. Captures year/month/day and
 * hour/minute/second components for calendar validation.
 */
const ISO8601_WITH_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * R169A-FIX (VALID-R169A-02): Safe-integer check for numeric manifest fields.
 * Number.isSafeInteger rejects Infinity, NaN, and integers beyond
 * Number.MAX_SAFE_INTEGER (2^53 - 1). Number.isInteger accepts the latter.
 */
function assertSafeNonNegativeInt(
  value: unknown,
  field: string,
  project: string,
  phase: string,
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `${field} must be a safe non-negative integer, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * R169A-FIX (VALID-R169A-01): Calendar-valid timestamp check.
 *
 * After the regex check, also verifies that:
 *   - Date.parse accepts the value (rejects malformed that slipped past)
 *   - month is 1-12
 *   - day is valid for the (year, month) pair (handles leap years)
 *   - hour is 0-23
 *   - minute is 0-59
 *   - second is 0-59 (no leap seconds — POSIX semantics)
 */
function assertCalendarValidTimestamp(
  value: string,
  project: string,
  phase: string,
): void {
  const match = ISO8601_WITH_TZ_REGEX.exec(value);
  if (!match) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt must match ISO-8601 with timezone, got: ${JSON.stringify(value)}`,
    );
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  // Date.parse / new Date(value) will accept many invalid calendar dates
  // by rolling them over (e.g. 2026-13-01 → 2027-01-01). Verify each
  // component explicitly.
  if (month < 1 || month > 12) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid month: ${month} (value=${JSON.stringify(value)})`,
    );
  }
  // Days in the given month, accounting for leap years.
  // new Date(Date.UTC(year, month, 0)).getUTCDate() gives the last day
  // of `month` (1-indexed) for `year`. This correctly handles Feb 29
  // in leap years (2028) and rejects it in non-leap years (2026).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid day: ${day} for year ${year} month ${month} (value=${JSON.stringify(value)})`,
    );
  }
  if (hour < 0 || hour > 23) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid hour: ${hour} (value=${JSON.stringify(value)})`,
    );
  }
  if (minute < 0 || minute > 59) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid minute: ${minute} (value=${JSON.stringify(value)})`,
    );
  }
  if (second < 0 || second > 59) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid second: ${second} (value=${JSON.stringify(value)})`,
    );
  }

  // Final belt-and-suspenders: Date must parse to a valid epoch.
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt does not parse to a valid Date: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Parse and strictly validate a generation manifest.
 *
 * Validation rules (section 6.3, updated by R169A-FIX):
 *   - Must be a JSON object (not array/null)
 *   - formatVersion must be 1
 *   - Exact key set (no missing, no extra)
 *   - project must match expectedProject
 *   - generationId must be a canonical UUID v4
 *   - dbFile MUST equal `generations/generation-<generationId>.db`
 *     (R169A-FIX DATA-R169A-01: canonical form, no aliasing)
 *   - createdAt must be ISO-8601 with timezone AND calendar-valid
 *     (R169A-FIX VALID-R169A-01)
 *   - rootFingerprint must be non-empty string
 *   - semantics/discovery versions must be SAFE integers >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - counts must be SAFE integers >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - sizeBytes must be SAFE integer >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - sha256 must be 64 lowercase hex
 *   - No multiline values
 *
 * Throws GenerationStoreError on any validation failure.
 */
export function validateGenerationManifest(
  value: unknown,
  expectedProject: string,
): GenerationManifestV1 {
  const phase = "validateGenerationManifest";

  // Must be an object
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "Manifest must be a JSON object",
    );
  }

  const obj = value as Record<string, unknown>;

  // Exact key set
  const actualKeys = new Set(Object.keys(obj));
  const missingKeys = Array.from(MANIFEST_V1_KEYS).filter((k) => !actualKeys.has(k));
  const extraKeys = Array.from(actualKeys).filter((k) => !MANIFEST_V1_KEYS.has(k));

  if (missingKeys.length > 0 || extraKeys.length > 0) {
    const details: string[] = [];
    if (missingKeys.length > 0) details.push(`missing: ${missingKeys.join(", ")}`);
    if (extraKeys.length > 0) details.push(`extra: ${extraKeys.join(", ")}`);
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `Key set mismatch (${details.join("; ")})`,
    );
  }

  // formatVersion
  if (obj.formatVersion !== 1) {
    throw new GenerationStoreError(
      "MANIFEST_UNSUPPORTED_VERSION",
      phase,
      expectedProject,
      `formatVersion must be 1, got: ${JSON.stringify(obj.formatVersion)}`,
    );
  }

  // project
  if (typeof obj.project !== "string" || obj.project !== expectedProject) {
    throw new GenerationStoreError(
      "MANIFEST_PROJECT_MISMATCH",
      phase,
      expectedProject,
      `project must be "${expectedProject}", got: ${JSON.stringify(obj.project)}`,
    );
  }

  // generationId — UUID v4
  if (typeof obj.generationId !== "string" || !UUID_V4_REGEX.test(obj.generationId)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `generationId must be a canonical UUID v4, got: ${JSON.stringify(obj.generationId)}`,
    );
  }

  // dbFile — R169A-FIX (DATA-R169A-01): canonical form
  if (typeof obj.dbFile !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "dbFile must be a string",
    );
  }
  const expectedDbFile = `generations/generation-${obj.generationId}.db`;
  if (obj.dbFile !== expectedDbFile) {
    throw new GenerationStoreError(
      "MANIFEST_DBFILE_NOT_CANONICAL",
      phase,
      expectedProject,
      `dbFile must be canonical "${expectedDbFile}", got: ${JSON.stringify(obj.dbFile)}`,
    );
  }

  // createdAt — R169A-FIX (VALID-R169A-01): regex + calendar check
  if (typeof obj.createdAt !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "createdAt must be a string",
    );
  }
  assertCalendarValidTimestamp(obj.createdAt, expectedProject, phase);

  // rootFingerprint — non-empty string
  if (typeof obj.rootFingerprint !== "string" || obj.rootFingerprint.length === 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "rootFingerprint must be a non-empty string",
    );
  }

  // R169A-FIX (VALID-R169A-02): Safe-integer checks
  assertSafeNonNegativeInt(obj.extractorSemanticsVersion, "extractorSemanticsVersion", expectedProject, phase);
  assertSafeNonNegativeInt(obj.discoveryPolicyVersion, "discoveryPolicyVersion", expectedProject, phase);
  assertSafeNonNegativeInt(obj.nodeCount, "nodeCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.edgeCount, "edgeCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.fileCount, "fileCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.sizeBytes, "sizeBytes", expectedProject, phase);

  // sha256 — 64 lowercase hex
  if (typeof obj.sha256 !== "string" || !SHA256_REGEX.test(obj.sha256)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `sha256 must be 64 lowercase hex chars, got: ${JSON.stringify(obj.sha256)}`,
    );
  }

  // No multiline values
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string" && (val.includes("\n") || val.includes("\r"))) {
      throw new GenerationStoreError(
        "MANIFEST_SCHEMA_ERROR",
        phase,
        expectedProject,
        `${key} must not contain newlines`,
      );
    }
  }

  // All checks passed — return the validated manifest
  return obj as unknown as GenerationManifestV1;
}

/**
 * Read and parse a manifest from disk.
 * Throws on read error, JSON parse error, or validation error.
 */
export function parseGenerationManifest(
  manifestPath: string,
  expectedProject: string,
): GenerationManifestV1 {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new GenerationStoreError(
      "MANIFEST_PARSE_ERROR",
      "parseGenerationManifest",
      expectedProject,
      `Failed to read manifest: ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GenerationStoreError(
      "MANIFEST_PARSE_ERROR",
      "parseGenerationManifest",
      expectedProject,
      `Failed to parse JSON: ${(e as Error).message}`,
    );
  }

  return validateGenerationManifest(parsed, expectedProject);
}

// ─── Resolver (section 18D) ─────────────────────────────────────────────

/**
 * Resolve the active code DB for a project.
 *
 * Contract:
 *   - manifest valid → generation
 *   - manifest absent + legacy exists → legacy
 *   - manifest absent + no legacy → missing
 *   - manifest invalid → FAIL CLOSED (never fall back to legacy)
 *   - manifest target missing → FAIL CLOSED
 *   - manifest target outside store → FAIL CLOSED
 *   - manifest target not a regular file → FAIL CLOSED
 *     (R169A-FIX DATA-R169A-01)
 *   - manifest project mismatch → FAIL CLOSED
 *   - symlink manifest or any parent → rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - symlink generation target or any parent → rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - legacy path fails validation → LEGACY_SOURCE_OPEN_FAILED
 *     (R169A-FIX API-R169A-02: no silent acceptance)
 *
 * R169A-FIX (SEC-R169A-01): The `cacheRoot` option, when provided, is
 * used for BOTH the generation store paths AND the legacy DB path.
 * Tests pass an injected cacheRoot to avoid touching the real HOME.
 */
export function resolveActiveCodeDb(
  project: string,
  options?: GenerationStoreOptions,
): ResolvedCodeDb {
  const phase = "resolveActiveCodeDb";
  const cacheRoot = options?.cacheRoot;
  const manifestPath = activeManifestPath(project, cacheRoot);
  const legacyPath = legacyCodeDbPath(project, cacheRoot);

  // R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check
  // on the manifest path. Walk from generationStoreRoot (a higher trust
  // root) all the way to the manifest file. This catches symlinks at
  // every level: the project store dir, the CBM cache dir, etc.
  // Walking from projectDir would miss a symlink AT projectDir itself.
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
      // EACCES, EIO, ENOTDIR, etc. → fail closed.
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        project,
        `Cannot stat manifest path "${manifestPath}": ${(e as Error).message}`,
      );
    }
  }

  if (manifestExists) {
    // Parse and validate the manifest — fail closed on any error
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
    // store root. Walking from projectDir would miss a symlink at the
    // project store dir or at the generations dir parent.
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
  // R169A-FIX (API-R169A-02): Validate the legacy path the same way
  // we validate generation paths. Any failure → LEGACY_SOURCE_OPEN_FAILED.
  try {
    assertPathInsideNoSymlinks(
      cbmCacheDir(cacheRoot),
      legacyPath,
      project,
      phase,
      "LEGACY_SOURCE_OPEN_FAILED",
    );
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      // Re-wrap as LEGACY_SOURCE_OPEN_FAILED unless it already is.
      if (e.code !== "LEGACY_SOURCE_OPEN_FAILED") {
        throw new GenerationStoreError(
          "LEGACY_SOURCE_OPEN_FAILED",
          phase,
          project,
          `Legacy path failed validation: ${e.message}`,
        );
      }
      throw e;
    }
    throw new GenerationStoreError(
      "LEGACY_SOURCE_OPEN_FAILED",
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
    // EACCES, EIO, etc. → fail closed.
    throw new GenerationStoreError(
      "LEGACY_SOURCE_OPEN_FAILED",
      phase,
      project,
      `Cannot stat legacy DB "${legacyPath}": ${(e as Error).message}`,
    );
  }

  if (legacyStat.isSymbolicLink()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_OPEN_FAILED",
      phase,
      project,
      `Legacy DB is a symlink: ${legacyPath}`,
    );
  }
  if (!legacyStat.isFile()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_OPEN_FAILED",
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

// ─── Atomic JSON writer (section 18E, R169A-FIX DUR-R169A-01/02) ────────

/**
 * Write a JSON file atomically using the temp-rename-fsync pattern.
 *
 * R169A-FIX (DUR-R169A-02) — Serialization safety:
 *   1. Serialize to JSON BEFORE any filesystem mutation. If
 *      JSON.stringify returns a non-string (e.g. for BigInt without
 *      a replacer), throw ATOMIC_SERIALIZATION_FAILED before opening
 *      any file.
 *   2. Encode as UTF-8 Buffer.
 *   3. Write in a loop with offset accounting. If writeSync returns
 *      <=0, throw ATOMIC_SHORT_WRITE (partial write detected).
 *
 * Steps:
 *   1. Serialize JSON to Buffer (fails → ATOMIC_SERIALIZATION_FAILED)
 *   2. Create a temp file in the SAME directory (exclusive create, 0600)
 *   3. Write the complete payload in a loop
 *      (write fails → ATOMIC_WRITE_FAILED; writeSync ≤0 → ATOMIC_SHORT_WRITE)
 *   4. fsync the temp file (fails → ATOMIC_FSYNC_FAILED, temp cleaned up)
 *   5. close the temp file
 *   6. rename temp → target (fails → ATOMIC_RENAME_FAILED, temp cleaned up)
 *   7. fsync the directory
 *      (fails → ATOMIC_DURABILITY_UNKNOWN — see note below)
 *
 * R169A-FIX (DUR-R169A-01) — Directory fsync:
 *   On POSIX, rename is atomic but NOT durable until the parent directory
 *   has been fsynced. If we cannot fsync the directory after a successful
 *   rename, we cannot guarantee the rename is durable: a crash may either
 *   leave the old target in place OR the new target. We throw
 *   ATOMIC_DURABILITY_UNKNOWN with a message instructing the caller to
 *   re-read the target and diagnose. We do NOT silently succeed.
 *
 * On any failure (except ATOMIC_DURABILITY_UNKNOWN, where the rename has
 * already happened), the temp file is cleaned up and the original file
 * (if any) remains unchanged.
 *
 * The optional `ops` parameter (R169A-FIX DUR-R169A-02) allows tests to
 * inject controlled failures at specific checkpoints. Production callers
 * omit `ops` to use the real node:fs bindings.
 */
export function writeJsonAtomically(
  targetPath: string,
  value: unknown,
  ops: AtomicFileOps = PROD_OPS,
): void {
  const phase = "writeJsonAtomically";
  const dir = resolve(targetPath, "..");
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);

  // R169A-FIX (DUR-R169A-02): Serialize BEFORE any filesystem mutation.
  // JSON.stringify can fail in two ways:
  //   1. It throws (e.g. for BigInt without a replacer, circular refs)
  //   2. It returns undefined (for undefined/functions/symbols as the
  //      top-level value)
  // Both cases must throw ATOMIC_SERIALIZATION_FAILED before any file
  // is opened — otherwise a partial temp file could be left behind.
  let serialized: string;
  try {
    const r = JSON.stringify(value, null, 2);
    if (typeof r !== "string") {
      throw new Error(`JSON.stringify returned non-string (typeof=${typeof r})`);
    }
    serialized = r;
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_SERIALIZATION_FAILED",
      phase,
      "",
      `JSON serialization failed: ${(e as Error).message}`,
    );
  }
  const payload = Buffer.from(serialized + "\n", "utf8");

  // Ensure directory exists
  ops.mkdirSync(dir, { recursive: true });

  let fd: number | null = null;
  let renameSucceeded = false;
  try {
    // Exclusive create — fails if the file already exists
    try {
      fd = ops.openSync(tmpPath, "wx", 0o600);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_WRITE_FAILED",
        phase,
        "",
        `Failed to open temp file exclusively: ${(e as Error).message}`,
      );
    }

    // R169A-FIX (DUR-R169A-02): Loop write with offset accounting.
    let offset = 0;
    while (offset < payload.length) {
      let written: number;
      try {
        written = ops.writeSync(fd, payload, offset, payload.length - offset, null);
      } catch (e) {
        throw new GenerationStoreError(
          "ATOMIC_WRITE_FAILED",
          phase,
          "",
          `writeSync failed at offset ${offset}/${payload.length}: ${(e as Error).message}`,
        );
      }
      if (written <= 0) {
        throw new GenerationStoreError(
          "ATOMIC_SHORT_WRITE",
          phase,
          "",
          `writeSync returned ${written} at offset ${offset}/${payload.length}`,
        );
      }
      offset += written;
    }

    // fsync the temp file
    try {
      ops.fsyncSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_FSYNC_FAILED",
        phase,
        "",
        `Failed to fsync temp file: ${(e as Error).message}`,
      );
    }

    try {
      ops.closeSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_WRITE_FAILED",
        phase,
        "",
        `Failed to close temp file: ${(e as Error).message}`,
      );
    }
    fd = null;

    // rename temp → target
    try {
      ops.renameSync(tmpPath, targetPath);
      renameSucceeded = true;
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_RENAME_FAILED",
        phase,
        "",
        `Failed to rename temp to target: ${(e as Error).message}`,
      );
    }

    // R169A-FIX (DUR-R169A-01): fsync the directory.
    // If this fails, the rename has already happened — the target may
    // already be the new file. We cannot silently succeed because
    // durability is unknown. Throw ATOMIC_DURABILITY_UNKNOWN so the
    // caller knows to re-read and diagnose.
    let dirFd: number | null = null;
    try {
      dirFd = ops.openSync(dir, "r");
      ops.fsyncSync(dirFd);
      ops.closeSync(dirFd);
      dirFd = null;
    } catch (e) {
      // Rename succeeded but dir fsync failed. The target may already
      // be the new file. Caller MUST re-read and diagnose.
      throw new GenerationStoreError(
        "ATOMIC_DURABILITY_UNKNOWN",
        phase,
        "",
        `Directory fsync failed after rename — target may already be new, caller must re-read and diagnose: ${(e as Error).message}`,
      );
    } finally {
      if (dirFd !== null) {
        try { ops.closeSync(dirFd); } catch { /* best effort */ }
      }
    }
  } catch (e) {
    // Clean up temp file on any failure.
    // If rename succeeded, the temp file no longer exists at tmpPath
    // (it was renamed to the target). unlinkSync will throw ENOENT,
    // which we swallow.
    if (fd !== null) {
      try { ops.closeSync(fd); } catch { /* best effort */ }
    }
    if (!renameSucceeded) {
      try { ops.unlinkSync(tmpPath); } catch { /* best effort */ }
    }

    if (e instanceof GenerationStoreError) throw e;

    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      "",
      `Failed to write JSON atomically: ${(e as Error).message}`,
    );
  }
}

// ─── Project listing (section 9.4, future; R169A-FIX OPS-R169A-01) ──────

/**
 * List all projects that have a generation store.
 * Returns an array of project store directory names (SHA-256 hex keys),
 * filtered to the canonical 64-lowercase-hex form and sorted
 * lexicographically.
 *
 * R169A-FIX (OPS-R169A-01):
 *   - Filter to `^[0-9a-f]{64}$` only — non-conforming entries (e.g.
 *     stray files, manifest filenames in the wrong place) are ignored.
 *   - Sort lexicographically for deterministic output.
 *   - Only ENOENT (store root doesn't exist yet) returns []. EACCES,
 *     EIO, ENOTDIR → throw GenerationStoreError (fail closed).
 *   - The parameter is now `cacheRoot` (NOT storeRoot) — same as the
 *     other path helpers.
 */
export function listProjectStoreKeys(cacheRoot?: string): string[] {
  const root = generationStoreRoot(cacheRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return [];
    throw new GenerationStoreError(
      "GENERATION_STORE_CONFIG_ERROR",
      "listProjectStoreKeys",
      "",
      `Failed to read project store root "${root}": ${(e as Error).message}`,
    );
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort();
}
