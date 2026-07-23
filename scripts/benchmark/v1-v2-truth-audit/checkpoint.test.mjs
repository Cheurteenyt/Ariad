import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { perTaskTables, ratioTable, rawManifest } from './checkpoint.mjs';

const aggregates = [
  { mode: 'one-shot', target: 'small', condition: 'B', raw_total_tokens: 200, tool_calls: 4 },
  { mode: 'one-shot', target: 'small', condition: 'C', raw_total_tokens: 100, tool_calls: 2 },
];

const runs = [
  { mode: 'one-shot', target: 'small', task: 'T01', condition: 'B', raw_total_tokens: '200', tool_calls: '4', tool_response_bytes: '80', grade: 'PASS', valid: 'true', attempt: '1' },
  { mode: 'one-shot', target: 'small', task: 'T01', condition: 'C', raw_total_tokens: '100', tool_calls: '2', tool_response_bytes: '40', grade: 'PARTIAL', valid: 'true', attempt: '1' },
];

test('checkpoint tables support a B/C-only structural round', () => {
  const ratios = ratioTable(aggregates);
  assert.match(ratios, /\| one-shot \| small \| n\/a \| n\/a \| 2\.000 \| n\/a \| n\/a \| n\/a \|/);

  const tasks = perTaskTables(runs, 'Structural correctness baseline');
  assert.match(tasks, /\| Task \| B: v2-mcp \| C: grep-read \|/);
  assert.match(tasks, /\| T01 \| 200 \/ 4 \/ 80 \/ PASS \/ valid \| 100 \/ 2 \/ 40 \/ PARTIAL \/ valid \|/);
  assert.doesNotMatch(tasks, /T02|A: V1 MCP|D: hybrid/);
});

test('raw manifest covers append-only environment captures but excludes derived output', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'checkpoint-environment-'));
  try {
    mkdirSync(join(root, 'baseline'), { recursive: true });
    mkdirSync(join(root, 'environment'), { recursive: true });
    mkdirSync(join(root, 'derived', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'baseline', 'run.meta.json'), '{}\n');
    writeFileSync(join(root, 'environment', 'invocation.json'), '{}\n');
    writeFileSync(join(root, 'derived', 'baseline', 'summary.json'), '{}\n');

    const manifest = await rawManifest(root, 'baseline');
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path), [
      'baseline/run.meta.json',
      'environment/invocation.json',
    ]);
    assert.deepEqual(manifest.excludes, ['derived/**']);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
