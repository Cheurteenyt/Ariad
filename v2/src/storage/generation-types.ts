/**
 * R169A — Atomic Generation Publication: strict type definitions.
 *
 * SIG-R169-Phase-B is CLOSED. This is the PRODUCT R169 — generation store
 * foundation. The types defined here are the contract for immutable SQLite
 * snapshots published via an atomic manifest.
 *
 * STATUS: FOUNDATION / INACTIVE
 * The types exist and are tested, but no production code uses them yet.
 * The indexer still writes to the legacy DB path. Readers still open the
 * legacy DB directly. No generation has ever been published.
 *
 * Invariants (section 4 of the R169A specification):
 *   - A published generation is immutable.
 *   - No writer modifies a DB already referenced by active-generation.json.
 *   - A reader always sees either the old complete snapshot or the new
 *     complete snapshot — never a partial snapshot.
 */

// ─── Manifest V1 ────────────────────────────────────────────────────────

/**
 * The on-disk manifest format for a published generation.
 *
 * Stored as `active-generation.json` in the project store directory.
 * The exact key set is enforced — no extra keys are allowed for V1.
 * A future incompatible change requires bumping formatVersion.
 */
export interface GenerationManifestV1 {
  /** Must be CURRENT_GENERATION_MANIFEST_VERSION (1). */
  readonly formatVersion: 1;

  /** The project name. Must match the requested project exactly. */
  readonly project: string;

  /** Canonical UUID v4 of this generation. */
  readonly generationId: string;

  /**
   * Relative path to the DB file, from the project store directory.
   * R169A-FIX (DATA-R169A-01): dbFile MUST be exactly
   *   `generations/generation-<generationId>.db`
   * No other form is accepted.
   */
  readonly dbFile: string;

  /** ISO-8601 timestamp WITH timezone. Example: `2026-07-13T00:00:00.000Z`. */
  readonly createdAt: string;

  /** Stable fingerprint of the project root (dev:ino or equivalent). */
  readonly rootFingerprint: string;

  /** Extractor semantics version at the time of generation. Must be >= 0. */
  readonly extractorSemanticsVersion: number;

  /** Discovery policy version at the time of generation. Must be >= 0. */
  readonly discoveryPolicyVersion: number;

  /** Number of nodes in the generation DB. Must be >= 0. */
  readonly nodeCount: number;

  /** Number of edges in the generation DB. Must be >= 0. */
  readonly edgeCount: number;

  /** Number of file_hashes rows in the generation DB. Must be >= 0. */
  readonly fileCount: number;

  /** Size of the DB file in bytes. Must be >= 0. */
  readonly sizeBytes: number;

  /** SHA-256 of the DB file content. Must be 64 lowercase hex chars. */
  readonly sha256: string;
}

/** Exact set of keys allowed in a V1 manifest. No extras permitted. */
export const MANIFEST_V1_KEYS = new Set<string>([
  "formatVersion",
  "project",
  "generationId",
  "dbFile",
  "createdAt",
  "rootFingerprint",
  "extractorSemanticsVersion",
  "discoveryPolicyVersion",
  "nodeCount",
  "edgeCount",
  "fileCount",
  "sizeBytes",
  "sha256",
]);

// ─── Index State V1 ─────────────────────────────────────────────────────

/**
 * Operational state for the indexing process, stored as a sidecar
 * `index-state.json`. This file contains diagnostics, NOT graph data.
 * The generation DB and active-generation.json remain unchanged on
 * indexing failure.
 */
export interface IndexAttemptStateV1 {
  readonly formatVersion: 1;
  readonly project: string;
  /** UUID of the currently active generation, or null if none. */
  readonly activeGenerationId: string | null;
  /** UUID of the last indexing attempt. */
  readonly lastAttemptId: string;
  /** ISO-8601 timestamp of the last attempt. */
  readonly lastAttemptAt: string;
  /** Outcome of the last attempt. */
  readonly lastAttemptOutcome: IndexAttemptOutcome;
  /** Error message if the attempt failed, null otherwise. */
  readonly lastAttemptError: string | null;
  /** Why the active generation is stale, if applicable. */
  readonly staleReason: string | null;
  /** Recovery action recommended. */
  readonly recovery: IndexRecoveryAction;
}

export type IndexAttemptOutcome =
  | "SUCCESS"
  | "SUCCESS_WITH_WARNINGS"
  | "PARTIAL"
  | "FAILED"
  | "STALE";

export type IndexRecoveryAction =
  | "none"
  | "full_reindex"
  | "incremental_retry"
  | "manifest_repair"
  | "legacy_migration";

// ─── Resolved DB ────────────────────────────────────────────────────────

/**
 * Result of resolving the active code DB for a project.
 * - `generation`: a published generation was found via manifest.
 * - `legacy`: no manifest, but a legacy DB exists at the old path.
 * - `missing`: neither manifest nor legacy DB exists.
 */
export type ResolvedCodeDb =
  | ResolvedGenerationDb
  | ResolvedLegacyDb
  | ResolvedMissingDb;

export interface ResolvedGenerationDb {
  readonly source: "generation";
  readonly project: string;
  readonly dbPath: string;
  readonly generationId: string;
  readonly manifest: GenerationManifestV1;
}

export interface ResolvedLegacyDb {
  readonly source: "legacy";
  readonly project: string;
  readonly dbPath: string;
  readonly generationId: null;
}

export interface ResolvedMissingDb {
  readonly source: "missing";
  readonly project: string;
  readonly dbPath: null;
  readonly generationId: null;
}

// ─── Error taxonomy ─────────────────────────────────────────────────────

/**
 * Structured error codes for the generation store.
 * Never group all errors under a single DB_ERROR.
 *
 * R169A-FIX (GPT 5.6 audit): Added five new codes:
 *   - ATOMIC_DURABILITY_UNKNOWN     (DUR-R169A-01: rename succeeded but dir fsync failed)
 *   - ATOMIC_SERIALIZATION_FAILED   (DUR-R169A-02: JSON.stringify returned non-string)
 *   - ATOMIC_SHORT_WRITE            (DUR-R169A-02: writeSync returned <=0 mid-payload)
 *   - MANIFEST_TARGET_NOT_REGULAR   (DATA-R169A-01: resolved dbPath is not a regular file)
 *   - MANIFEST_DBFILE_NOT_CANONICAL (DATA-R169A-01: dbFile != generations/generation-<uuid>.db)
 */
export type GenerationStoreErrorCode =
  | "GENERATION_STORE_CONFIG_ERROR"
  | "MANIFEST_PARSE_ERROR"
  | "MANIFEST_SCHEMA_ERROR"
  | "MANIFEST_TARGET_MISSING"
  | "MANIFEST_TARGET_OUTSIDE_STORE"
  | "MANIFEST_PROJECT_MISMATCH"
  | "MANIFEST_UNSUPPORTED_VERSION"
  | "MANIFEST_SYMLINK_REJECTED"
  | "GENERATION_TARGET_SYMLINK_REJECTED"
  | "MANIFEST_TARGET_NOT_REGULAR"
  | "MANIFEST_DBFILE_NOT_CANONICAL"
  | "LEGACY_SOURCE_OPEN_FAILED"
  | "ATOMIC_WRITE_FAILED"
  | "ATOMIC_RENAME_FAILED"
  | "ATOMIC_FSYNC_FAILED"
  | "ATOMIC_DURABILITY_UNKNOWN"
  | "ATOMIC_SERIALIZATION_FAILED"
  | "ATOMIC_SHORT_WRITE"
  | "PATH_TRAVERSAL_REJECTED"
  | "PROJECT_KEY_INVALID";

export class GenerationStoreError extends Error {
  readonly code: GenerationStoreErrorCode;
  readonly phase: string;
  readonly project: string;

  constructor(
    code: GenerationStoreErrorCode,
    phase: string,
    project: string,
    message: string,
  ) {
    super(`[${code}] ${phase}: ${message} (project=${project})`);
    this.name = "GenerationStoreError";
    this.code = code;
    this.phase = phase;
    this.project = project;
  }
}
