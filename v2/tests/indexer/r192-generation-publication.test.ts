// v2/tests/indexer/r192-generation-publication.test.ts
// R192 (R169C): Atomic generation publication — indexer integration tests.
//
// Contract under test:
//   - A clean main-path run (errors=0, graph not stale) publishes the legacy
//     DB as a generation: IndexResult.generationPublication.status='published'
//     and the generation store resolves via resolveActiveCodeDb.
//   - A second run after a change publishes a NEW generation (CAS advances).
//   - Gates: env kill-switch → skipped('disabled-by-env'); non-certified
//     platform / errors / stale are pinned by the pure decision tests.
//   - Failure isolation: a publication failure NEVER fails the run — the
//     outcome downgrades to SUCCESS_WITH_WARNINGS and the legacy DB stays
//     the product of record.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import {
  generationPublicationDecision,
  GENERATION_PUBLICATION_DISABLED_ENV,
} from '../../src/indexer/generation-publication.js';
import { resolveActiveCodeDb } from '../../src/storage/generation-store.js';
import { projectStorageKey } from '../../src/storage/generation-paths.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R192 (R169C): generation publication gate (pure decision)', () => {
  const base = { platform: 'linux', envDisabled: false, hasErrors: false, crossFileStale: false };

  it('publishes on a clean Linux run', () => {
    expect(generationPublicationDecision(base)).toEqual({ publish: true });
  });

  it('skips when the env kill-switch is set', () => {
    expect(generationPublicationDecision({ ...base, envDisabled: true }))
      .toEqual({ publish: false, reason: 'disabled-by-env' });
  });

  it('skips on non-Linux platforms (R169B is Linux-certified only)', () => {
    expect(generationPublicationDecision({ ...base, platform: 'win32' }))
      .toEqual({ publish: false, reason: 'platform-not-certified' });
    expect(generationPublicationDecision({ ...base, platform: 'darwin' }))
      .toEqual({ publish: false, reason: 'platform-not-certified' });
  });

  it('skips runs with errors or a stale graph', () => {
    expect(generationPublicationDecision({ ...base, hasErrors: true }))
      .toEqual({ publish: false, reason: 'outcome-with-errors' });
    expect(generationPublicationDecision({ ...base, crossFileStale: true }))
      .toEqual({ publish: false, reason: 'stale-graph' });
  });
});

describe('R192 (R169C): indexer publication integration', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r192-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r192-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env[GENERATION_PUBLICATION_DISABLED_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('publishes a generation after a clean full index and the store resolves it', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);
    expect(result.generationPublication).toBeDefined();
    expect(result.generationPublication!.status).toBe('published');
    expect(result.generationPublication!.generationId).toBeTruthy();

    // The generation store resolves to the published snapshot.
    const resolved = resolveActiveCodeDb(projectName);
    expect(resolved.source).toBe('generation');
    if (resolved.source === 'generation') {
      expect(resolved.generationId).toBe(result.generationPublication!.generationId);
      const gdb = new Database(resolved.dbPath, { readonly: true });
      const nodes = (gdb.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
      gdb.close();
      expect(nodes).toBeGreaterThan(0);
    }

    // The manifest lives in the store layout under the test cache root,
    // keyed by sha256(project): <cbm>/projects/<key>/active-generation.json.
    expect(existsSync(join(cacheDir, 'codebase-memory-mcp', 'projects', projectStorageKey(projectName), 'active-generation.json'))).toBe(true);
  });

  it('publishes a NEW generation after a changed incremental run (CAS advances)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    const first = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(first.generationPublication!.status).toBe('published');

    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 2; }\nexport function fb() { return 3; }\n');
    const second = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(second.errors.length).toBe(0);
    expect(second.generationPublication!.status).toBe('published');
    expect(second.generationPublication!.generationId).not.toBe(first.generationPublication!.generationId);
    expect(second.generationPublication!.deduped).toBe(false);

    const resolved = resolveActiveCodeDb(projectName);
    expect(resolved.source).toBe('generation');
    if (resolved.source === 'generation') {
      expect(resolved.generationId).toBe(second.generationPublication!.generationId);
    }
  });

  it('skips publication when the env kill-switch is set', async () => {
    process.env[GENERATION_PUBLICATION_DISABLED_ENV] = '1';
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);
    expect(result.generationPublication!.status).toBe('skipped');
    expect(result.generationPublication!.reason).toBe('disabled-by-env');
    // No store layout for the project.
    expect(existsSync(join(cacheDir, 'codebase-memory-mcp', 'projects', projectStorageKey(projectName)))).toBe(false);
  });

  it('isolates publication failures: the run still succeeds, with a warning', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function fa() { return 1; }\n');
    // First index works and creates the project store…
    const first = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(first.generationPublication!.status).toBe('published');

    // …then make the project store's tmp/ read-only so the NEXT reserve
    // cannot create its O_EXCL staging file.
    const tmpDirInStore = join(cacheDir, 'codebase-memory-mcp', 'projects', projectStorageKey(projectName), 'tmp');
    expect(existsSync(tmpDirInStore)).toBe(true);
    chmodSync(tmpDirInStore, 0o500);
    try {
      const second = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
      });
      // The index itself succeeded; the legacy DB is the product of record.
      expect(second.errors.length).toBe(0);
      expect(second.nodes).toBeGreaterThan(0);
      expect(second.generationPublication!.status).toBe('failed');
      expect(second.generationPublication!.errorCode).toBeTruthy();
      // The outcome downgraded via the publication warning.
      expect(second.outcome).toBe('SUCCESS_WITH_WARNINGS');
      expect(second.warnings?.countsByCode?.GENERATION_PUBLICATION_FAILED).toBe(1);
      // The active generation is still the FIRST one.
      const resolved = resolveActiveCodeDb(projectName);
      if (resolved.source === 'generation') {
        expect(resolved.generationId).toBe(first.generationPublication!.generationId);
      }
    } finally {
      chmodSync(tmpDirInStore, 0o700);
    }
  });
});
