// v2/tests/indexer/r102-stale-monotonicity.test.ts
// R102: Test that cross_file_calls_stale is monotonic — once true, stays true
// until full reindex. No-op incremental must NOT reset it.
//
// R106 UPDATE: with the persistent call_sites table, incremental mode can now
// rebuild cross-file CALLS. So the "monotonicity" concept changes:
//   - Full reindex → stale=false (always)
//   - Incremental with call_sites populated → stale=false (resolver ran)
//   - Incremental with call_sites empty (legacy DB) → stale=true (can't resolve)
//   - No-op incremental → preserves existing stale state
//
// This test now verifies the R106 behavior: after a full index populates
// call_sites, subsequent incrementals (with file changes) resolve cross-file
// CALLS and set stale=false. No-op incrementals preserve the existing state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R102: Stale Flag Monotonicity (R106: incremental resolves cross-file)', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r102-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r102-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getStaleFromDB(): boolean {
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale FROM projects WHERE name = ?').get(projectName) as { cross_file_calls_stale?: number } | undefined;
    db.close();
    return row?.cross_file_calls_stale === 1;
  }

  it('full → incremental changed (resolves) → no-op preserves → full resets', async () => {
    // Create files
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Step 1: Full index — stale = false, call_sites populated
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // Step 2: Modify a.ts — incremental. R106: resolver runs, stale=false.
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    // R106: stale is now false because call_sites was populated and resolver ran.
    // (Before R106, this was true because incremental couldn't resolve cross-file.)
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // Step 3: No-op incremental — stale must STILL be false (preserved)
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result3.errors.length).toBe(0);
    expect(result3.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // Step 4: Full reindex — stale = false (already false, stays false)
    const result4 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result4.errors.length).toBe(0);
    expect(result4.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });
});
