// v2/src/cli/commands/auto-index.ts
// Guarded automatic indexing for scheduler-driven freshness (R185).
//
// `index-auto` (default action) runs ONE freshness-gated incremental refresh:
//   - freshness gate: skip when the last auto-index success is younger than
//     --min-age-hours (marker file, not the DB column — the gate must be
//     independent of indexer outcome bookkeeping);
//   - overlap lock: a lockfile next to the project DB with pid+startedAt; an
//     active lock (young age AND live pid) skips the run, a stale lock is
//     taken over;
//   - discovery runs with --discovery-tolerant semantics always on (drive-scale
//     ACL walls must not fail a nightly job);
//   - STALE outcome (extractor semantics mismatch) automatically reruns once
//     as a full index;
//   - a success marker is only written for SUCCESS / SUCCESS_WITH_WARNINGS so
//     a PARTIAL outcome retries failed files on the next scheduled run.
//
// `index-auto install` / `index-auto uninstall` register/unregister a Windows
// scheduled task (schtasks) that invokes the guarded run daily. The task
// points at a generated .cmd wrapper stored in the cache directory (a path
// without spaces, so /TR needs no nested quoting). Non-Windows platforms get
// an explicit error with the equivalent cron line instead.

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexProjectWasm } from '../../indexer/indexer.js';
import { loadConfig } from '../../config.js';
import { defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { cbmCacheDir } from '../../storage/generation-paths.js';
import { errorMessage } from '../../utils/error-message.js';
import type { DiscoveryMode } from '../../indexer/wasm-extractor.js';

const DEFAULT_MIN_AGE_HOURS = 20;
const STALE_LOCK_MS = 3 * 60 * 60 * 1000;
const SUCCESS_OUTCOMES = new Set(['SUCCESS', 'SUCCESS_WITH_WARNINGS']);
const LOG_TAIL_BYTES = 20_000;

interface AutoIndexOptions {
  project: string;
  rootPath: string;
  minAgeHours: number;
  force: boolean;
  exclude: string[];
  discoveryMode: DiscoveryMode;
}

export function autoLockPath(project: string): string {
  return join(cbmCacheDir(), `${project}.auto.lock`);
}

export function autoSuccessMarkerPath(project: string): string {
  return join(cbmCacheDir(), `${project}.auto.success`);
}

export function autoLogPath(project: string): string {
  return join(cbmCacheDir(), `${project}.auto.log`);
}

export function taskWrapperPath(project: string): string {
  return join(cbmCacheDir(), `Ariad-Index-${project}.cmd`);
}

export function taskName(project: string): string {
  return `Ariad-Index-${project}`;
}

/**
 * Freshness gate. `lastSuccessIso` comes from the auto-index success marker
 * (ISO string). Returns null when the index is fresh enough (skip), or a
 * human-readable reason when a refresh should run.
 */
export function freshSkipReason(
  lastSuccessIso: string | null,
  minAgeHours: number,
  now: Date,
): string | null {
  if (!lastSuccessIso) return null;
  const last = Date.parse(lastSuccessIso);
  if (!Number.isFinite(last)) return null;
  const ageHours = (now.getTime() - last) / 3_600_000;
  if (ageHours < minAgeHours) {
    return `index is fresh (${ageHours.toFixed(1)}h old < ${minAgeHours}h)`;
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LockDecision {
  acquired: boolean;
  reason: string;
}

/**
 * Overlap lock. An existing lock blocks the run only while it is young AND
 * its pid is alive; anything else (crash, reboot, orphaned lock) is taken
 * over. Caller MUST release on exit via releaseAutoLock.
 */
export function acquireAutoLock(
  lockPath: string,
  now: Date,
): LockDecision {
  if (existsSync(lockPath)) {
    let pid = 0;
    let startedAt = 0;
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid?: number;
        startedAt?: string;
      };
      pid = Number(parsed.pid ?? 0);
      startedAt = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    } catch {
      // Unreadable lock content — treat as stale below.
    }
    const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : Infinity;
    const holderAlive = pid > 0 && pidAlive(pid);
    if (holderAlive && age < STALE_LOCK_MS) {
      return { acquired: false, reason: `another index-auto run is active (pid ${pid}, started ${Math.round(age / 60000)}min ago)` };
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }));
  return { acquired: true, reason: 'lock acquired' };
}

export function releaseAutoLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort: a leftover lock is taken over by the next run.
  }
}

export function readSuccessMarker(markerPath: string): string | null {
  try {
    const value = readFileSync(markerPath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function buildWrapperContent(opts: {
  nodePath: string;
  cliEntry: string;
  project: string;
  rootPath: string;
  minAgeHours: number;
  exclude: string[];
  logPath: string;
}): string {
  const parts = [
    JSON.stringify(opts.nodePath),
    JSON.stringify(opts.cliEntry),
    'index-auto',
    'run',
    '--project', JSON.stringify(opts.project),
    '--root', JSON.stringify(opts.rootPath),
    '--min-age-hours', String(opts.minAgeHours),
  ];
  for (const name of opts.exclude) parts.push('--exclude', JSON.stringify(name));
  const command = parts.map((p) => (p.startsWith('"') ? p : `"${p}"`)).join(' ');
  return `@echo off\r\n${command} >> ${JSON.stringify(opts.logPath)} 2>&1\r\n`;
}

function appendLog(logPath: string, line: string): void {
  try {
    const previous = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').slice(-LOG_TAIL_BYTES)
      : '';
    writeFileSync(logPath, `${previous}${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging is best-effort; never fail the run for the log.
  }
}

function resolveCliEntry(): string {
  // dist/cli/commands/auto-index.js -> dist/cli/index.js
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(dirname(here)), 'index.js');
}

function readLastSuccessfulIndexAt(dbPath: string, project: string): string | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT last_successful_index_at AS v FROM projects WHERE name = ?')
      .get(project) as { v?: string | null } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function registerAutoIndexCommand(program: Command): void {
  const cmd = program
    .command('index-auto')
    .description('Freshness-gated, overlap-locked incremental index refresh designed for schedulers');

  cmd
    .command('run')
    .description('Run one guarded incremental refresh (freshness gate + overlap lock)')
    .option('--project <name>', 'Project name')
    .option('--root <path>', 'Root directory to index')
    .option('--min-age-hours <hours>', 'Skip when the last auto-index success is younger than this', '20')
    .option('--force', 'Ignore the freshness gate')
    .option('--exclude <names...>', 'Extra directory names to exclude from discovery')
    .action(async (opts) => {
      const config = loadConfig(resolve(opts.root || '.'));
      const options: AutoIndexOptions = {
        project: opts.project || config.projectName,
        rootPath: resolve(opts.root || '.'),
        minAgeHours: Number(opts.minAgeHours) || DEFAULT_MIN_AGE_HOURS,
        force: opts.force === true,
        exclude: Array.from(new Set([...(opts.exclude ?? []), ...config.exclude])),
        discoveryMode: 'full',
      };
      await runGuardedIndex(options);
    });

  cmd
    .command('install')
    .description('Register a daily Windows scheduled task that runs the guarded refresh')
    .requiredOption('--project <name>', 'Project name')
    .requiredOption('--root <path>', 'Root directory to index')
    .option('--at <HH:MM>', 'Daily start time', '03:00')
    .option('--min-age-hours <hours>', 'Freshness gate passed to the guarded run', String(DEFAULT_MIN_AGE_HOURS))
    .option('--task-name <name>', 'Scheduled task name (default: Ariad-Index-<project>)')
    .option('--exclude <names...>', 'Extra directory names to exclude from discovery')
    .action((opts) => {
      if (!/^\d{2}:\d{2}$/.test(String(opts.at))) {
        throw new Error(`--at must be HH:MM, received: ${opts.at}`);
      }
      const wrapper = taskWrapperPath(opts.project);
      const content = buildWrapperContent({
        nodePath: process.execPath,
        cliEntry: resolveCliEntry(),
        project: opts.project,
        rootPath: resolve(opts.root),
        minAgeHours: Number(opts.minAgeHours) || DEFAULT_MIN_AGE_HOURS,
        exclude: opts.exclude ?? [],
        logPath: autoLogPath(opts.project),
      });
      writeFileSync(wrapper, content);
      const name = opts.taskName || taskName(opts.project);
      if (process.platform !== 'win32') {
        throw new Error(
          'Scheduled-task installation is Windows-only. On Linux/macOS register the equivalent cron entry:\n' +
          `${atToCron(opts.at)} * * * ${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCliEntry())} index-auto --project ${opts.project} --root ${JSON.stringify(resolve(opts.root))}`,
        );
      }
      const result = spawnSync(
        'schtasks',
        ['/Create', '/F', '/TN', name, '/SC', 'DAILY', '/ST', String(opts.at), '/TR', wrapper],
        { encoding: 'utf8', windowsHide: true },
      );
      if (result.status !== 0) {
        throw new Error(`schtasks /Create failed (code ${result.status}): ${(result.stdout || '') + (result.stderr || '')}`);
      }
      console.log(`Scheduled task "${name}" created (daily at ${opts.at}).`);
      console.log(`Wrapper: ${wrapper}`);
      console.log(`Log: ${autoLogPath(opts.project)}`);
    });

  cmd
    .command('uninstall')
    .description('Remove the scheduled task and the generated wrapper')
    .requiredOption('--project <name>', 'Project name')
    .option('--task-name <name>', 'Scheduled task name (default: Ariad-Index-<project>)')
    .action((opts) => {
      const name = opts.taskName || taskName(opts.project);
      if (process.platform === 'win32') {
        const result = spawnSync(
          'schtasks',
          ['/Delete', '/F', '/TN', name],
          { encoding: 'utf8', windowsHide: true },
        );
        if (result.status !== 0) {
          throw new Error(`schtasks /Delete failed (code ${result.status}): ${(result.stdout || '') + (result.stderr || '')}`);
        }
      }
      rmSync(taskWrapperPath(opts.project), { force: true });
      console.log(`Scheduled task "${name}" removed.`);
    });
}

export function atToCron(at: string): string {
  const [hh, mm] = at.split(':').map((part) => Number(part));
  return `${mm} ${hh}`;
}

async function runGuardedIndex(options: AutoIndexOptions): Promise<void> {
  const started = Date.now();
  const logPath = autoLogPath(options.project);
  const lockPath = autoLockPath(options.project);
  const markerPath = autoSuccessMarkerPath(options.project);
  const dbPath = defaultCodeDbPath(options.project);

  appendLog(logPath, `index-auto run start (project=${options.project}, root=${options.rootPath}, force=${options.force})`);

  const lock = acquireAutoLock(lockPath, new Date());
  if (!lock.acquired) {
    console.log(`[index-auto] skipped: ${lock.reason}`);
    appendLog(logPath, `skipped: ${lock.reason}`);
    return;
  }

  try {
    if (!options.force) {
      const lastSuccess = readSuccessMarker(markerPath)
        ?? readLastSuccessfulIndexAt(dbPath, options.project);
      const skip = freshSkipReason(lastSuccess, options.minAgeHours, new Date());
      if (skip) {
        console.log(`[index-auto] skipped: ${skip}`);
        appendLog(logPath, `skipped: ${skip}`);
        return;
      }
    }

    const runOnce = async (incremental: boolean) => indexProjectWasm({
      project: options.project,
      rootPath: options.rootPath,
      incremental,
      useWasm: true,
      discoveryTolerant: true,
      exclude: options.exclude,
      discoveryMode: options.discoveryMode,
    });

    let result = await runOnce(true);
    if (result.outcome === 'STALE') {
      console.log('[index-auto] incremental returned STALE (semantics mismatch) — running a full reindex');
      result = await runOnce(false);
    }

    const summary = `outcome=${result.outcome} files=${result.files} nodes=${result.nodes} edges=${result.edges} errors=${result.errors.length} durationMs=${result.durationMs}`;
    console.log(`[index-auto] ${summary}`);
    appendLog(logPath, summary);
    if (result.warnings && result.warnings.total > 0) {
      console.log(`[index-auto] warnings: ${result.warnings.total}`);
    }

    const outcome = result.outcome ?? 'FAILED';
    if (SUCCESS_OUTCOMES.has(outcome)) {
      writeFileSync(markerPath, new Date().toISOString());
      appendLog(logPath, `success marker updated (${Math.round((Date.now() - started) / 1000)}s total)`);
      return;
    }
    if (outcome === 'PARTIAL') {
      // Graph published but some files failed extraction: do NOT mark fresh so
      // the next scheduled run retries the failed files.
      console.error('[index-auto] PARTIAL outcome — success marker not updated; the next run will retry failed files');
      appendLog(logPath, 'PARTIAL outcome — success marker not updated');
      process.exitCode = 1;
      return;
    }
    console.error(`[index-auto] ${outcome} outcome — see the log and result warnings above`);
    appendLog(logPath, `${outcome} outcome`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`[index-auto] failed: ${errorMessage(error)}`);
    appendLog(logPath, `failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    releaseAutoLock(lockPath);
  }
}
