import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import type { HumanMemoryStore } from '../../src/human/store.js';
import { LookupSourceTextTool } from '../../src/mcp/tools/lookup_source_text.js';

const tempDirs: string[] = [];

interface Harness {
  root: string;
  tool: LookupSourceTextTool;
  addIndexedPath(path: string): void;
  close(): void;
}

function createHarness(files: Record<string, string>): Harness {
  const tempDir = mkdtempSync(join(tmpdir(), 'cbm-exact-source-'));
  tempDirs.push(tempDir);
  const root = join(tempDir, 'repo');
  const dbPath = join(tempDir, 'code.db');
  mkdirSync(root, { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      project TEXT,
      label TEXT,
      name TEXT,
      qualified_name TEXT,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      properties_json TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      project TEXT,
      source_id INTEGER,
      target_id INTEGER,
      type TEXT,
      properties_json TEXT
    );
    CREATE TABLE projects (name TEXT, root_path TEXT);
  `);
  db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('test', root);
  const insertNode = db.prepare(`
    INSERT INTO nodes
      (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
    VALUES ('test', 'File', ?, ?, ?, 1, 1, '{}')
  `);

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = join(root, ...filePath.split('/'));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
    insertNode.run(filePath, `test::${filePath}`, filePath);
  }

  const codeReader = new CodeGraphReader(dbPath);
  const tool = new LookupSourceTextTool({
    project: 'test',
    humanStore: null as unknown as HumanMemoryStore,
    codeReader,
  });

  return {
    root,
    tool,
    addIndexedPath(filePath: string) {
      insertNode.run(filePath, `test::${filePath}`, filePath);
    },
    close() {
      codeReader.close();
      db.close();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('lookup_source_text', () => {
  it('finds batched exact literals with deterministic 1-based locations and source text', async () => {
    const harness = createHarness({
      'src/b.ts': 'export const second = "exact cross-domain relations";\n',
      'src/a.ts': [
        'const DEPENDENCY_ATLAS_MAX_DOMAINS = 12;',
        'const label = "Dependency atlas:";',
        '// Dependency atlas:',
      ].join('\r\n'),
    });
    try {
      const response = await harness.tool.handle({
        queries: [
          'DEPENDENCY_ATLAS_MAX_DOMAINS',
          'Dependency atlas:',
          'exact cross-domain relations',
        ],
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        project: 'test',
        results: [
          {
            query: 'DEPENDENCY_ATLAS_MAX_DOMAINS',
            matches: [{
              path: 'src/a.ts',
              line: 1,
              column: 7,
              text: 'const DEPENDENCY_ATLAS_MAX_DOMAINS = 12;',
            }],
            matches_truncated: false,
          },
          {
            query: 'Dependency atlas:',
            matches: [
              { path: 'src/a.ts', line: 2, column: 16, text: 'const label = "Dependency atlas:";' },
              { path: 'src/a.ts', line: 3, column: 4, text: '// Dependency atlas:' },
            ],
            matches_truncated: false,
          },
          {
            query: 'exact cross-domain relations',
            matches: [{
              path: 'src/b.ts',
              line: 1,
              column: 24,
              text: 'export const second = "exact cross-domain relations";',
            }],
            matches_truncated: false,
          },
        ],
        files_scanned: 2,
        bytes_scanned: 152,
        scan_complete: true,
      });
    } finally {
      harness.close();
    }
  });

  it('caps each query independently and reports truncation', async () => {
    const harness = createHarness({
      'src/repeated.ts': 'needle first\nneedle second\nother value\n',
    });
    try {
      const response = await harness.tool.handle({
        queries: ['needle', 'other'],
        max_results_per_query: 1,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.results[0]).toEqual({
        query: 'needle',
        matches: [{ path: 'src/repeated.ts', line: 1, column: 1, text: 'needle first' }],
        matches_truncated: true,
      });
      expect(payload.results[1]).toEqual({
        query: 'other',
        matches: [{ path: 'src/repeated.ts', line: 3, column: 1, text: 'other value' }],
        matches_truncated: false,
      });
    } finally {
      harness.close();
    }
  });

  it('never reads indexed traversal or symlink escapes', async () => {
    const harness = createHarness({ 'src/safe.ts': 'export const safe = true;\n' });
    const outsideDir = join(dirname(harness.root), 'outside');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'secret.ts'), 'DO_NOT_EXPOSE\n', 'utf8');
    symlinkSync(outsideDir, join(harness.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    harness.addIndexedPath('../outside/secret.ts');
    harness.addIndexedPath('escape/secret.ts');

    try {
      const response = await harness.tool.handle({ queries: ['DO_NOT_EXPOSE'] });
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.results[0].matches).toEqual([]);
      expect(payload.scan_complete).toBe(false);
      expect(payload.scan_incomplete_reasons).toEqual({ unsafe_paths: 2 });
      expect(response.content[0].text).not.toContain('DO_NOT_EXPOSE\\n');
    } finally {
      harness.close();
    }
  });

  it('rejects empty, multiline, duplicate, or oversized query batches', async () => {
    const harness = createHarness({ 'src/a.ts': 'value\n' });
    try {
      for (const queries of [
        [],
        ['   '],
        ['first\nsecond'],
        ['same', 'same'],
        Array.from({ length: 11 }, (_, index) => `q${index}`),
      ]) {
        const response = await harness.tool.handle({ queries });
        expect(response.isError).toBe(true);
      }
    } finally {
      harness.close();
    }
  });
});
