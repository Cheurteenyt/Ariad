// v2/tests/indexer/discovery-exclude.test.ts
// Tests for config-driven discovery excludes (extraSkipDirs).

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';

describe('discoverSourceFilesStructured extraSkipDirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbm-exclude-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('excludes directories listed in extraSkipDirs, case-insensitively, at any depth', () => {
    mkdirSync(join(root, 'ai-cache'));
    mkdirSync(join(root, 'keep'));
    mkdirSync(join(root, 'nested', 'AICache'), { recursive: true });
    writeFileSync(join(root, 'root.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'ai-cache', 'junk.json'), '{}');
    writeFileSync(join(root, 'keep', 'good.ts'), 'export const b = 2;');
    writeFileSync(join(root, 'nested', 'AICache', 'junk2.json'), '{}');
    writeFileSync(join(root, 'nested', 'real.ts'), 'export const c = 3;');

    const result = discoverSourceFilesStructured(
      root,
      undefined,
      'full',
      new Set(['ai-cache']),
    );

    expect(result.complete).toBe(true);
    const normalized = result.files.map((f) => f.replaceAll('\\', '/'));
    expect(normalized.some((f) => /\/ai-cache\//i.test(f))).toBe(false);
    expect(normalized.some((f) => f.endsWith('/root.ts'))).toBe(true);
    expect(normalized.some((f) => f.endsWith('/good.ts'))).toBe(true);
    expect(normalized.some((f) => f.endsWith('/real.ts'))).toBe(true);
  });

  it('indexes everything when no extraSkipDirs are given', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'cbm-exclude-none-'));
    try {
      mkdirSync(join(root2, 'ai-cache'));
      writeFileSync(join(root2, 'ai-cache', 'data.json'), '{}');
      writeFileSync(join(root2, 'main.ts'), 'export const m = 1;');

      const result = discoverSourceFilesStructured(root2, undefined, 'full');

      expect(result.complete).toBe(true);
      expect(result.files.length).toBe(2);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});
