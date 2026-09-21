// v2/tests/bridge/r193-reader-cutover.test.ts
// R193 (R169D): reader cutover to atomic generations.
//
// Contract under test:
//   - resolveCodeDbForRead prefers the active generation, falls back to the
//     legacy DB (missing → legacy path so not-found errors keep firing).
//   - activeGenerationChanged detects new publications for long-lived
//     readers and never throws (probe failure → "cannot prove a change").
//   - openCodeGraphReaderForRead reads the published generation's data.
//   - GC/recovery wiring after each publication retains
//     active + DEFAULT_RETAIN_COUNT (2) previous generations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import {
  resolveCodeDbForRead,
  activeGenerationChanged,
  openCodeGraphReaderForRead,
  defaultCodeDbPath,
} from '../../src/bridge/sqlite-ro.js';
import { projectStorageKey } from '../../src/storage/generation-paths.js';
import { GENERATION_PUBLICATION_DISABLED_ENV } from '../../src/indexer/generation-publication.js';

describe('R193 (R169D): reader cutover', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r193-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r193-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env[GENERATION_PUBLICATION_DISABLED_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function generationsDir(): string {
    return join(cacheDir, 'codebase-memory-mcp', 'projects', projectStorageKey(projectName), 'generations');
  }

  it('prefers the active generation when one is published', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const target = resolveCodeDbForRead(projectName);
    expect(target.source).toBe('generation');
    expect(target.generationId).toBe(result.generationPublication!.generationId);
    expect(target.dbPath).toContain('generation-');

    // A reader opened on the resolved target sees the generation's data.
    const { reader } = openCodeGraphReaderForRead(projectName);
    try {
      expect(reader.countNodes(projectName)).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });

  it('falls back to the legacy DB when publication is disabled', async () => {
    process.env[GENERATION_PUBLICATION_DISABLED_ENV] = '1';
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);
    expect(result.generationPublication!.status).toBe('skipped');

    const target = resolveCodeDbForRead(projectName);
    expect(target.source).toBe('legacy');
    expect(target.generationId).toBeNull();
    expect(target.dbPath).toBe(defaultCodeDbPath(projectName));
  });

  it('returns the legacy path for a project that was never indexed', () => {
    const target = resolveCodeDbForRead(projectName);
    expect(target.source).toBe('legacy');
    expect(target.generationId).toBeNull();
    expect(target.dbPath).toBe(defaultCodeDbPath(projectName));
  });

  it('activeGenerationChanged tracks publications for long-lived readers', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Nothing held yet → change (caller must open).
    expect(activeGenerationChanged(projectName, undefined)).toBe(true);

    const first = resolveCodeDbForRead(projectName);
    expect(activeGenerationChanged(projectName, first.dbPath)).toBe(false);

    // New publication → new generation → change detected.
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 2; }\n');
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    const second = resolveCodeDbForRead(projectName);
    expect(second.generationId).not.toBe(first.generationId);
    expect(activeGenerationChanged(projectName, first.dbPath)).toBe(true);
    expect(activeGenerationChanged(projectName, second.dbPath)).toBe(false);
  });

  it('GC after each publication retains active + 2 previous generations', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    for (let i = 2; i <= 4; i++) {
      writeFileSync(join(projectDir, 'a.ts'), `export function fa() { return ${i}; }\n`);
      const result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
      });
      expect(result.errors.length).toBe(0);
      expect(result.generationPublication!.status).toBe('published');
      expect(result.generationPublication!.gcError).toBeUndefined();
    }
    expect(existsSync(generationsDir())).toBe(true);
    const dbFiles = readdirSync(generationsDir()).filter((f) => f.endsWith('.db'));
    expect(dbFiles.length).toBeLessThanOrEqual(3);
  });
});
