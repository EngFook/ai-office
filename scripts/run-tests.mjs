#!/usr/bin/env node
// Runs the test suite against a throwaway office data directory so no test can
// read or write the user's real ~/.ai-office configuration or board.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(tmpdir(), 'ai-office-test-home-'));
const requested = process.argv.slice(2);
const files = requested.length ? requested : readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('test', name));
const env = { ...process.env, AI_OFFICE_HOME: home, AI_OFFICE_HOOK_ANCESTOR_LOOKUP: 'off' };
// Install-specific overrides from the caller's shell must not leak into tests.
for (const key of ['AI_OFFICE_QWEN_WATCH_PREREQUISITES', 'AI_OFFICE_WORK_REPORT_PREREQUISITES']) delete env[key];
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, env, stdio: 'inherit' });
const cleanup = () => { try { rmSync(home, { recursive: true, force: true }); } catch {} };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { cleanup(); process.exit(signal ? 1 : code ?? 1); });
