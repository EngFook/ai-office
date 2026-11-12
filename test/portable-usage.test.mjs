import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createConfiguredUsage, readClaudeQuota, readCodexQuota, readGeminiQuota, readCodexUsage } from '../server/usage-bridge.mjs';
const forbidden = () => assert.fail('Disabled provider must not be accessed');
const allEnabled = Object.fromEntries(['claude', 'codex', 'gemini', 'local-qwen', 'grok-bot'].map(key => [key, { enabled: true, command: key, model: 'configured-model' }]));
const noAccess = { readClaudeUsage: forbidden, readCodexUsage: forbidden, readClaudeQuota: forbidden, readCodexQuota: forbidden, readGeminiQuota: forbidden, readGrokQuota: forbidden, resolveCommand: forbidden, setInterval: forbidden };

test('disabled and read-only mode never read usage, quota, sessions, commands, Qwen or Grok', async () => {
  for (const mode of ['disabled', 'read-only', undefined]) {
    const usage = createConfiguredUsage({ mode, providers: allEnabled }, { snapshot: forbidden }, noAccess);
    const result = await usage.reader();
    assert.deepEqual(result.providers, []); assert.match(result.limitsNote, /disabled/);
    assert.equal(usage.quotaReader().claude, null);
    usage.stop(); await usage.reader();
  }
  const usage = createConfiguredUsage({ mode: 'enabled', providers: {} }, { snapshot: forbidden }, noAccess);
  assert.deepEqual((await usage.reader()).providers, []); usage.stop();
});

test('construction is side-effect free; enabled Codex alone uses configured command and caches only its logs', async () => {
  const calls = [], timers = [], cleared = [];
  const usage = createConfiguredUsage({ mode: 'enabled', providers: { codex: { enabled: true, command: '/custom/codex', model: 'model-x' } } }, { snapshot: forbidden }, {
    ...noAccess, home: '/fixture-user',
    resolveCommand(command) { calls.push(['command', command]); return command; },
    readCodexQuota: async options => { calls.push(['quota', options.command, options.model]); return { windows: [], observedAt: 123 }; },
    readCodexUsage: async home => { calls.push(['logs', home]); return { provider: 'Codex', models: [], limits: null }; },
    setInterval(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearInterval: timer => cleared.push(timer),
  });
  assert.deepEqual(calls, []); assert.deepEqual(timers, []);
  assert.deepEqual((await usage.reader()).providers.map(p => p.provider), ['Codex']);
  await setImmediate(); assert.equal(usage.quotaReader().codex.observedAt, 123);
  await usage.reader(); assert.equal(calls.filter(item => item[0] === 'logs').length, 1);
  assert.deepEqual(calls[1], ['quota', '/custom/codex', 'model-x']);
  assert.equal(timers.length, 1);
  usage.stop(); assert.deepEqual(cleared, timers);
  const before = calls.length; timers[0].fn(); await usage.reader(); usage.quotaReader(); assert.equal(calls.length, before);
});

test('stop aborts active quota work and prevents late results from changing state', async () => {
  let signal, resolveQuota;
  const usage = createConfiguredUsage({ mode: 'enabled', providers: { claude: { enabled: true, command: '/custom/claude' } } }, null, {
    ...noAccess, resolveCommand: command => command,
    readClaudeQuota: (_home, options) => { signal = options.signal; return new Promise(resolve => { resolveQuota = resolve; }); },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  });
  usage.quotaReader(); assert.equal(signal.aborted, false);
  usage.stop(); assert.equal(signal.aborted, true);
  resolveQuota({ windows: [], observedAt: 123 }); await setImmediate();
  assert.equal(usage.quotaReader().claude, null);
});

test('Qwen and Grok alone read configured private data; Gemini executable is never reported as authenticated', async () => {
  let qwenCalls = 0, grokRoot;
  const usage = createConfiguredUsage({ mode: 'enabled', dataDir: '/fixture-private-data', providers: { 'local-qwen': allEnabled['local-qwen'], 'grok-bot': allEnabled['grok-bot'] } }, {
    async snapshot() { qwenCalls++; return { provider: 'Local Qwen', model: 'custom:9b', todayTokens: 20 }; },
  }, { ...noAccess, readGrokQuota: root => { grokRoot = root; return { value: { windows: [] }, error: null }; } });
  const result = await usage.reader(); usage.stop();
  assert.equal(qwenCalls, 1); assert.equal(grokRoot, '/fixture-private-data');
  assert.deepEqual(result.providers.map(p => p.provider), ['Local Qwen', 'Grok']);
  const gemini = createConfiguredUsage({ mode: 'enabled', providers: { gemini: allEnabled.gemini } }, null, {
    ...noAccess, resolveCommand: command => command, readGeminiQuota: async () => { throw new Error('not logged in'); },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  });
  assert.match((await gemini.reader()).providers[0].limitsNote, /not been verified/); gemini.stop();
});

test('quota adapters resolve configured commands via PATH and absolute paths without launching real processes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'portable-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = path.join(dir, 'custom-cli'); await writeFile(command, 'fixture only'); await chmod(command, 0o700);
  const calls = [];
  const claude = await readClaudeQuota('/unused', { command: 'custom-cli', env: { PATH: dir }, run: async (bin, args) => { calls.push({ bin, args }); return JSON.stringify({ result: 'Current week: 12% used' }); } });
  assert.equal(claude.windows[0].remainingPercent, 88); assert.equal(calls[0].bin, command);
  const codex = await readCodexQuota({ command, run: async (bin, args) => { calls.push({ bin, args }); return JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 2, windowDurationMins: 300 } } } }); } });
  assert.equal(codex.windows[0].remainingPercent, 98); assert.equal(calls[1].bin, command);
  const gemini = await readGeminiQuota(command, { model: 'my-gemini-model', run: async () => 'gemini-custom' });
  assert.equal(gemini.model, 'my-gemini-model');
});

test('Codex missing or invalid percentage cannot become a fabricated 100% balance', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quota-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = path.join(dir, 'fixture-cli'); await writeFile(command, 'fixture'); await chmod(command, 0o700);
  for (const usedPercent of [null, undefined, '0', -1, 101]) {
    const result = await readCodexQuota({ command, run: async () => JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent, windowDurationMins: 300 } } } }) });
    assert.deepEqual(result.windows, [], String(usedPercent));
  }
  const result = await readCodexQuota({ command, run: async () => JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } } }) });
  assert.equal(result.windows[0].remainingPercent, 100, 'explicit numeric zero remains valid');
});

test('Codex log rate limits reject null used_percent and retain an explicit zero', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'quota-log-invalid-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.codex', 'sessions'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'sample.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: null }, secondary: { used_percent: 0 } } } }) + '\n');
  const result = await readCodexUsage(home);
  assert.equal(result.limits.primary, null);
  assert.equal(result.limits.secondary.remainingPercent, 100);
});


test('configured usage exposes explicit canonical provider scope on fresh, cached and stopped snapshots', async () => {
  const usage = createConfiguredUsage({ mode: 'enabled', providers: { 'local-qwen': allEnabled['local-qwen'], 'grok-bot': allEnabled['grok-bot'] } }, { snapshot: async () => ({ provider: 'Local Qwen' }) }, { ...noAccess, readGrokQuota: () => ({ value: null, error: 'unknown' }) });
  assert.deepEqual((await usage.reader()).enabledProviders, ['local-qwen', 'grok']);
  assert.deepEqual((await usage.reader()).enabledProviders, ['local-qwen', 'grok']);
  usage.stop(); assert.deepEqual((await usage.reader()).enabledProviders, []);
  const disabled = createConfiguredUsage({ mode: 'disabled', providers: allEnabled }, null, noAccess);
  assert.deepEqual((await disabled.reader()).enabledProviders, []); disabled.stop();
});

test('Gemini quota metadata verifies authentication without inventing quota and preserves failure categories', async () => {
  const value = await readGeminiQuota('/fixture/agy', { run: async () => 'gemini-actual' });
  assert.deepEqual(value.windows, []); assert.deepEqual(value.modelIds, ['gemini-actual']); assert.equal(value.authState, 'ready');
  for (const [output, expected] of [['Please sign in to view available models.', 'needs-login'], ['ECONNREFUSED', 'unavailable'], ['', 'unknown']]) {
    await assert.rejects(readGeminiQuota('/fixture/agy', { run: async () => ({ success: false, stderr: output }) }), error => error.geminiReadiness.authState === expected);
  }
});
