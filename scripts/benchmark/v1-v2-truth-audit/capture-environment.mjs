#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function command(executable, args) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function requireOption(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Missing --${key.replaceAll('_', '-')}`);
  return value;
}

function windowsNodeLauncher(commandName, moduleParts) {
  const located = command('where.exe', [`${commandName}.cmd`])
    .split(/\r?\n/)
    .find(Boolean);
  if (!located) throw new Error(`Unable to locate ${commandName}.cmd`);
  return join(dirname(located), 'node_modules', ...moduleParts);
}

function toolVersion(commandName, moduleParts) {
  if (process.platform !== 'win32') return command(commandName, ['--version']);
  return command(process.execPath, [windowsNodeLauncher(commandName, moduleParts), '--version']);
}

const options = parseArgs(process.argv.slice(2));
const output = resolve(requireOption(options, 'output'));
const cpus = os.cpus();

const record = {
  schema_version: 1,
  captured_at_utc: new Date().toISOString(),
  invocation: requireOption(options, 'invocation'),
  preregistration_sha: requireOption(options, 'prereg_sha'),
  phase: requireOption(options, 'phase'),
  repetition: Number.parseInt(requireOption(options, 'repetition'), 10),
  model: requireOption(options, 'model'),
  reasoning: requireOption(options, 'reasoning'),
  repository: {
    head_sha: command('git', ['rev-parse', 'HEAD']),
    branch: command('git', ['branch', '--show-current']),
    status_short: command('git', ['status', '--short']),
  },
  operating_system: {
    platform: os.platform(),
    type: os.type(),
    release: os.release(),
    version: os.version(),
    architecture: os.arch(),
  },
  cpu: {
    model: cpus[0]?.model ?? 'unknown',
    logical_processors: cpus.length,
  },
  memory: {
    total_bytes: os.totalmem(),
  },
  runtime: {
    node: process.version,
    npm: toolVersion('npm', ['npm', 'bin', 'npm-cli.js']),
    codex: toolVersion('codex', ['@openai', 'codex', 'bin', 'codex.js']),
  },
};

if (!Number.isInteger(record.repetition) || record.repetition < 1) {
  throw new Error('--repetition must be a positive integer');
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
console.log(output);
