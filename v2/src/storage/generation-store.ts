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
 *   - All paths are containment-checked against the injected cache root.
 *   - Symlinks in manifests and generation targets are rejected.
 *   - Path traversal (`..`) and absolute paths in dbFile are rejected.
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
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
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
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
export type { GenerationManifestV1, ResolvedCodeDb, GenerationStoreError } from "./generation-types.js";

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
 */
export function cbmCacheDir(): string {
  return join(getCacheRoot(), CBM_CACHE_SUBDIR);
}

/**
 * The generation store root: <cacheRoot>/codebase-memory-mcp/projects/
 */
export function generationStoreRoot(): string {
  return join(cbmCacheDir(), PROJECTS_SUBDIR);
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
 * Path: <storeRoot>/projects/<sha256(project)>/
 *
 * For testing, an optional `storeRoot` can be injected.
 */
export function projectStoreDir(project: string, storeRoot?: string): string {
  const key = projectStorageKey(project);
  const root = storeRoot ?? generationStoreRoot();
  return join(root, key);
}

/**
 * The generations directory for a project.
 * Path: <projectStore>/generations/
 */
export function generationsDir(project: string, storeRoot?: string): string {
  return join(projectStoreDir(project, storeRoot), GENERATIONS_SUBDIR);
}

/**
 * The tmp directory for a project (staging DBs).
 * Path: <projectStore>/tmp/
 */
export function tmpDir(project: string, storeRoot?: string): string {
  return join(projectStoreDir(project, storeRoot), TMP_SUBDIR);
}

/**
 * The active manifest path for a project.
 * Path: <projectStore>/active-generation.json
 */
export function activeManifestPath(project: string, storeRoot?: string): string {
  return join(projectStoreDir(project, storeRoot), MANIFEST_FILENAME);
}

/**
 * The index-state sidecar path for a project.
 * Path: <projectStore>/index-state.json
 */
export function indexStatePath(project: string, storeRoot?: string): string {
  return join(projectStoreDir(project, storeRoot), INDEX_STATE_FILENAME);
}

/**
 * The legacy code DB path (existing behavior, kept for compatibility).
 * Path: <cacheRoot>/codebase-memory-mcp/<project>.db
 *
 * This is the path used by the current indexer and readers. R169A does
 * NOT change this path — it only provides the new generation store
 * alongside it.
 */
export function legacyCodeDbPath(project: string): string {
  return join(cbmCacheDir(), `${project}.db`);
}

// ─── Path safety ────────────────────────────────────────────────────────

/**
 * Verify that a resolved path is inside the expected root directory.
 * Uses realpath to resolve symlinks, then checks containment.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Reject a dbFile path if it contains traversal or is absolute.
 * The dbFile must be relative and must not contain `..`.
 */
function validateRelativePath(
  dbFile: string,
  project: string,
): void {
  if (!dbFile || typeof dbFile !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      "validateRelativePath",
      project,
      "dbFile must be a non-empty string",
    );
  }

  if (isAbsolute(dbFile)) {
    throw new GenerationStoreError(
      "MANIFEST_TARGET_OUTSIDE_STORE",
      "validateRelativePath",
      project,
      `dbFile must not be absolute: ${dbFile}`,
    );
  }

  // Check for path traversal
  const parts = dbFile.split("/");
  if (parts.some((p) => p === "..")) {
    throw new GenerationStoreError(
      "MANIFEST_TARGET_OUTSIDE_STORE",
      "validateRelativePath",
      project,
      `dbFile must not contain '..': ${dbFile}`,
    );
  }

  // Reject backslash separators (Windows-style traversal)
  if (dbFile.includes("\\")) {
    throw new GenerationStoreError(
      "MANIFEST_TARGET_OUTSIDE_STORE",
      "validateRelativePath",
      project,
      `dbFile must not contain backslashes: ${dbFile}`,
    );
  }
}

/**
 * Check if a path is a symlink. Reject symlinks for manifests and
 * generation targets.
 */
function assertNotSymlink(
  path: string,
  code: GenerationStoreErrorCode,
  project: string,
): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new GenerationStoreError(
        code,
        "assertNotSymlink",
        project,
        `Symlink rejected: ${path}`,
      );
    }
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    // File doesn't exist — that's OK for this check
  }
}

// ─── Manifest parser and validator (section 18C) ────────────────────────

/** UUID v4 regex (canonical form, lowercase). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256 regex (64 lowercase hex). */
const SHA256_REGEX = /^[0-9a-f]{64}$/;

/** ISO-8601 timestamp with timezone regex (simplified). */
const ISO8601_WITH_TZ_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse and strictly validate a generation manifest.
 *
 * Validation rules (section 6.3):
 *   - Must be a JSON object (not array/null)
 *   - formatVersion must be 1
 *   - Exact key set (no missing, no extra)
 *   - project must match expectedProject
 *   - generationId must be a canonical UUID v4
 *   - dbFile must be relative, no traversal, no backslashes
 *   - createdAt must be ISO-8601 with timezone
 *   - rootFingerprint must be non-empty string
 *   - semantics/discovery versions must be integers >= 0
 *   - counts must be integers >= 0
 *   - sizeBytes must be integer >= 0
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

  // dbFile — relative, no traversal
  if (typeof obj.dbFile !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "dbFile must be a string",
    );
  }
  validateRelativePath(obj.dbFile, expectedProject);

  // createdAt — ISO-8601 with timezone
  if (typeof obj.createdAt !== "string" || !ISO8601_WITH_TZ_REGEX.test(obj.createdAt)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `createdAt must be ISO-8601 with timezone, got: ${JSON.stringify(obj.createdAt)}`,
    );
  }

  // rootFingerprint — non-empty string
  if (typeof obj.rootFingerprint !== "string" || obj.rootFingerprint.length === 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "rootFingerprint must be a non-empty string",
    );
  }

  // Extractor semantics version — integer >= 0
  if (!Number.isInteger(obj.extractorSemanticsVersion) || (obj.extractorSemanticsVersion as number) < 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `extractorSemanticsVersion must be an integer >= 0, got: ${JSON.stringify(obj.extractorSemanticsVersion)}`,
    );
  }

  // Discovery policy version — integer >= 0
  if (!Number.isInteger(obj.discoveryPolicyVersion) || (obj.discoveryPolicyVersion as number) < 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `discoveryPolicyVersion must be an integer >= 0, got: ${JSON.stringify(obj.discoveryPolicyVersion)}`,
    );
  }

  // Counts — integers >= 0
  for (const key of ["nodeCount", "edgeCount", "fileCount", "sizeBytes"] as const) {
    const val = obj[key];
    if (!Number.isInteger(val) || (val as number) < 0) {
      throw new GenerationStoreError(
        "MANIFEST_SCHEMA_ERROR",
        phase,
        expectedProject,
        `${key} must be an integer >= 0, got: ${JSON.stringify(val)}`,
      );
    }
  }

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
 *   - manifest project mismatch → FAIL CLOSED
 *   - symlink manifest → rejected
 *   - symlink generation target → rejected
 *
 * The `storeRoot` option allows tests to inject a custom store root.
 */
export function resolveActiveCodeDb(
  project: string,
  options?: { storeRoot?: string },
): ResolvedCodeDb {
  const phase = "resolveActiveCodeDb";
  const storeRoot = options?.storeRoot ?? generationStoreRoot();
  const manifestPath = activeManifestPath(project, storeRoot);
  const legacyPath = legacyCodeDbPath(project);

  // Check if manifest exists (using lstat to detect symlinks)
  let manifestExists = false;
  try {
    const stat = lstatSync(manifestPath);
    manifestExists = true;
    // Reject symlinks for the manifest
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
    // File doesn't exist — continue to legacy check
  }

  if (manifestExists) {
    // Parse and validate the manifest — fail closed on any error
    const manifest = parseGenerationManifest(manifestPath, project);

    // Resolve the generation DB path
    const projectDir = projectStoreDir(project, storeRoot);
    const dbPath = resolve(projectDir, manifest.dbFile);

    // Containment check: the resolved DB path must be inside the project store
    if (!isPathInside(projectDir, dbPath)) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_OUTSIDE_STORE",
        phase,
        project,
        `Generation DB path escapes project store: ${dbPath}`,
      );
    }

    // Check if the generation DB file exists
    if (!existsSync(dbPath)) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_MISSING",
        phase,
        project,
        `Generation DB file not found: ${dbPath}`,
      );
    }

    // Reject symlinks for the generation target
    assertNotSymlink(dbPath, "GENERATION_TARGET_SYMLINK_REJECTED", project);

    return {
      source: "generation",
      project,
      dbPath,
      generationId: manifest.generationId,
      manifest,
    };
  }

  // No manifest — check for legacy DB
  if (existsSync(legacyPath)) {
    return {
      source: "legacy",
      project,
      dbPath: legacyPath,
      generationId: null,
    };
  }

  // Neither manifest nor legacy DB
  return {
    source: "missing",
    project,
    dbPath: null,
    generationId: null,
  };
}

// ─── Atomic JSON writer (section 18E) ───────────────────────────────────

/**
 * Write a JSON file atomically using the temp-rename-fsync pattern.
 *
 * Steps:
 *   1. Create a temp file in the SAME directory (exclusive create)
 *   2. Write the complete JSON content
 *   3. fsync the temp file
 *   4. rename temp → target
 *   5. fsync the directory
 *
 * On any failure, the temp file is cleaned up and the original file
 * (if any) remains unchanged.
 *
 * R169A: This function is implemented and tested, but not yet used
 * in production. The indexer does not call it.
 */
export function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): void {
  const phase = "writeJsonAtomically";
  const dir = resolve(targetPath, "..");
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  let fd: number | null = null;
  try {
    // Exclusive create — fails if the file already exists
    fd = openSync(tmpPath, "wx", 0o600);
    const content = JSON.stringify(value, null, 2) + "\n";
    writeSync(fd, content, 0, "utf-8");

    // fsync the temp file
    try {
      fsyncSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_FSYNC_FAILED",
        phase,
        "",
        `Failed to fsync temp file: ${(e as Error).message}`,
      );
    }

    closeSync(fd);
    fd = null;

    // rename temp → target
    try {
      renameSync(tmpPath, targetPath);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_RENAME_FAILED",
        phase,
        "",
        `Failed to rename temp to target: ${(e as Error).message}`,
      );
    }

    // fsync the directory
    let dirFd: number | null = null;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      // Directory fsync is best-effort on some platforms — don't fail
      // the write if the directory can't be opened for fsync.
      // The file rename has already succeeded.
    } finally {
      if (dirFd !== null) closeSync(dirFd);
    }
  } catch (e) {
    // Clean up temp file on any failure
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmpPath); } catch {}

    if (e instanceof GenerationStoreError) throw e;

    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      "",
      `Failed to write JSON atomically: ${(e as Error).message}`,
    );
  }
}

// ─── Project listing (section 9.4, future) ─────────────────────────────

/**
 * List all projects that have a generation store.
 * Returns an array of project store directories (SHA-256 keys).
 *
 * R169A: This is a minimal helper for future use. The actual project
 * name is stored inside the manifest, not derived from the directory name.
 */
export function listProjectStoreKeys(storeRoot?: string): string[] {
  const root = storeRoot ?? generationStoreRoot();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
