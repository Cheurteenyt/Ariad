// v2/tests/indexer/r194-streaming-pipeline.test.ts
// R194 (memory levers): per-file streaming worker pipeline.
//
// Contract under test (against the COMPILED CLI, like
// windows-worker-url.test.ts — the worker path can only load from dist):
//   - Batches are capped at 250 files and results stream PER FILE; the
//     main thread writes files strictly in (dispatch seq, file index)
//     order, so node ID assignment is deterministic across identical runs
//     (R81 Bug 19 preserved by the per-file rework).
//   - Multi-batch parallel runs account for every file exactly once (no
//     loss, no duplication, no orphan edges).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

const FILE_COUNT = 30; // two batches at numWorkers=2 (ceil(30/2)=15 < 250)
const CLI_PATH = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

describe('R194: streaming per-file pipeline', () => {
  let tmpDir: string;
  let cacheDir: string;
  let dirA: string;
  let dirB: string;
  let projectA: string;
  let projectB: string;
  let distAvailable: boolean;

  function writeProject(projectDir: string): void {
    mkdirSync(projectDir, { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(projectDir, `file${String(i).padStart(2, '0')}.ts`), `export function func${i}() { return ${i}; }\n`);
    }
  }

  function runIndex(project: string, projectDir: string): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [
      CLI_PATH, 'index', '--project', project, '--root', projectDir, '--workers', '2',
    ], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CACHE_HOME: cacheDir },
      timeout: 120_000,
      windowsHide: true,
    });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  }

  function idSequence(project: string): Array<{ id: number; file_path: string; name: string }> {
    const db = new Database(defaultCodeDbPath(project), { readonly: true });
    const rows = db.prepare('SELECT id, file_path, name FROM nodes WHERE project = ? ORDER BY id').all(project) as Array<{ id: number; file_path: string; name: string }>;
    db.close();
    return rows;
  }

  beforeAll(() => {
    // The streaming worker path can only load from the compiled CLI
    // (vitest cannot resolve raw TS in worker threads). Same convention as
    // windows-worker-url.test.ts; CI builds dist before vitest.
    distAvailable = existsSync(CLI_PATH);
    if (!distAvailable) return;
    tmpDir = mkdtempSync(join(tmpdir(), 'r194-'));
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    // The test process reads the child-written DB through the same resolver.
    process.env.XDG_CACHE_HOME = cacheDir;
    dirA = join(tmpDir, 'project-a');
    dirB = join(tmpDir, 'project-b');
    writeProject(dirA);
    writeProject(dirB);
    projectA = `r194-a-${Date.now()}`;
    projectB = `r194-b-${Date.now()}`;
  });

  afterAll(() => {
    delete process.env.XDG_CACHE_HOME;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes every file exactly once across multiple batches, without orphan edges', () => {
    if (!distAvailable) return; // dist not built — same escape as r96/r94-strict

    const result = runIndex(projectA, dirA);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`Files indexed:   ${FILE_COUNT}`);
    expect(result.output).toContain('Parallel:        2 workers');

    const db = new Database(defaultCodeDbPath(projectA), { readonly: true });
    const perFile = db.prepare(
      "SELECT file_path, COUNT(*) AS c FROM nodes WHERE project = ? AND label = 'Function' GROUP BY file_path"
    ).all(projectA) as Array<{ file_path: string; c: number }>;
    const total = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectA) as { c: number };
    const orphanEdges = (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectA) as { c: number }).c;
    db.close();

    expect(perFile).toHaveLength(FILE_COUNT);
    for (const row of perFile) expect(row.c).toBe(1);
    expect(total.c).toBe(FILE_COUNT * 2); // File node + Function node per file
    expect(orphanEdges).toBe(0);
  });

  it('assigns identical node IDs across identical parallel runs (determinism)', () => {
    if (!distAvailable) return;

    const resultB = runIndex(projectB, dirB);
    expect(resultB.status, resultB.output).toBe(0);
    expect(resultB.output).toContain(`Files indexed:   ${FILE_COUNT}`);

    // Same content, same dispatch order → identical ID assignment across
    // independent runs (the strict (seq, fileIndex) write order).
    expect(idSequence(projectB)).toEqual(idSequence(projectA));
  });
});
