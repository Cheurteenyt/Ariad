// v2/tests/cli/auto-index.test.ts
// Tests for the index-auto freshness gate, overlap lock, and schtasks
// wrapper assembly (R185). The guarded run itself is exercised manually on
// real projects; these tests pin the pure decision logic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAutoLock,
  atToCron,
  buildWrapperFiles,
  freshSkipReason,
  releaseAutoLock,
  readSuccessMarker,
} from '../../src/cli/commands/auto-index.js';

describe('freshSkipReason', () => {
  const now = new Date('2026-09-06T12:00:00Z');

  it('returns null (no skip) when no marker exists', () => {
    expect(freshSkipReason(null, 20, now)).toBeNull();
  });

  it('returns null (no skip) for an unparsable marker', () => {
    expect(freshSkipReason('not-a-date', 20, now)).toBeNull();
  });

  it('skips when the index is younger than the threshold', () => {
    const fresh = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    expect(freshSkipReason(fresh, 20, now)).toMatch(/fresh/);
  });

  it('does not skip when the index is older than the threshold', () => {
    const stale = new Date(now.getTime() - 30 * 3_600_000).toISOString();
    expect(freshSkipReason(stale, 20, now)).toBeNull();
  });

  it('treats a future timestamp as fresh', () => {
    const future = new Date(now.getTime() + 3_600_000).toISOString();
    expect(freshSkipReason(future, 20, now)).toMatch(/fresh/);
  });
});

describe('acquireAutoLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cbm-auto-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires when no lock exists and releases cleanly', () => {
    const lockPath = join(dir, 'p.auto.lock');
    const decision = acquireAutoLock(lockPath, new Date());
    expect(decision.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    releaseAutoLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('blocks while the holder is alive and the lock is young', () => {
    const lockPath = join(dir, 'p.auto.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const decision = acquireAutoLock(lockPath, new Date());
    expect(decision.acquired).toBe(false);
    expect(decision.reason).toMatch(/active/);
  });

  it('takes over a stale lock (old timestamp)', () => {
    const lockPath = join(dir, 'p.auto.lock');
    const old = new Date(Date.now() - 4 * 3_600_000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: old }));
    const decision = acquireAutoLock(lockPath, new Date());
    expect(decision.acquired).toBe(true);
  });

  it('takes over a lock whose holder pid is dead', () => {
    const lockPath = join(dir, 'p.auto.lock');
    // pid 4294967294 is extremely unlikely to exist; pidAlive returns false.
    writeFileSync(lockPath, JSON.stringify({ pid: 4294967294, startedAt: new Date().toISOString() }));
    const decision = acquireAutoLock(lockPath, new Date());
    expect(decision.acquired).toBe(true);
  });

  it('takes over an unreadable lock file', () => {
    const lockPath = join(dir, 'p.auto.lock');
    writeFileSync(lockPath, '{not json');
    const decision = acquireAutoLock(lockPath, new Date());
    expect(decision.acquired).toBe(true);
  });
});

describe('readSuccessMarker', () => {
  it('returns trimmed content or null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-auto-marker-'));
    try {
      const marker = join(dir, 'p.auto.success');
      expect(readSuccessMarker(marker)).toBeNull();
      writeFileSync(marker, ' 2026-09-06T10:00:00Z\n');
      expect(readSuccessMarker(marker)).toBe('2026-09-06T10:00:00Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildWrapperFiles', () => {
  it('generates a watchdog .cmd/.ps1 pair with env, args, and runtime cap', () => {
    const files = buildWrapperFiles({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliEntry: 'D:\\Ariad\\v2\\dist\\cli\\index.js',
      project: 'D-Systeme',
      rootPath: 'D:/',
      minAgeHours: 20,
      maxRuntimeMinutes: 90,
      exclude: ['$RECYCLE.BIN', 'System Volume Information'],
      logPath: 'C:\\Users\\x\\.cache\\codebase-memory-mcp\\D-Systeme.auto.log',
    });
    // The .cmd is a thin shim redirecting everything to the log.
    expect(files.cmd.startsWith('@echo off')).toBe(true);
    expect(files.cmd).toContain("Ariad-Index-D-Systeme.ps1");
    expect(files.cmd.endsWith('2>&1\r\n')).toBe(true);
    // The .ps1 watchdog raises env, launches the CLI, and hard-kills on cap.
    expect(files.ps1).toContain('max-old-space-size=24576');
    expect(files.ps1).toContain('UV_THREADPOOL_SIZE');
    expect(files.ps1).toContain("'index-auto', 'run'");
    expect(files.ps1).toContain("'--project', 'D-Systeme'");
    expect(files.ps1).toContain("'--exclude', '$RECYCLE.BIN'");
    expect(files.ps1).toContain("'--exclude', 'System Volume Information'");
    expect(files.ps1).toContain("'--min-age-hours', '20'");
    expect(files.ps1).toContain("'--max-runtime-minutes', '90'");
    expect(files.ps1).toContain('WaitForExit(6000000)');
    expect(files.ps1).toContain('taskkill /PID $p.Id /T /F');
  });
});

describe('atToCron', () => {
  it('converts HH:MM to "mm hh"', () => {
    expect(atToCron('03:30')).toBe('30 3');
    expect(atToCron('00:05')).toBe('5 0');
  });
});
