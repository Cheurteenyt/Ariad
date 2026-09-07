// v2/tests/indexer/edge-resolution-column.test.ts
// R186: tests for the typed edges.resolution column — resolver tagging,
// indexed cleanup, and the one-time backfill migration from the JSON marker.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initIndexerSchema } from '../../src/indexer/schema.js';
import { clearCrossFileCallEdges } from '../../src/indexer/cross-file-resolver.js';

let db: Database.Database;

function insertEdge(
  id: number,
  type: string,
  propertiesJson: string,
  resolution = '',
): void {
  db.prepare(
    `INSERT INTO edges (id, project, source_id, target_id, type, properties_json, resolution)
     VALUES (?, 'p', ?, ?, ?, ?, ?)`,
  ).run(id, id, id + 1000, type, propertiesJson, resolution);
}

beforeEach(() => {
  db = new Database(':memory:');
  initIndexerSchema(db);
  // Minimal project + nodes so FK-free edge rows have plausible context.
  db.prepare(
    `INSERT INTO projects (name, root_path, indexed_at) VALUES ('p', 'C:/tmp', '2026-09-06T00:00:00Z')`,
  ).run();
});

afterEach(() => {
  db.close();
});

describe('edges.resolution column (R186)', () => {
  it('initIndexerSchema creates the column, defaulting to empty string', () => {
    insertEdge(1, 'CALLS', JSON.stringify({ callee: 'a' }));
    const row = db.prepare('SELECT resolution FROM edges WHERE id = 1').get() as { resolution: string };
    expect(row.resolution).toBe('');
  });

  it('clearCrossFileCallEdges deletes only cross_file* CALLS edges', () => {
    insertEdge(1, 'CALLS', JSON.stringify({ resolution: 'cross_file' }), 'cross_file');
    insertEdge(2, 'CALLS', JSON.stringify({ resolution: 'cross_file_name_fallback' }), 'cross_file_name_fallback');
    insertEdge(3, 'CALLS', JSON.stringify({ resolution: 'intra_file' }), '');
    insertEdge(4, 'CONTAINS', JSON.stringify({}), '');

    const removed = clearCrossFileCallEdges(db, 'p');
    expect(removed).toBe(2);

    const remaining = db.prepare('SELECT id FROM edges ORDER BY id').all() as Array<{ id: number }>;
    expect(remaining.map(r => r.id)).toEqual([3, 4]);
  });

  it('clearCrossFileCallEdges removes cross_file_module_exact IMPORTS edges only', () => {
    insertEdge(1, 'IMPORTS', JSON.stringify({ resolution: 'cross_file_module_exact' }), 'cross_file_module_exact');
    insertEdge(2, 'IMPORTS', JSON.stringify({}), '');

    clearCrossFileCallEdges(db, 'p');
    const remaining = db.prepare('SELECT id FROM edges ORDER BY id').all() as Array<{ id: number }>;
    expect(remaining.map(r => r.id)).toEqual([2]);
  });

  it('migration backfills resolution from the JSON marker on legacy DBs', () => {
    // Simulate a legacy DB: edges table WITHOUT the resolution column and
    // rows carrying the old JSON markers.
    db.exec('DROP TABLE edges');
    db.exec(`CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties_json TEXT DEFAULT '{}'
    )`);
    db.prepare(`INSERT INTO edges (id, project, source_id, target_id, type, properties_json) VALUES
      (1, 'p', 1, 1001, 'CALLS', '{"resolution":"cross_file"}'),
      (2, 'p', 2, 1002, 'CALLS', '{"resolution":"intra_file"}'),
      (3, 'p', 3, 1003, 'IMPORTS', '{"resolution":"cross_file_module_exact"}'),
      (4, 'p', 4, 1004, 'CONTAINS', '{}')`).run();

    initIndexerSchema(db);

    const rows = db.prepare('SELECT id, resolution FROM edges ORDER BY id').all() as Array<{ id: number; resolution: string }>;
    expect(rows.map(r => r.resolution)).toEqual(['cross_file', 'intra_file', 'cross_file_module_exact', '']);

    // The indexed cleanup now also removes the backfilled legacy rows.
    const removed = clearCrossFileCallEdges(db, 'p');
    expect(removed).toBe(2);
    const remaining = db.prepare('SELECT id FROM edges ORDER BY id').all() as Array<{ id: number }>;
    expect(remaining.map(r => r.id)).toEqual([2, 4]);
  });
});
