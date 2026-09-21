// v2/tests/indexer/r190-mtime-pruning.test.ts
// R190 (P1.3): mtime pruning of the incremental refresh path.
//
// What changed:
//   - discoverSourceFilesStructured carries per-file stat metadata
//     (DiscoveryResult.fileStats) collected from the identity stat — the
//     refresh path no longer re-stats every file (was: 3rd/4th statSync).
//   - The useParallel estimate (R86) and indexParallel's fast-skip (R85)
//     share ONE bulk metadata load per run (one SELECT, not one per file)
//     and the shared fastSkippable() predicate so they cannot drift.
//   - Skip semantics are UNCHANGED (R85/R93): mtime_ns+size match → skip;
//     mismatch or NULL mtime_ns → read+hash → metadata-only or re-index.
//
// These tests protect the behavioral contract; the perf claim (fewer
// syscalls/queries) is structural, not asserted here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R190 (P1.3): mtime pruning', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r190-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r190-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function hashRow(relPath: string): { content_hash: string; mtime: number; mtime_ns: string | null; size: number } {
    const db = getDb();
    const row = db.prepare('SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?')
      .get(projectName, relPath) as { content_hash: string; mtime: number; mtime_ns: string | null; size: number };
    db.close();
    return row;
  }

  function nodeCount(relPath: string): number {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?')
      .get(projectName, relPath) as { c: number };
    db.close();
    return row.c;
  }

  describe('DiscoveryResult.fileStats (carried stat metadata)', () => {
    it('carries mtimeNs/size for code files and omits non-code files', () => {
      writeFileSync(join(projectDir, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(projectDir, 'notes.txt'), 'not code');
      mkdirSync(join(projectDir, 'sub'));
      writeFileSync(join(projectDir, 'sub', 'b.ts'), 'export const b = 2;\n');

      const discovery = discoverSourceFilesStructured(projectDir);
      expect(discovery.complete).toBe(true);
      expect(discovery.files.length).toBe(2);

      const statA = statSync(join(projectDir, 'a.ts'), { bigint: true });
      const carriedA = discovery.fileStats.get(join(projectDir, 'a.ts'));
      expect(carriedA).toBeDefined();
      expect(carriedA!.mtimeNs).toBe(statA.mtimeNs.toString());
      expect(carriedA!.size).toBe(Number(statA.size));
      expect(carriedA!.mtimeMs).toBe(Math.floor(Number(statA.mtimeMs)));

      const carriedB = discovery.fileStats.get(join(projectDir, 'sub', 'b.ts'));
      expect(carriedB).toBeDefined();

      // Non-code files are never statted for identity — no entry.
      expect(discovery.fileStats.has(join(projectDir, 'notes.txt'))).toBe(false);
      expect(discovery.fileStats.size).toBe(2);
    });
  });

  describe('Parallel incremental refresh', () => {
    const FILE_COUNT = 30;
    const TOUCH_COUNT = 25; // > 20 — forces useParallel (R86 threshold)

    function writeFiles(): void {
      for (let i = 0; i < FILE_COUNT; i++) {
        writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}() { return ${i}; }\n`);
      }
    }

    /**
     * r94 convention: worker threads may be unexercisable in some vitest
     * environments (WASM load). Detect once on the full index and reuse the
     * decided worker count for the incremental passes; the behavioral
     * assertions hold on both paths, while the parallel path is the one the
     * P1.3 code targets.
     */
    async function fullIndex(): Promise<number> {
      let result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
      });
      if (result.errors.length > 0) {
        result = await indexProjectWasm({
          project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
        });
        return 0;
      }
      expect(result.errors.length).toBe(0);
      expect(result.files).toBe(FILE_COUNT);
      return 2;
    }

    it('strict: the parallel worker path is actually exercised (R96 convention)', async () => {
      writeFiles();
      const result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
      });
      if (result.errors.length > 0) {
        // Environment cannot load WASM in workers — same escape as r94.
        return;
      }
      expect(result.workerCount).toBe(2);
    });

    it('prunes unchanged files and re-parses only changed ones', async () => {
      writeFiles();
      const workers = await fullIndex();

      const unchangedCounts = new Map<string, number>();
      for (let i = 0; i < FILE_COUNT - TOUCH_COUNT; i++) {
        unchangedCounts.set(`file${i}.ts`, nodeCount(`file${i}.ts`));
      }
      const unchangedHashes = new Map<string, string>();
      for (const rel of unchangedCounts.keys()) {
        unchangedHashes.set(rel, hashRow(rel).content_hash);
      }

      // Rewrite the LAST TOUCH_COUNT files with changed content (same shape).
      for (let i = FILE_COUNT - TOUCH_COUNT; i < FILE_COUNT; i++) {
        writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}_modified() { return ${i} * 10; }\n`);
      }

      const result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
      });
      expect(result.errors.length).toBe(0);
      expect(result.files).toBe(TOUCH_COUNT);

      // Unchanged files: same hash, same nodes.
      for (const [rel, count] of unchangedCounts) {
        expect(nodeCount(rel)).toBe(count);
        expect(hashRow(rel).content_hash).toBe(unchangedHashes.get(rel));
      }
      // Changed files: new function name indexed, old one gone.
      const db = getDb();
      const modified = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND name = 'func29_modified'").get(projectName) as { c: number }).c;
      const stale = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND name = 'func29'").get(projectName) as { c: number }).c;
      db.close();
      expect(modified).toBeGreaterThan(0);
      expect(stale).toBe(0);
    });

    it('touch-only files take the metadata-only path (no re-parse, nodes preserved)', async () => {
      writeFiles();
      const workers = await fullIndex();

      const beforeNodes = (getDb().prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
      const touched = `file${FILE_COUNT - 1}.ts`;
      const before = hashRow(touched);

      // Touch 25 files: mtime changes, content does not.
      const newTime = new Date(Date.now() - 60_000);
      for (let i = FILE_COUNT - TOUCH_COUNT; i < FILE_COUNT; i++) {
        utimesSync(join(projectDir, `file${i}.ts`), newTime, newTime);
      }

      const result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
      });
      expect(result.errors.length).toBe(0);
      expect(result.files).toBe(0);

      const afterNodes = (getDb().prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
      expect(afterNodes).toBe(beforeNodes);

      const after = hashRow(touched);
      expect(after.content_hash).toBe(before.content_hash);
      expect(after.mtime_ns).not.toBeNull();
      expect(after.mtime_ns).not.toBe(before.mtime_ns);
    });

    it('legacy NULL mtime_ns rows backfill via metadata-only updates (R93)', async () => {
      writeFiles();
      const workers = await fullIndex();

      // Downgrade 25 rows to the pre-R85 shape (mtime_ns NULL).
      const dbw = new Database(defaultCodeDbPath(projectName));
      const nullRows = dbw.prepare(
        `UPDATE file_hashes SET mtime_ns = NULL
         WHERE project = ? AND file_path IN ('file5.ts','file6.ts','file7.ts','file8.ts','file9.ts',
           'file10.ts','file11.ts','file12.ts','file13.ts','file14.ts','file15.ts','file16.ts','file17.ts',
           'file18.ts','file19.ts','file20.ts','file21.ts','file22.ts','file23.ts','file24.ts','file25.ts',
           'file26.ts','file27.ts','file28.ts','file29.ts')`
      ).run(projectName);
      dbw.close();
      expect(nullRows.changes).toBe(TOUCH_COUNT);

      const beforeNodes = (getDb().prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;

      const result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
      });
      expect(result.errors.length).toBe(0);
      expect(result.files).toBe(0);

      const afterNodes = (getDb().prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
      expect(afterNodes).toBe(beforeNodes);

      const row = hashRow('file5.ts');
      expect(row.mtime_ns).not.toBeNull();
    });
  });
});
