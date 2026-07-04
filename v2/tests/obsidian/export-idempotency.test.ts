// v2/tests/obsidian/export-idempotency.test.ts
// Regression test for CRITICAL bug: export was NOT idempotent because
// "Last sync" timestamp in the body changed on every export.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { generateVault } from '../../src/obsidian/generator.js';
import { readNote } from '../../src/obsidian/vault.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CRITICAL: export idempotency — sync twice should not re-write unchanged files', () => {
  let humanStore: HumanMemoryStore;
  let vaultPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-idempotency-'));
    vaultPath = join(tmpDir, 'vault');
    humanStore = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    humanStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('second export with no changes should report 0 updated', () => {
    const node = humanStore.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-001: Test idempotency',
      body_markdown: 'Some body content',
      tags: ['test'],
    });

    // First export
    const r1 = generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });
    expect(r1.created.length).toBeGreaterThan(0);

    // Second export — nothing changed, should be all unchanged
    const r2 = generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // CRITICAL: r2.updated must be 0 (no changes since r1)
    expect(r2.updated.length).toBe(0);
    expect(r2.unchanged.length).toBeGreaterThan(0);
  });

  it('third export is also idempotent', () => {
    humanStore.createNode({
      project: 'test',
      label: 'BugNote',
      title: 'Bug: idempotency test',
      body_markdown: 'Bug body',
    });

    const opts = {
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    };

    generateVault(opts);
    const r2 = generateVault(opts);
    const r3 = generateVault(opts);

    expect(r2.updated.length).toBe(0);
    expect(r3.updated.length).toBe(0);
  });

  it('does not contain "Last sync" in the body (only in frontmatter)', () => {
    humanStore.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-002: No last sync in body',
      body_markdown: 'Body',
    });

    const opts = {
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    };

    generateVault(opts);

    // Read the generated file
    const content = readNote(vaultPath, 'ADR/adr-002-no-last-sync-in-body.md');
    expect(content).not.toBeNull();
    // The body should NOT contain "Last sync" (it's in frontmatter as last_synced)
    const bodyStart = content!.indexOf('## AUTO-GENERATED');
    const bodySection = content!.substring(bodyStart);
    expect(bodySection).not.toContain('**Last sync**');
  });
});
