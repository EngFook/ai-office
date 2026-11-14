import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readGrokQuota, createUsageReader, createConfiguredUsage, readGeminiQuota, GROK_STALE_MS } from '../server/usage-bridge.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'grok-quota-status-'));
  mkdirSync(path.join(root, 'reports'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'reports', 'grok-quota.json');
  return { root, file, write: value => writeFileSync(file, JSON.stringify(value)) };
}
const now = Date.parse('2026-11-12T15:00:00Z');

test('Grok quota diagnostics distinguish absent, invalid, stale and expired-reset reports without refreshing observation time', t => {
  const { root, file, write } = fixture(t);
  assert.equal(readGrokQuota(root, now).status.state, 'missing');
  writeFileSync(file, 'broken json');
  assert.equal(readGrokQuota(root, now).status.state, 'invalid');
  write({ usedPercent: 94, observedAt: now - GROK_STALE_MS - 1, resetsAt: now + 86400000 });
  const before = readFileSync(file, 'utf8');
  const stale = readGrokQuota(root, now);
  assert.equal(stale.status.state, 'stale');
  assert.equal(stale.error, 'stale');
  assert.equal(stale.status.observedAt, now - GROK_STALE_MS - 1);
  assert.equal(stale.status.checkedAt, now);
  assert.equal(stale.value.observedAt, stale.status.observedAt);
  assert.equal(readFileSync(file, 'utf8'), before, 'reading must not rewrite old data as current');
  write({ usedPercent: 94, observedAt: now - 1000, resetsAt: now });
  const expired = readGrokQuota(root, now);
  assert.equal(expired.status.state, 'reset-expired');
  assert.equal(expired.error, 'stale', 'even recent reports cannot imply capacity after the reset');
  assert.equal(expired.status.expiresAt, now);
  write({ usedPercent: 0, observedAt: now, resetsAt: now + 86400000 });
  const fresh = readGrokQuota(root, now);
  assert.equal(fresh.status.state, 'fresh');
  assert.equal(fresh.error, null);
  assert.equal(fresh.value.windows[0].remainingPercent, 100);
  assert.equal(fresh.status.expiresAt, now + GROK_STALE_MS);
});

test('legacy usage refreshes Grok diagnostics while cached token history stays unchanged', async t => {
  const { root, write } = fixture(t);
  let clock = now, historyReads = 0;
  write({ usedPercent: 30, observedAt: now - 1000, resetsAt: now + 1000 });
  const reader = createUsageReader({ root, now: () => clock,
    readUsage: async () => { historyReads++; return { providers: [{ provider: 'Grok' }] }; }, quotaReader: () => ({}) });
  const initial = await reader();
  assert.equal(initial.quota.grokStatus.state, 'fresh');
  clock += 1000;
  const expired = await reader();
  assert.equal(expired.quota.grokStatus.state, 'reset-expired');
  assert.equal(expired.quota.grokError, 'stale');
  assert.equal(expired.quota.grok.observedAt, now - 1000);
  assert.equal(historyReads, 1);
});

test('configured usage exposes Grok report diagnostics only for the enabled provider', async t => {
  const { root, write } = fixture(t);
  write({ usedPercent: 20, observedAt: now });
  const config = { mode: 'enabled', dataDir: root, providers: { 'grok-bot': { enabled: true } } };
  const usage = createConfiguredUsage(config, null, { now: () => now });
  t.after(() => usage.stop());
  assert.equal((await usage.reader()).quota.grokStatus.state, 'fresh');
  config.providers['grok-bot'].enabled = false;
  assert.equal(usage.quotaReader().grokStatus, null);
  assert.equal(usage.quotaReader().grok, null);
});

test('Gemini login checks retry each minute and preserve classified failures instead of invented quota', async t => {
  const timers = []; let authenticated = false;
  const diagnostic = { authState: 'needs-login', authenticated: false, needsLogin: true, reason: 'Needs login',
    checkedAt: new Date(now).toISOString(), loginCommand: "'/fixture/agy'", modelIds: [], rawSecret: 'do-not-export' };
  const usage = createConfiguredUsage({ mode: 'enabled', providers: { gemini: { enabled: true, command: '/fixture/agy' } } }, null, {
    now: () => now, resolveCommand: command => command,
    setInterval: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearInterval: () => {},
    readGeminiQuota: async () => { if (!authenticated) throw Object.assign(new Error('classified'), { geminiReadiness: diagnostic });
      return { windows: [], status: 'Subscription login', authenticated: true, quotaState: 'unsupported', observedAt: now, modelIds: ['gemini-verified'] }; },
  });
  t.after(() => usage.stop());
  await usage.reader(); await setImmediate();
  let quota = usage.quotaReader();
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 60000);
  assert.equal(quota.gemini, null); assert.equal(quota.geminiStatus.authState, 'needs-login');
  assert.equal(quota.geminiStatus.loginCommand, "'/fixture/agy'");
  assert.equal(quota.geminiStatus.rawSecret, undefined);
  authenticated = true; timers[0].fn(); await setImmediate();
  quota = usage.quotaReader();
  assert.equal(quota.geminiError, null); assert.equal(quota.geminiStatus.authenticated, true);
  assert.deepEqual(quota.gemini.windows, []); assert.equal(quota.gemini.quotaState, 'unsupported');
  assert.equal(quota.geminiStatus.checkedAt, new Date(now).toISOString());
});

test('successful Gemini metadata explicitly says the CLI does not supply remaining quota', async () => {
  const value = await readGeminiQuota('/fixture/agy', { now: () => now, run: async () => 'gemini-verified' });
  assert.equal(value.authenticated, true); assert.equal(value.quotaState, 'unsupported');
  assert.deepEqual(value.windows, []); assert.equal(value.observedAt, now);
});
