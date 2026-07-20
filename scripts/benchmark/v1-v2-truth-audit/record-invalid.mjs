#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const values = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '').replaceAll('-', '_');
  const value = process.argv[i + 1];
  if (!key || value === undefined) throw new Error('Every option requires a value.');
  values[key] = value;
}

for (const key of ['phase', 'mode', 'target', 'task', 'condition', 'attempt', 'reason']) {
  if (!values[key]) throw new Error(`Missing --${key.replaceAll('_', '-')}`);
}
const attempt = Number(values.attempt);
if (![1, 2].includes(attempt)) throw new Error('--attempt must be 1 or 2');
const root = resolve(values.results_root || 'D:/Mycodex/benchmark-results/r173-v1-v2-truth');
const path = resolve(root, 'invalid-runs.json');
const document = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { schema_version: 1, invalid: [] };
const entry = {
  phase: values.phase,
  mode: values.mode,
  target: values.target,
  task: values.task,
  condition: values.condition.toUpperCase(),
  attempt,
  reason: values.reason,
  recorded_at: new Date().toISOString(),
};
const key = ['phase', 'mode', 'target', 'task', 'condition', 'attempt'];
if (document.invalid.some((item) => key.every((field) => item[field] === entry[field]))) {
  throw new Error('This invalid attempt is already recorded.');
}
document.invalid.push(entry);
document.invalid.sort((a, b) => key.map((field) => a[field]).join('|').localeCompare(key.map((field) => b[field]).join('|')));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: existsSync(path) ? 'w' : 'wx' });
console.log(JSON.stringify({ path, entry }, null, 2));
