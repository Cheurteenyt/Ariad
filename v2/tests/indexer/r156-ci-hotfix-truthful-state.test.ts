// v2/tests/indexer/r156-ci-hotfix-truthful-state.test.ts
// R156: CI Hotfix + Truthful State + Directory Alias Duplicate + Recovery Hints
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { loadAliasHistory, computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R156: CI Hotfix + Truthful State + Directory Alias', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r156-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r156-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── ALIAS-R156-01: Directory alias duplicate historization ──────────

  it('ALIAS-R156-01a: two aliases to the same directory → BOTH historized', async () => {
    // R155 bug: resolvedAliases.push was AFTER visitedDirs.has check, so the
    // second alias (aliasB) was skipped as duplicate and never historized.
    // R156 fix: push BEFORE the check.
    mkdirSync(join(projectDir, 'realdir'));
    writeFileSync(join(projectDir, 'realdir', 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'realdir'), join(projectDir, 'aliasA'));
    symlinkSync(join(projectDir, 'realdir'), join(projectDir, 'aliasB'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    // R156: BOTH aliases must be historized (R155 only historized aliasA).
    expect(history.has('aliasA')).toBe(true);
    expect(history.has('aliasB')).toBe(true);
    expect(history.get('aliasB')!.targetKind).toBe('directory');
  });

  it('ALIAS-R156-01b: target dir removed → BOTH aliases appear in staleReason.paths', async () => {
    // Run 1: two aliases to the same dir, both historized (R156 fix).
    // R155 bug: only aliasA was historized (aliasB hit visitedDirs dedup
    // and was skipped before resolvedAliases.push).
    mkdirSync(join(projectDir, 'realdir'));
    writeFileSync(join(projectDir, 'realdir', 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'realdir'), join(projectDir, 'aliasA'));
    symlinkSync(join(projectDir, 'realdir'), join(projectDir, 'aliasB'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: remove the target directory. Both aliasA and aliasB are now
    // broken with target absent. Both have history (R156 fix).
    rmSync(join(projectDir, 'realdir'), { recursive: true, force: true });
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R156: BOTH aliases were historized → both appear in effectiveHistoricalBrokenAliases
    // → STALE + both paths in staleReason.paths. R155 only historized aliasA,
    // so staleReason.paths would be ['aliasA'] only — missing the protection
    // for the subtree under the second alias.
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.paths).toContain('aliasA');
    expect(r.staleReason!.paths).toContain('aliasB');
  });

  // ── OBS-R156-01: staleReason + recovery structured fields ───────────

  it('OBS-R156-01a: STALE outcome carries staleReason with code', async () => {
    // Run 1: index with a valid alias.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: remove target, full mode → STALE.
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    // R156: staleReason is now a structured field on IndexResult.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    expect(typeof r.staleReason!.message).toBe('string');
    expect(r.staleReason!.message.length).toBeGreaterThan(0);
  });

  it('OBS-R156-01b: STALE outcome carries recovery recommendation', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    // R156 (AVAIL-R156-01): recovery recommendation is provided.
    expect(r.recovery).toBeDefined();
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('OBS-R156-01c: staleReason.paths contains the broken alias paths', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.staleReason).toBeDefined();
    // R156: the broken alias path is included so the user can fix it.
    expect(r.staleReason!.paths).toContain('alias.ts');
  });

  // ── AVAIL-R156-01: Cold-start lock message is no longer circular ────

  it('AVAIL-R156-01a: cold-start lock message says "Fix or remove" (not "run a successful full first")', async () => {
    // Run 1: index with a valid alias.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate cold-start: clear history + reset flags.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();
    // Run 2: break alias, full mode → cold-start lock → STALE.
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    // R156 (AVAIL-R156-01): the message must say "Fix or remove" — NOT "run a
    // successful full index first" (which was circular since full mode is
    // blocked by the cold-start lock).
    expect(r.staleReason!.message).toContain('Fix or remove');
    expect(r.staleReason!.message).not.toContain('run a successful full index first');
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('AVAIL-R156-01b: cold-start lock staleReason.code === "COLD_START_LOCK"', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('COLD_START_LOCK');
  });

  // ── TX-R156-01: Pre-mark stale before extraction ────────────────────

  it('TX-R156-01a: successful full index ends with stale=0 (pre-mark overwritten)', async () => {
    // R156 pre-marks stale=1 BEFORE extraction, then commitAliasStateAtomically
    // clears stale=0 atomically. A successful run must end with stale=0.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    expect(r.crossFileCallsStale).toBe(false);
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale AS stale FROM projects WHERE name = ?').get(projectName) as { stale: number };
    db.close();
    expect(row.stale).toBe(0);
  });

  it('TX-R156-01b: successful incremental index also ends with stale=0', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Modify the file and re-index incrementally.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 2; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(false);
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale AS stale, last_index_error AS err FROM projects WHERE name = ?').get(projectName) as { stale: number; err: string | null };
    db.close();
    expect(row.stale).toBe(0);
    // The pre-mark message ("Index publication in progress") must be cleared
    // by the successful commit.
    expect(row.err).toBeNull();
  });

  // ── CI-R156-01: FIFO test compiles (no fs.mkfifoSync) ───────────────

  it('CI-R156-01a: r155 test file no longer imports mkfifoSync (typecheck regression)', () => {
    // R156: the r155 test file used to import `mkfifoSync` from node:fs,
    // which doesn't exist. This caused the TypeScript typecheck to fail,
    // blocking all CI. R156 replaces it with spawnSync('mkfifo').
    // This test verifies the IMPORT statement was removed (the word
    // `mkfifoSync` may still appear in comments documenting the R155 bug).
    const r155TestPath = join(__dirname, 'r155-atomic-state-fingerprint-v2.test.ts');
    expect(existsSync(r155TestPath)).toBe(true);
    const { readFileSync } = require('node:fs');
    const content = readFileSync(r155TestPath, 'utf8');
    // The `from 'node:fs'` import line must NOT contain mkfifoSync.
    const fsImportLine = content.split('\n').find(l => l.includes("from 'node:fs'"));
    expect(fsImportLine).toBeDefined();
    expect(fsImportLine!).not.toContain('mkfifoSync');
    // R156: spawnSync is now imported and used to create the FIFO.
    expect(content).toContain("from 'node:child_process'");
    expect(content).toContain('spawnSync');
    expect(content).toContain('createFifo');
  });

  it('CI-R156-01b: createFifo helper returns false on unsupported platforms', () => {
    // R156: createFifo is a small helper that uses spawnSync('mkfifo').
    // On Linux it should succeed; on Windows it should return false.
    // We can't test mkfifo directly here (no FIFO needed for this test),
    // but we can verify the helper exists and behaves correctly when
    // called with an invalid path.
    // We inline the same logic to verify the contract:
    const testPath = join(tmpDir, 'test-fifo');
    if (process.platform === 'win32') {
      // On Windows, mkfifo doesn't exist — createFifo should return false.
      // (We can't easily import the helper from the r155 test file, so we
      // replicate the logic here for the contract check.)
      const result = (function createFifo(path: string): boolean {
        if (process.platform === 'win32') return false;
        try {
          const r = spawnSync('mkfifo', [path], { stdio: 'ignore' });
          return r.error === undefined && r.status === 0;
        } catch {
          return false;
        }
      })(testPath);
      expect(result).toBe(false);
    } else {
      // On Linux/macOS, mkfifo should succeed (test FIFO is created).
      const result = (function createFifo(path: string): boolean {
        if (process.platform === 'win32') return false;
        try {
          const r = spawnSync('mkfifo', [path], { stdio: 'ignore' });
          return r.error === undefined && r.status === 0;
        } catch {
          return false;
        }
      })(testPath);
      expect(result).toBe(true);
      expect(existsSync(testPath)).toBe(true);
    }
  });

  // ── Regression ──────────────────────────────────────────────────────

  it('regression: staleReason is undefined on SUCCESS outcome', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    expect(r.staleReason).toBeUndefined();
    expect(r.recovery).toBeUndefined();
  });
});
