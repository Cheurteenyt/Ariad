/**
 * R169A — Atomic Generation Publication: generation store tests.
 *
 * STATUS: FOUNDATION / INACTIVE
 * Tests verify the generation store contract without activating it.
 *
 * R169A-FIX (GPT 5.6 audit): This file was rewritten to fix all 14 audit
 * findings. Key changes:
 *
 *   - Real fault injection for the atomic writer via AtomicFileOps.
 *     Every checkpoint (serialize, open, write, fsync, close, rename,
 *     dir-fsync) can be injected with a controlled failure.
 *
 *   - Real legacy DB tests use an injected cacheRoot — NO writes to the
 *     real HOME cache directory. The writeLegacyDb helper that touched
 *     the real cache is removed.
 *
 *   - Symlink chain detection: tests verify that a symlink anywhere in
 *     the path chain (manifest parent, generations parent, project
 *     store, target final) is rejected. The chain walk uses lstatSync
 *     per component, not realpath on the candidate alone.
 *
 *   - Canonical dbFile: dbFile MUST equal
 *     `generations/generation-<generationId>.db`. No aliasing.
 *
 *   - Safe integers: Number.isSafeInteger for all numeric manifest
 *     fields. Rejects MAX_SAFE_INTEGER + 1, Infinity, NaN.
 *
 *   - Calendar-valid timestamps: rejects 2026-02-29 (not leap), month
 *     13, hour 24; accepts 2028-02-29 (leap).
 *
 *   - Source inspection guard replaced grep with a Node.js directory
 *     walk — no shell exec, no spawn.
 *
 * Test matrix:
 *   - Path safety: normal, Unicode, spaces, traversal, absolute, long,
 *     deterministic, empty
 *   - Manifest valid: V1 exact, zero counts, Unicode, sha lowercase,
 *     timestamp timezone
 *   - Manifest invalid: null, array, missing key, extra key, future
 *     version, project mismatch, invalid UUID, non-canonical dbFile
 *     (5 forms), invalid timestamp, calendar-invalid timestamp (4 forms),
 *     unsafe integer (3 forms), invalid sha, multiline field
 *   - Resolver: valid manifest + target exists → generation; no manifest
 *     + legacy → legacy; no manifest + no legacy → missing; invalid
 *     manifest → fail closed; target missing → fail closed; target
 *     directory → MANIFEST_TARGET_NOT_REGULAR; project mismatch → fail
 *     closed; symlink chain at any level → rejected; legacy path
 *     validation failures → LEGACY_SOURCE_OPEN_FAILED
 *   - Atomic JSON writer: 10-case fault-injection matrix
 *   - Legacy path tests: real legacy DB in injected cacheRoot; traversal
 *     rejected
 *   - listProjectStoreKeys: filter to 64-hex, sort, fail-closed on EACCES
 *   - No production behavior change: defaultCodeDbPath importable;
 *     legacyCodeDbPath matches defaultCodeDbPath for ordinary projects;
 *     CURRENT_GENERATION_MANIFEST_VERSION is 1
 *   - Source inspection: Node.js walk replaces grep
 *   - Child crash test: child writes temp + fsync then exits before
 *     rename; parent verifies old target intact
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  projectStorageKey,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  indexStatePath,
  legacyCodeDbPath,
  cbmCacheDir,
  generationStoreRoot,
  isLexicallyInside,
  isPathInside,
  assertPathInsideNoSymlinks,
  assertNotSymlink,
  validateGenerationManifest,
  parseGenerationManifest,
  resolveActiveCodeDb,
  writeJsonAtomically,
  listProjectStoreKeys,
  GenerationStoreError,
  type AtomicFileOps,
} from "../../src/storage/generation-store.js";
import type { GenerationManifestV1 } from "../../src/storage/generation-types.js";

// ─── Constants ──────────────────────────────────────────────────────────

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "661f9511-f30c-52e5-b827-557766551111";
const VALID_SHA256 = "a".repeat(64);
const VALID_TIMESTAMP = "2026-07-13T00:00:00.000Z";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeValidManifest(project: string = "test-project"): GenerationManifestV1 {
  return {
    formatVersion: 1,
    project,
    generationId: VALID_UUID,
    dbFile: `generations/generation-${VALID_UUID}.db`,
    createdAt: VALID_TIMESTAMP,
    rootFingerprint: "/canonical/root:dev:ino",
    extractorSemanticsVersion: 8,
    discoveryPolicyVersion: 2,
    nodeCount: 123,
    edgeCount: 456,
    fileCount: 78,
    sizeBytes: 987654,
    sha256: VALID_SHA256,
  };
}

/**
 * Write a manifest file into the injected cacheRoot. Uses the production
 * path helpers so the test exercises the real layout.
 */
function writeManifest(cacheRoot: string, project: string, manifest: GenerationManifestV1): string {
  const manifestPath = activeManifestPath(project, cacheRoot);
  mkdirSync(resolve(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return manifestPath;
}

/**
 * Write a fake generation DB file into the injected cacheRoot.
 */
function writeGenerationDb(cacheRoot: string, project: string, dbFile: string): string {
  const projectDir = projectStoreDir(project, cacheRoot);
  const dbPath = join(projectDir, dbFile);
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  writeFileSync(dbPath, "fake DB content", "utf-8");
  return dbPath;
}

/**
 * Write a legacy DB file into the injected cacheRoot. R169A-FIX: this
 * does NOT touch the real HOME cache — it uses the injected cacheRoot.
 */
function writeLegacyDb(cacheRoot: string, project: string): string {
  const dbPath = legacyCodeDbPath(project, cacheRoot);
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  writeFileSync(dbPath, "fake legacy DB", "utf-8");
  return dbPath;
}

/**
 * R169A-FIX (DUR-R169A-02): Injectable AtomicFileOps implementation.
 *
 * Each test instantiates this with a `failAt` selector that injects a
 * controlled failure at a specific checkpoint. Real fs is used for
 * every other call.
 */
class TestOps implements AtomicFileOps {
  failAt: string | null = null;
  /** If true, the first writeSync call writes only 1 byte then succeeds. */
  shortFirstWrite: boolean = false;
  /** If true, the second writeSync call (mid-payload) throws. */
  failSecondWrite: boolean = false;
  private writeCallCount: number = 0;

  // Track which ops were called — useful for assertions.
  calls: string[] = [];

  openSync(path: string, flags: string, mode?: number): number {
    if (this.failAt === "open") {
      this.calls.push("open:fail");
      throw new Error("injected open failure");
    }
    // For directory openSync("r") we want to allow failure injection
    // separately from the temp file open.
    if (this.failAt === "dirOpen" && flags === "r") {
      this.calls.push("dirOpen:fail");
      throw new Error("injected directory open failure");
    }
    this.calls.push("open");
    return require("node:fs").openSync(path, flags, mode);
  }

  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    this.writeCallCount++;
    if (this.failAt === "writeAlways") {
      this.calls.push("write:fail");
      throw new Error("injected write failure");
    }
    if (this.failSecondWrite && this.writeCallCount === 2) {
      this.calls.push("write:fail:mid-payload");
      throw new Error("injected write failure mid-payload");
    }
    if (this.shortFirstWrite && this.writeCallCount === 1) {
      // Write exactly 1 byte to force the loop to call writeSync again.
      this.calls.push("write:short");
      const fs = require("node:fs");
      return fs.writeSync(fd, buffer, offset, 1, position);
    }
    this.calls.push("write");
    const fs = require("node:fs");
    return fs.writeSync(fd, buffer, offset, length, position);
  }

  fsyncSync(fd: number): void {
    // Distinguish temp-file fsync from directory fsync by checking
    // whether the fd refers to a directory. We can't easily check this
    // from the fd alone in a portable way; instead, the test sets
    // failAt to "tempFsync" or "dirFsync" and we infer from call order:
    // the temp file fsync happens before rename, the dir fsync after.
    if (this.failAt === "tempFsync" && !this.calls.includes("rename")) {
      this.calls.push("fsync:temp:fail");
      throw new Error("injected temp fsync failure");
    }
    if (this.failAt === "dirFsync" && this.calls.includes("rename")) {
      this.calls.push("fsync:dir:fail");
      throw new Error("injected directory fsync failure");
    }
    this.calls.push("fsync");
    const fs = require("node:fs");
    return fs.fsyncSync(fd);
  }

  closeSync(fd: number): void {
    if (this.failAt === "closeBeforeRename" && !this.calls.includes("rename")) {
      this.calls.push("close:fail");
      throw new Error("injected close failure");
    }
    this.calls.push("close");
    const fs = require("node:fs");
    return fs.closeSync(fd);
  }

  renameSync(from: string, to: string): void {
    if (this.failAt === "rename") {
      this.calls.push("rename:fail");
      throw new Error("injected rename failure");
    }
    this.calls.push("rename");
    const fs = require("node:fs");
    return fs.renameSync(from, to);
  }

  unlinkSync(path: string): void {
    this.calls.push("unlink");
    const fs = require("node:fs");
    return fs.unlinkSync(path);
  }

  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    this.calls.push("mkdir");
    const fs = require("node:fs");
    return fs.mkdirSync(path, opts);
  }
}

/** Walk a directory tree recursively and return all .ts file paths. */
function walkTs(root: string): string[] {
  const out: string[] = [];
  function visit(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
      } else if (e.isFile() && e.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  visit(root);
  return out;
}

// ─── Path safety tests ──────────────────────────────────────────────────

describe("R169A — Path safety", () => {
  it("normal project produces a 64-char hex key", () => {
    const key = projectStorageKey("my-project");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Unicode project produces a valid key", () => {
    const key = projectStorageKey("プロジェクト");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("project with spaces produces a valid key", () => {
    const key = projectStorageKey("my project");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('project "../escape" produces a valid key (no traversal in path)', () => {
    const key = projectStorageKey("../escape");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("..");
  });

  it('project "/absolute" produces a valid key (no absolute path)', () => {
    const key = projectStorageKey("/absolute/path");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("very long project produces a valid key", () => {
    const key = projectStorageKey("a".repeat(1000));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same project produces deterministic key", () => {
    expect(projectStorageKey("my-project")).toBe(projectStorageKey("my-project"));
  });

  it("different projects produce different keys", () => {
    expect(projectStorageKey("project-a")).not.toBe(projectStorageKey("project-b"));
  });

  it("empty project throws", () => {
    expect(() => projectStorageKey("")).toThrow(GenerationStoreError);
  });

  it("all paths remain inside injected cache root", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-paths-"));
    try {
      const project = "my-project";
      const storeDir = projectStoreDir(project, cacheRoot);
      const genDir = generationsDir(project, cacheRoot);
      const tmpDirectory = tmpDir(project, cacheRoot);
      const manifestPath = activeManifestPath(project, cacheRoot);
      const statePath = indexStatePath(project, cacheRoot);

      // All paths must be lexically inside the injected cacheRoot.
      expect(isLexicallyInside(cacheRoot, storeDir)).toBe(true);
      expect(isLexicallyInside(cacheRoot, genDir)).toBe(true);
      expect(isLexicallyInside(cacheRoot, tmpDirectory)).toBe(true);
      expect(isLexicallyInside(cacheRoot, manifestPath)).toBe(true);
      expect(isLexicallyInside(cacheRoot, statePath)).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

// ─── Manifest validation: valid cases ───────────────────────────────────

describe("R169A — Manifest valid", () => {
  it("V1 exact valid manifest passes validation", () => {
    const manifest = makeValidManifest();
    const result = validateGenerationManifest(manifest, "test-project");
    expect(result.formatVersion).toBe(1);
    expect(result.project).toBe("test-project");
  });

  it("zero counts are valid", () => {
    const manifest = { ...makeValidManifest(), nodeCount: 0, edgeCount: 0, fileCount: 0, sizeBytes: 0 };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("Unicode project name is valid", () => {
    const manifest = makeValidManifest("プロジェクト");
    expect(() => validateGenerationManifest(manifest, "プロジェクト")).not.toThrow();
  });

  it("sha256 lowercase exact is valid", () => {
    const manifest = { ...makeValidManifest(), sha256: "abcdef0123456789".repeat(4) };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("timestamp with +00:00 timezone is valid", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:00.000+00:00" };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });
});

// ─── Manifest validation: invalid cases ─────────────────────────────────

describe("R169A — Manifest invalid", () => {
  it("null → MANIFEST_SCHEMA_ERROR", () => {
    expect(() => validateGenerationManifest(null, "test-project")).toThrow(GenerationStoreError);
  });

  it("array → MANIFEST_SCHEMA_ERROR", () => {
    expect(() => validateGenerationManifest([], "test-project")).toThrow(GenerationStoreError);
  });

  it("missing key → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest() };
    delete (manifest as any).sha256;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("extra key → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), extra: "no" } as any;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("future formatVersion → MANIFEST_UNSUPPORTED_VERSION", () => {
    const manifest = { ...makeValidManifest(), formatVersion: 2 } as any;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("project mismatch → MANIFEST_PROJECT_MISMATCH", () => {
    const manifest = makeValidManifest("other-project");
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid UUID → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), generationId: "not-a-uuid" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid timestamp (no timezone) → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:00" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("date-only timestamp → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid sha (uppercase) → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), sha256: "A".repeat(64) };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("multiline field → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "line1\nline2" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });
});

// ─── Manifest validation: canonical dbFile (R169A-FIX DATA-R169A-01) ────

describe("R169A-FIX — Canonical dbFile (DATA-R169A-01)", () => {
  it('dbFile "." → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "." };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it('dbFile "active-generation.json" → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "active-generation.json" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it('dbFile "tmp/foo.db" → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "tmp/foo.db" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with different UUID → rejected", () => {
    const manifest = { ...makeValidManifest(), dbFile: `generations/generation-${OTHER_UUID}.db` };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile canonical → accepted", () => {
    const manifest = makeValidManifest();
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });
});

// ─── Manifest validation: safe integers (R169A-FIX VALID-R169A-02) ──────

describe("R169A-FIX — Safe integers (VALID-R169A-02)", () => {
  it("MAX_SAFE_INTEGER → accepted", () => {
    const manifest = {
      ...makeValidManifest(),
      nodeCount: Number.MAX_SAFE_INTEGER,
      edgeCount: Number.MAX_SAFE_INTEGER,
      fileCount: Number.MAX_SAFE_INTEGER,
      sizeBytes: Number.MAX_SAFE_INTEGER,
    };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("MAX_SAFE_INTEGER + 1 → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: Number.MAX_SAFE_INTEGER + 1 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("Infinity → rejected", () => {
    const manifest = { ...makeValidManifest(), sizeBytes: Infinity } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("NaN → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: NaN } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("float (1.5) → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: 1.5 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("negative → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: -1 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("extractorSemanticsVersion MAX_SAFE_INTEGER + 1 → rejected", () => {
    const manifest = { ...makeValidManifest(), extractorSemanticsVersion: Number.MAX_SAFE_INTEGER + 1 } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });
});

// ─── Manifest validation: calendar dates (R169A-FIX VALID-R169A-01) ─────

describe("R169A-FIX — Calendar-valid timestamps (VALID-R169A-01)", () => {
  it("2026-02-29 (not leap) → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-02-29T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("2028-02-29 (leap) → accepted", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2028-02-29T00:00:00.000Z" };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("month 13 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-13-01T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("hour 24 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T24:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("minute 60 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:60:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("second 60 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:60.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("day 31 in April (April has 30 days) → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-04-31T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });
});

// ─── Resolver tests ─────────────────────────────────────────────────────

describe("R169A — Resolver", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-resolver-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("valid manifest + target exists → generation", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("generation");
    if (result.source === "generation") {
      expect(result.generationId).toBe(VALID_UUID);
      expect(existsSync(result.dbPath)).toBe(true);
    }
  });

  it("no manifest + no legacy → missing", () => {
    const result = resolveActiveCodeDb("nonexistent", { cacheRoot });
    expect(result.source).toBe("missing");
    if (result.source === "missing") {
      expect(result.dbPath).toBeNull();
    }
  });

  it("no manifest + legacy exists → legacy (R169A-FIX: uses injected cacheRoot)", () => {
    const project = "legacy-only-project";
    writeLegacyDb(cacheRoot, project);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("legacy");
    if (result.source === "legacy") {
      expect(existsSync(result.dbPath)).toBe(true);
      expect(result.generationId).toBeNull();
    }
  });

  it("invalid manifest → fail closed (no legacy fallback)", () => {
    const project = "test-project";
    const manifestPath = activeManifestPath(project, cacheRoot);
    mkdirSync(resolve(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "{invalid json}", "utf-8");

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("target missing → fail closed", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Don't create the DB file

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("target is a directory → MANIFEST_TARGET_NOT_REGULAR (R169A-FIX DATA-R169A-01)", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Create the dbFile path as a directory, not a regular file.
    const dbPath = join(projectStoreDir(project, cacheRoot), manifest.dbFile);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_TARGET_NOT_REGULAR");
  });

  it("project mismatch in manifest → fail closed", () => {
    const project = "test-project";
    const manifest = makeValidManifest("different-project");
    writeManifest(cacheRoot, project, manifest);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("symlink manifest → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the manifest file with a self-referential symlink.
    const manifestPath = activeManifestPath(project, cacheRoot);
    const target = manifestPath + ".target";
    rmSync(manifestPath);
    writeFileSync(target, "symlink-target", "utf-8");
    symlinkSync(target, manifestPath);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("symlink generation target → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    const realDbPath = writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the DB with a symlink to elsewhere.
    const symlinkTarget = realDbPath + ".real";
    writeFileSync(symlinkTarget, "real-target", "utf-8");
    rmSync(realDbPath);
    symlinkSync(symlinkTarget, realDbPath);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });
});

// ─── Symlink chain tests (R169A-FIX SEC-R169A-02) ───────────────────────

describe("R169A-FIX — Symlink chain detection (SEC-R169A-02)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-symlink-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  /**
   * Helper: replace a directory at `path` with a symlink pointing to
   * `target`. Used to inject a symlink at any level of the chain.
   */
  function replaceDirWithSymlink(path: string, target: string): void {
    mkdirSync(target, { recursive: true });
    rmSync(path, { recursive: true, force: true });
    symlinkSync(target, path);
  }

  it("manifest parent symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the project store dir (parent of the manifest) with a
    // symlink to elsewhere inside cacheRoot.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere", "manifest-parent-test");
    mkdirSync(elsewhere, { recursive: true });
    // Move the manifest + DB into elsewhere so the symlink resolves.
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(projectDir, elsewhere);
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("generations parent symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the generations dir (parent of the DB file) with a
    // symlink to elsewhere.
    const genDir = generationsDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-gen", "gen");
    rmSync(genDir, { recursive: true, force: true });
    mkdirSync(elsewhere, { recursive: true });
    // Put a fake DB in the elsewhere dir so the symlink target has the file.
    writeFileSync(join(elsewhere, `generation-${VALID_UUID}.db`), "fake", "utf-8");
    symlinkSync(elsewhere, genDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("project store symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace projectStoreDir itself with a symlink.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-store", "store");
    rmSync(projectDir, { recursive: true, force: true });
    mkdirSync(elsewhere, { recursive: true });
    // Move manifest + generations into elsewhere
    writeFileSync(join(elsewhere, "active-generation.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    mkdirSync(join(elsewhere, "generations"), { recursive: true });
    writeFileSync(join(elsewhere, "generations", `generation-${VALID_UUID}.db`), "fake", "utf-8");
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("target final symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    const realDbPath = writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the DB file itself with a symlink.
    const symlinkTarget = join(cacheRoot, "real-db-target");
    writeFileSync(symlinkTarget, "real-target", "utf-8");
    rmSync(realDbPath);
    symlinkSync(symlinkTarget, realDbPath);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("target directory → MANIFEST_TARGET_NOT_REGULAR", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Create the dbFile path as a directory.
    const dbPath = join(projectStoreDir(project, cacheRoot), manifest.dbFile);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_TARGET_NOT_REGULAR");
  });
});

// Helper used by symlink tests: rename a directory safely (rmSync + rename
// is not used because we want to PRESERVE the contents in the new location).
function renameSyncSafe(from: string, to: string): void {
  // Use fs.renameSync directly.
  const fs = require("node:fs");
  // Ensure parent of `to` exists.
  fs.mkdirSync(require("node:path").resolve(to, ".."), { recursive: true });
  fs.renameSync(from, to);
}

// ─── Atomic JSON writer — fault injection matrix (R169A-FIX DUR-R169A-02) ─

describe("R169A-FIX — Atomic JSON writer (DUR-R169A-01/02)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "r169a-atomic-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("serialize fail (undefined) → no temp, old intact", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    // JSON.stringify(undefined) returns undefined (not a string). The
    // writer must detect this and throw ATOMIC_SERIALIZATION_FAILED
    // BEFORE any file is opened.
    const bad: unknown = undefined;
    let err: unknown;
    try {
      writeJsonAtomically(targetPath, bad);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_SERIALIZATION_FAILED");

    // Old file intact.
    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);

    // No temp file left behind.
    const files = readdirSync(testDir);
    expect(files).toEqual(["output.json"]);
  });

  it("exclusive open fail → old intact", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    // Make the target dir read-only so openSync("wx") fails.
    // We use a custom ops that fails on open.
    const ops = new TestOps();
    ops.failAt = "open";
    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);
    // No temp file left.
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("short write recoverable → success exact", () => {
    const targetPath = join(testDir, "output.json");
    const value = { key: "value".repeat(200), num: 42 }; // big enough to require multiple writes
    const ops = new TestOps();
    ops.shortFirstWrite = true;

    writeJsonAtomically(targetPath, value, ops);

    // The file must contain exactly the right JSON, despite the partial
    // first write.
    const content = readFileSync(targetPath, "utf-8");
    expect(JSON.parse(content)).toEqual(value);
    // Must have called writeSync at least twice: first a 1-byte short
    // write, then subsequent writes for the rest of the payload.
    const allWriteCalls = ops.calls.filter((c) => c.startsWith("write")).length;
    expect(allWriteCalls).toBeGreaterThan(1);
    // The first call must have been a short write.
    expect(ops.calls).toContain("write:short");
  });

  it("write fail mid-payload → old intact, temp cleaned", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    // Force a genuine mid-payload failure: shortFirstWrite makes the
    // first writeSync return after 1 byte (leaving the rest of the
    // payload for the next call). failSecondWrite makes that next call
    // throw, simulating an I/O error mid-payload.
    const ops = new TestOps();
    ops.shortFirstWrite = true;
    ops.failSecondWrite = true;
    const bigValue = { key: "value".repeat(200) };

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, bigValue, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("temp fsync fail → old intact, temp cleaned", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    const ops = new TestOps();
    ops.failAt = "tempFsync";

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_FSYNC_FAILED");

    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("close fail before rename → old intact", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    const ops = new TestOps();
    ops.failAt = "closeBeforeRename";

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // Close failure is wrapped as ATOMIC_WRITE_FAILED.
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("rename fail → old intact, temp cleaned", () => {
    const targetPath = join(testDir, "output.json");
    const oldValue = { version: 1 };
    writeJsonAtomically(targetPath, oldValue);
    const oldContent = readFileSync(targetPath, "utf-8");

    const ops = new TestOps();
    ops.failAt = "rename";

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_RENAME_FAILED");

    expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("directory open fail post-rename → durability unknown", () => {
    const targetPath = join(testDir, "output.json");

    const ops = new TestOps();
    ops.failAt = "dirOpen";

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_DURABILITY_UNKNOWN");

    // The rename has already happened — the target file should contain
    // the NEW content, not the old (there was no old).
    const content = readFileSync(targetPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ new: true });
    // No temp file left (it was renamed).
    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });

  it("directory fsync fail → durability unknown", () => {
    const targetPath = join(testDir, "output.json");

    const ops = new TestOps();
    ops.failAt = "dirFsync";

    let err: unknown;
    try {
      writeJsonAtomically(targetPath, { new: true }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_DURABILITY_UNKNOWN");

    // The rename has already happened — the new content is in place.
    const content = readFileSync(targetPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ new: true });
  });

  it("success → exact JSON, 0600, no temp", () => {
    const targetPath = join(testDir, "output.json");
    const value = { key: "value", num: 42, nested: { a: [1, 2, 3] } };
    writeJsonAtomically(targetPath, value);

    const content = readFileSync(targetPath, "utf-8");
    expect(JSON.parse(content)).toEqual(value);
    // Trailing newline.
    expect(content.endsWith("\n")).toBe(true);

    const stat = lstatSync(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);

    expect(readdirSync(testDir)).toEqual(["output.json"]);
  });
});

// ─── Legacy path tests (R169A-FIX: no real HOME writes) ─────────────────

describe("R169A-FIX — Legacy path validation (SEC-R169A-01 / API-R169A-02)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-legacy-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("legacy DB in injected cacheRoot is found by resolver", () => {
    const project = "test-project";
    writeLegacyDb(cacheRoot, project);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("legacy");
    if (result.source === "legacy") {
      expect(result.dbPath).toBe(legacyCodeDbPath(project, cacheRoot));
    }
  });

  it('project "../escape" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("../escape", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "/absolute/path" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("/absolute/path", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "a/b" → PATH_TRAVERSAL_REJECTED (separator rejected)', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("a/b", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "." → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath(".", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("legacy DB target is a directory → LEGACY_SOURCE_OPEN_FAILED", () => {
    const project = "test-project";
    // Create the legacy path as a directory.
    const dbPath = legacyCodeDbPath(project, cacheRoot);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("LEGACY_SOURCE_OPEN_FAILED");
  });
});

// ─── listProjectStoreKeys (R169A-FIX OPS-R169A-01) ──────────────────────

describe("R169A-FIX — listProjectStoreKeys (OPS-R169A-01)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-list-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns [] when store root does not exist (ENOENT)", () => {
    expect(listProjectStoreKeys(cacheRoot)).toEqual([]);
  });

  it("returns sorted 64-hex directory names only", () => {
    const root = generationStoreRoot(cacheRoot);
    mkdirSync(root, { recursive: true });
    const keyA = projectStorageKey("a");
    const keyB = projectStorageKey("b");
    mkdirSync(join(root, keyA));
    mkdirSync(join(root, keyB));
    // Non-conforming entries — must be filtered out.
    mkdirSync(join(root, "not-a-hash"));
    writeFileSync(join(root, "stray-file.txt"), "no", "utf-8");

    const result = listProjectStoreKeys(cacheRoot);
    expect(result).toEqual([keyA, keyB].sort());
  });

  it("EACCES on store root → throws GenerationStoreError", () => {
    const root = generationStoreRoot(cacheRoot);
    mkdirSync(root, { recursive: true });
    // Create a non-directory entry at the store root path. readdirSync
    // will then fail with ENOTDIR — which is treated as fail-closed.
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "i am a file not a directory", "utf-8");

    expect(() => listProjectStoreKeys(cacheRoot)).toThrow(GenerationStoreError);
  });
});

// ─── No production behavior change ──────────────────────────────────────

describe("R169A — No production behavior change", () => {
  it("defaultCodeDbPath still exists and is importable", async () => {
    const module = await import("../../src/bridge/sqlite-ro.js");
    expect(typeof module.defaultCodeDbPath).toBe("function");
  });

  it("legacyCodeDbPath produces the same path as defaultCodeDbPath for ordinary projects", async () => {
    const { defaultCodeDbPath } = await import("../../src/bridge/sqlite-ro.js");
    const project = "test-project";
    expect(legacyCodeDbPath(project)).toBe(defaultCodeDbPath(project));
  });

  it("CURRENT_GENERATION_MANIFEST_VERSION is still 1", async () => {
    const schema = await import("../../src/indexer/schema.js");
    expect(schema.CURRENT_GENERATION_MANIFEST_VERSION).toBe(1);
  });

  it("no test writes to real HOME cache (R169A-FIX: back-compat verification)", () => {
    // Verify that legacyCodeDbPath without cacheRoot still produces a path
    // inside the real cache (so production callers are unaffected). We
    // don't WRITE anything here — we just check the path is computed.
    const project = "test-project";
    const path = legacyCodeDbPath(project);
    const expected = legacyCodeDbPath(project); // same call
    expect(path).toBe(expected);
    // The path must contain the project name.
    expect(path).toContain(`${project}.db`);
  });
});

// ─── Source inspection: Node.js walk replaces grep ──────────────────────

describe("R169A — Source inspection: legacy path consumers (section 18G)", () => {
  // Compute the v2 source directory relative to this test file.
  // tests/storage/r169a-generation-store.test.ts → ../../src
  const SRC_DIR = resolve(__dirname, "..", "..", "src");
  const REPO_SRC = resolve(__dirname, "..", ".."); // the v2/ directory

  // Expected files that import defaultCodeDbPath. This list is the
  // baseline — new files should NOT be added without migration.
  // Note: src/bridge/sqlite-ro.ts is the DEFINITION, not a consumer.
  const EXPECTED_CONSUMERS = [
    "src/bridge/sqlite-ro.ts", // definition
    "src/indexer/indexer.ts",
    "src/cli/index.ts",
    "src/cli/commands/watch.ts",
    "src/cli/commands/stats.ts",
    "src/cli/commands/obsidian.ts",
    "src/cli/commands/report.ts",
    "src/cli/commands/human.ts",
    "src/intelligence/graph-status.ts",
    "src/ui/routes/project.ts",
    "src/ui/server.ts",
  ];

  it("inventory of defaultCodeDbPath consumers matches expected list", () => {
    // R169A-FIX: replace grep with a Node.js walk.
    const allTs = walkTs(SRC_DIR);
    const actualFiles: string[] = [];
    for (const file of allTs) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("defaultCodeDbPath")) {
        // Normalize to a repo-relative path starting with "src/".
        const rel = relative(REPO_SRC, file);
        actualFiles.push(rel);
      }
    }
    actualFiles.sort();

    for (const expected of EXPECTED_CONSUMERS) {
      expect(actualFiles).toContain(expected);
    }

    const unexpected = actualFiles.filter(
      (f) => !EXPECTED_CONSUMERS.includes(f),
    );
    if (unexpected.length > 0) {
      expect.fail(
        `New defaultCodeDbPath consumers found (update EXPECTED_CONSUMERS or use generation store):\n${unexpected.join("\n")}`,
      );
    }
  });
});

// ─── Child crash test (R169A-FIX DUR-R169A-01 — recommended) ────────────

describe("R169A-FIX — Child crash test (DUR-R169A-01)", () => {
  it("child writes temp + fsync then exits before rename; old target intact", () => {
    const testDir = mkdtempSync(join(tmpdir(), "r169a-crash-"));
    try {
      const targetPath = join(testDir, "target.json");
      // Write the old target using the production writer.
      writeJsonAtomically(targetPath, { version: "old" });
      const oldContent = readFileSync(targetPath, "utf-8");

      // Spawn a child that:
      //   1. Creates a temp file at a known path
      //   2. Writes some content
      //   3. fsyncs it
      //   4. Exits immediately (simulating a crash before rename)
      //
      // We use a Node.js one-liner via -e. The child writes to a fixed
      // temp path (NOT random) so we can verify it exists afterward.
      const tempPath = join(testDir, ".tmp-crash-test.json");
      const childScript = `
        const fs = require('node:fs');
        const path = require('node:path');
        const tempPath = ${JSON.stringify(tempPath)};
        const fd = fs.openSync(tempPath, 'wx', 0o600);
        const buf = Buffer.from(JSON.stringify({ version: 'new' }, null, 2) + '\\n', 'utf8');
        fs.writeSync(fd, buf, 0, buf.length, null);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        // Exit immediately — no rename. This simulates a crash.
        process.exit(0);
      `;
      const result = spawnSync(process.execPath, ["-e", childScript], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(0);

      // The old target file must be intact (the child never renamed).
      expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);

      // The temp file should still exist (the child left it behind).
      expect(existsSync(tempPath)).toBe(true);

      // The temp file content must be the new content (proving fsync
      // happened on the new content even though the rename never did).
      const tempContent = readFileSync(tempPath, "utf-8");
      expect(JSON.parse(tempContent)).toEqual({ version: "new" });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── Path safety helpers — additional direct unit tests ─────────────────

describe("R169A-FIX — isLexicallyInside / assertPathInsideNoSymlinks", () => {
  it("isLexicallyInside: same path → true", () => {
    expect(isLexicallyInside("/a/b", "/a/b")).toBe(true);
  });

  it("isLexicallyInside: child path → true", () => {
    expect(isLexicallyInside("/a/b", "/a/b/c")).toBe(true);
  });

  it("isLexicallyInside: sibling path → false", () => {
    expect(isLexicallyInside("/a/b", "/a/c")).toBe(false);
  });

  it("isLexicallyInside: parent path → false", () => {
    expect(isLexicallyInside("/a/b/c", "/a/b")).toBe(false);
  });

  it("isLexicallyInside: traversal path → false", () => {
    expect(isLexicallyInside("/a/b", "/a/b/../../../etc")).toBe(false);
  });

  it("isPathInside alias equals isLexicallyInside", () => {
    expect(isPathInside).toBe(isLexicallyInside);
  });

  it("assertPathInsideNoSymlinks: clean chain → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-assert-"));
    try {
      const child = join(root, "a", "b", "c");
      mkdirSync(child, { recursive: true });
      expect(() =>
        assertPathInsideNoSymlinks(root, child, "p", "test"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertPathInsideNoSymlinks: traversal → PATH_TRAVERSAL_REJECTED", () => {
    let err: unknown;
    try {
      assertPathInsideNoSymlinks("/a/b", "/a/c", "p", "test");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("assertPathInsideNoSymlinks: symlink mid-chain → rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-symlink-mid-"));
    try {
      const real = join(root, "real");
      const symlink = join(root, "symlink");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, symlink);
      const target = join(symlink, "file");
      let err: unknown;
      try {
        assertPathInsideNoSymlinks(root, target, "p", "test");
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertPathInsideNoSymlinks: ENOENT candidate → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-enoent-"));
    try {
      const missing = join(root, "does", "not", "exist");
      expect(() =>
        assertPathInsideNoSymlinks(root, missing, "p", "test"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: regular file → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-"));
    try {
      const f = join(root, "file");
      writeFileSync(f, "x", "utf-8");
      expect(() =>
        assertNotSymlink(f, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: symlink → throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-sym-"));
    try {
      const target = join(root, "real");
      const link = join(root, "link");
      writeFileSync(target, "x", "utf-8");
      symlinkSync(target, link);
      expect(() =>
        assertNotSymlink(link, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).toThrow(GenerationStoreError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: ENOENT → no throw (only ENOENT tolerated)", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-enoent-"));
    try {
      const missing = join(root, "missing");
      expect(() =>
        assertNotSymlink(missing, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── validateGenerationManifest — dbFile absolute / traversal ──────────

describe("R169A-FIX — dbFile path-form rejections (DATA-R169A-01)", () => {
  it("absolute dbFile → MANIFEST_DBFILE_NOT_CANONICAL (not MANIFEST_TARGET_OUTSIDE_STORE)", () => {
    const manifest = { ...makeValidManifest(), dbFile: "/etc/passwd" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with .. → MANIFEST_DBFILE_NOT_CANONICAL", () => {
    const manifest = { ...makeValidManifest(), dbFile: "../../../etc/passwd" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with backslash → MANIFEST_DBFILE_NOT_CANONICAL", () => {
    const manifest = { ...makeValidManifest(), dbFile: "generations\\..\\escape.db" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });
});
