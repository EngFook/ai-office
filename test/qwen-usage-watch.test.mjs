import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observeUsage, sanitizeUsage } from '../server/qwen-usage-watch.mjs';
import { createQwenWatch, QWEN_PREREQUISITE } from '../server/qwen-watch.mjs';
import { createQwenWatchReport } from '../server/qwen-watch-report.mjs';
import { createUsageReader, usageBridge } from '../server/usage-bridge.mjs';
const ms = Date.parse('2026-11-03T01:00:00Z');
const minute = 60000;
const sample = (at = ms, used = 60, tokens = 10000) => ({ generatedAt: at, providers: [
  { provider: 'Claude Code', timeZone: 'Asia/Singapore', models: [{ today: { total: tokens } }] },
  { provider: 'Codex', timeZone: 'Asia/Singapore', models: [{ today: { total: tokens } }] },
  { provider: 'Gemini', models: [] }, { provider: 'Grok', models: [] },
  { provider: 'Local Qwen', timeZone: 'Asia/Singapore', noQuota: true, todayTokens: tokens, online: true, averageTokPerSecond: 12 },
], quota: Object.fromEntries(['claude', 'codex', 'gemini', 'grok'].map(p => [p, { observedAt: at, windows: p === 'gemini' ? [] : [{ name: 'Weekly', usedPercent: used, remainingPercent: 100 - used, resetsAt: ms + 86400000 }] }])) });
const forProvider = (result, provider) => result.events.filter(event => event.provider === provider);

test('five providers report concrete metrics, unknown Gemini quota and unlimited local Qwen', () => {
  const value = observeUsage(sample(), {}, ms);
  assert.deepEqual(Object.keys(value.usage), ['claude', 'codex', 'gemini', 'grok', 'local-qwen']);
  assert.equal(value.usage.claude.todayTokens, 10000);
  assert.equal(value.usage.codex.windows[0].usedPercent, 60);
  assert.equal(value.usage.gemini.quotaState, 'unknown');
  assert.equal(value.usage['local-qwen'].quotaState, 'no-quota');
  assert.equal(value.usage['local-qwen'].averageTokPerSecond, 12);
  assert.equal(value.usage.grok.windows[0].resetsAt, ms + 86400000);
  assert.equal(forProvider(value, 'codex')[0].type, 'quota-reset');
  assert.deepEqual(observeUsage(sample(), value.usage, ms).events, []);
});

test('near limit escalates to exhaustion with concrete numbers, only once per episode', () => {
  const near = observeUsage(sample(ms, 80), {}, ms);
  assert.equal(forProvider(near, 'codex').at(-1).type, 'quota');
  const exhausted = observeUsage(sample(ms + 5 * minute, 100), near.usage, ms + 5 * minute);
  const event = forProvider(exhausted, 'codex').find(e => e.type === 'quota-exhausted');
  assert.equal(event.severity, 'critical'); assert.equal(event.usage.remainingPercent, 0);
  assert.equal(event.usage.resetsAt, ms + 86400000);
  assert.equal(forProvider(exhausted, 'codex').filter(e => e.type === 'usage-rise').length, 1);
  assert.deepEqual(observeUsage(sample(ms + 5 * minute, 100), exhausted.usage, ms + 5 * minute).events, []);
  const recovered = observeUsage(sample(ms + 10 * minute, 10), exhausted.usage, ms + 10 * minute);
  assert.ok(forProvider(recovered, 'codex').some(e => e.type === 'quota-refreshed'));
  const again = observeUsage(sample(ms + 15 * minute, 100), recovered.usage, ms + 15 * minute);
  assert.notEqual(forProvider(again, 'codex').find(e => e.type === 'quota-exhausted').key, event.key);
});

test('token rise needs absolute and proportional growth in a comparable Singapore day', () => {
  const old = observeUsage(sample(), {}, ms).usage;
  const rise = observeUsage(sample(ms + 5 * minute, 60, 20000), old, ms + 5 * minute);
  for (const provider of ['claude', 'codex', 'local-qwen']) {
    const event = forProvider(rise, provider).find(e => e.type === 'usage-rise');
    assert.equal(event.usage.deltaTokens, 10000); assert.equal(event.usage.periodMinutes, 5);
  }
  assert.equal(observeUsage(sample(ms + 5 * minute, 60, 19999), old, ms + 5 * minute).events.filter(e => e.type === 'usage-rise').length, 0);
  const large = observeUsage(sample(ms, 60, 1000000), {}, ms).usage;
  assert.equal(observeUsage(sample(ms + 5 * minute, 60, 1010000), large, ms + 5 * minute).events.filter(e => e.type === 'usage-rise').length, 0);
  const midnight = Date.parse('2026-11-03T16:01:00Z');
  const prior = observeUsage(sample(midnight - 5 * minute), {}, midnight - 5 * minute).usage;
  assert.equal(observeUsage(sample(midnight, 60, 20000), prior, midnight).events.filter(e => e.type === 'usage-rise').length, 0);
});

test('daily token comparisons follow the source time zone, not a fixed Singapore day', () => {
  const midnight = Date.parse('2026-11-04T00:00:00Z');
  const before = sample(midnight - minute, 60, 10000), after = sample(midnight + minute, 60, 20000);
  for (const data of [before, after]) for (const provider of data.providers) provider.timeZone = 'UTC';
  const old = observeUsage(before, {}, midnight - minute).usage;
  assert.equal(observeUsage(after, old, midnight + minute).events.filter(event => event.type === 'usage-rise').length, 0);
  for (const data of [before, after]) for (const provider of data.providers) provider.timeZone = 'America/New_York';
  const sameDay = observeUsage(before, {}, midnight - minute).usage;
  assert.equal(observeUsage(after, sameDay, midnight + minute).events.filter(event => event.type === 'usage-rise').length, 3);
});

test('stale, missing, malformed and failed telemetry never becomes numeric quota evidence', () => {
  for (const patch of [data => { data.quota.codexError = 'PRIVATE'; }, data => { data.quota.codex.observedAt = ms - 31 * minute; }, data => { data.quota.codex.observedAt = ms + 2 * minute; }, data => { data.generatedAt = ms - 31 * minute; }]) {
    const data = sample(ms, 100); patch(data);
    const result = observeUsage(data, {}, ms);
    assert.equal(result.usage.codex.quotaState, 'unavailable');
    assert.deepEqual(result.usage.codex.windows, []);
    assert.deepEqual(forProvider(result, 'codex').map(e => e.type), ['quota-unavailable']);
  }
  const bad = sample(); bad.quota.codex.windows[0].remainingPercent = '0'; bad.quota.codex.windows[0].usedPercent = NaN;
  assert.equal(observeUsage(bad, {}, ms).usage.codex.quotaState, 'unknown');
  const data = sample(); data.providers.at(-1).usageError = 'PRIVATE LEDGER ERROR';
  assert.equal(observeUsage(data, {}, ms).usage['local-qwen'].tokensAvailable, false);
  assert.equal(observeUsage(null, {}, ms).usage['local-qwen'].quotaState, 'no-quota');
  const grok = sample(); grok.quota.grok.observedAt = ms - 5 * 3600000;
  assert.equal(observeUsage(grok, {}, ms).usage.grok.quotaState, 'available');
});

test('Qwen and quota panel use the same provider freshness limits', () => {
  const data = sample();
  data.quota.codex.observedAt = ms - 4 * minute;
  data.quota.claude.observedAt = ms - 16 * minute;
  data.quota.grok.observedAt = ms - 5 * 3600000;
  const observed = observeUsage(data, {}, ms);
  assert.equal(observed.usage.codex.quotaState, 'unavailable');
  assert.equal(observed.usage.claude.quotaState, 'unavailable');
  assert.equal(observed.usage.grok.quotaState, 'available');
  assert.deepEqual(observed.usage.codex.windows, []);
});

test('reset schedules, deadlines, reordered windows and relative estimates are deduplicated', () => {
  const data = sample(ms, 100); data.quota.codex.windows.push({ name: '5-hour', usedPercent: 20, resetsText: 'in 2h (Asia/Singapore)' });
  const initial = observeUsage(data, {}, ms);
  const updated = structuredClone(data); updated.generatedAt += 5 * minute; updated.quota.codex.observedAt += 5 * minute; updated.quota.codex.windows.reverse();
  const next = observeUsage(updated, initial.usage, ms + 5 * minute);
  assert.deepEqual(forProvider(next, 'codex'), []);
  const due = structuredClone(data); due.generatedAt += 5 * minute; due.quota.codex.observedAt += 5 * minute; due.quota.codex.windows[0].resetsAt = ms + minute;
  const firstDue = observeUsage(due, initial.usage, ms + 5 * minute);
  assert.ok(forProvider(firstDue, 'codex').some(e => e.type === 'quota-reset-due'));
  assert.ok(!forProvider(firstDue, 'codex').some(e => e.type === 'quota-exhausted'));
  assert.ok(!forProvider(observeUsage(due, firstDue.usage, ms + 5 * minute), 'codex').some(e => e.type === 'quota-reset-due'));
});

test('unavailable and unknown-reset alerts recur after recovery without losing episodes', () => {
  const data = sample(ms, 90); delete data.quota.codex.windows[0].resetsAt;
  const one = observeUsage(data, {}, ms);
  const down = sample(ms + 5 * minute); down.quota.codexError = 'unavailable';
  const two = observeUsage(down, one.usage, ms + 5 * minute);
  const up = sample(ms + 10 * minute, 10); delete up.quota.codex.windows[0].resetsAt;
  const three = observeUsage(up, two.usage, ms + 10 * minute);
  const low = sample(ms + 15 * minute, 90); delete low.quota.codex.windows[0].resetsAt;
  const four = observeUsage(low, three.usage, ms + 15 * minute);
  assert.notEqual(forProvider(one, 'codex').find(e => e.type === 'quota').key, forProvider(four, 'codex').find(e => e.type === 'quota').key);
  const againDown = structuredClone(down); againDown.generatedAt += 15 * minute;
  const five = observeUsage(againDown, four.usage, ms + 20 * minute);
  assert.notEqual(forProvider(two, 'codex')[0].key, forProvider(five, 'codex')[0].key);
});

test('offline watcher persists numeric events, retries publication, restores comparison across restart and cannot mutate tasks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-usage-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = ms, data = sample(), fail = false;
  const reports = createQwenWatchReport({ projectPath: root, now: () => clock });
  const store = new Proxy({ snapshot(options) { assert.deepEqual(options, { recoverLeases: false }); return { tasks: [{ id: QWEN_PREREQUISITE, status: 'done' }] }; } }, { get(target, key) { if (key in target) return target[key]; assert.fail(`forbidden mutation ${String(key)}`); } });
  const options = { store, now: () => clock, usageReader: async () => structuredClone(data), qwenClient: { run: async () => { throw new Error('offline'); } }, readReport: reports.read, publishReport: async value => { if (fail) throw new Error('disk'); return reports.publish(value); } };
  const watch = createQwenWatch(options); t.after(() => watch.stop());
  await watch.start(); await watch.stop();
  const restarted = createQwenWatch(options); t.after(() => restarted.stop());
  clock += 5 * minute; data = sample(clock, 100, 20000); fail = true;
  await restarted.start(); assert.match(restarted.status().error, /发布失败/);
  const keys = restarted.status().events.map(e => e.key);
  fail = false; await restarted.tick();
  const saved = await reports.read();
  assert.equal(saved.current.usage.codex.windows[0].remainingPercent, 0);
  assert.equal(saved.current.usage['local-qwen'].todayTokens, 20000);
  assert.ok(saved.events.some(e => e.type === 'usage-rise' && e.usage.deltaTokens === 10000));
  assert.ok(saved.events.some(e => e.type === 'quota-exhausted' && e.usage.resetsAt === ms + 86400000));
  assert.equal(restarted.status().events.length, keys.length);
  await restarted.tick(); assert.deepEqual(restarted.status().events, []);
  const before = saved.events.length;
  await restarted.stop(); const third = createQwenWatch(options); t.after(() => third.stop()); await third.start();
  assert.equal((await reports.read()).events.length, before);
  assert.match(await readFile(path.join(root, 'reports/qwen-watch.json'), 'utf8'), /额度已用完/);
});

test('report whitelist strips injected source strings and preserves only numeric usage facts', () => {
  const value = sanitizeUsage({ codex: { quotaState: 'available', tokensAvailable: true, observedAt: ms, resetsText: 'PRIVATE', raw: 'PRIVATE', windows: [{ windowId: 'a'.repeat(24), windowKind: 'weekly', usedPercent: 90, remainingPercent: 10, resetsAt: ms, resetsText: 'PRIVATE', secret: 'PRIVATE' }] }, PRIVATE: {} });
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.equal(value.codex.windows[0].usedPercent, 90);
});

test('panel endpoint and watch share one cached reader, refresh coalesces, errors recover', async () => {
  let clock = ms, calls = 0, shouldFail = false;
  const reader = createUsageReader({ now: () => clock, readUsage: async () => { calls++; if (shouldFail) throw new Error('unavailable'); return { generatedAt: clock, providers: [] }; }, quotaReader: () => ({ codex: { observedAt: clock, windows: [] } }), readGrokQuota: () => ({ value: null, error: 'stale' }) });
  const [panel, watch] = await Promise.all([reader(), reader()]); assert.equal(calls, 1); assert.deepEqual(panel, watch);
  panel.providers.push('mutation'); assert.deepEqual((await reader()).providers, []);
  let middleware;
  usageBridge({ reader }).configureServer({ middlewares: { use: value => { middleware = value; } } });
  let body, statusCode = 200;
  const response = { setHeader() {}, end(value) { body = JSON.parse(value); }, set statusCode(value) { statusCode = value; } };
  const request = { url: '/api/usage', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } };
  await middleware(request, response, () => assert.fail('matched route'));
  assert.deepEqual(body, watch); assert.equal(calls, 1);
  clock += 30000; shouldFail = true; await middleware(request, response, () => {}); assert.equal(statusCode, 500);
  shouldFail = false; await reader(); assert.equal(calls, 3);
  request.method = 'POST'; await middleware(request, response, () => {}); assert.equal(statusCode, 405); assert.equal(calls, 3);
});

test('gradual increases accumulate over 30 minutes and unknown reset stays quiet until a new episode', () => {
  let previous = observeUsage(sample(), {}, ms).usage;
  const first = observeUsage(sample(ms + 5 * minute, 69, 19999), previous, ms + 5 * minute);
  assert.ok(!forProvider(first, 'codex').some(e => e.type === 'usage-rise'));
  const second = observeUsage(sample(ms + 10 * minute, 78, 29998), first.usage, ms + 10 * minute);
  const rises = forProvider(second, 'codex').filter(e => e.type === 'usage-rise');
  assert.equal(rises.length, 2);
  assert.equal(rises.find(e => e.usage.deltaPercent).usage.deltaPercent, 18);
  assert.equal(rises.find(e => e.usage.deltaTokens).usage.deltaTokens, 19998);
  assert.equal(rises[0].usage.periodMinutes, 10);
  const data = sample(ms, 90); delete data.quota.codex.windows[0].resetsAt;
  const one = observeUsage(data, {}, ms);
  const later = structuredClone(data); later.generatedAt += 5 * minute; later.quota.codex.observedAt += 5 * minute;
  assert.deepEqual(forProvider(observeUsage(later, one.usage, ms + 5 * minute), 'codex'), []);
  const afterGap = observeUsage(sample(ms + 31 * minute, 90, 20000), previous, ms + 31 * minute);
  assert.ok(!forProvider(afterGap, 'codex').some(e => e.type === 'usage-rise'));
});

test('usage facts publish directly without model-generated quota arithmetic', async t => {
  let data = sample(), clock = ms, calls = 0;
  const reports = [];
  const watch = createQwenWatch({ store: { snapshot: () => ({ tasks: [{ id: QWEN_PREREQUISITE, status: 'done' }] }) }, now: () => clock,
    usageReader: async () => structuredClone(data), publishReport: async value => reports.push(value),
    qwenClient: { run: async () => { calls++; return 'Invented reset deadline'; } } });
  t.after(() => watch.stop());
  await watch.start(); clock += 5 * minute; data = sample(clock, 100);
  await watch.tick();
  assert.equal(calls, 0);
  const report = reports.at(-1), codexEvents = report.events.filter(e => e.provider === 'codex');
  assert.ok(codexEvents.some(e => e.type === 'quota-exhausted'));
  assert.ok(!codexEvents.some(e => e.type === 'quota'));
  assert.equal(codexEvents.filter(e => e.type === 'usage-rise').length, 1);
  assert.equal(report.usage.codex.windows[0].remainingPercent, 0);
  assert.doesNotMatch(report.observation, /Invented/);
});

test('stop during an asynchronous usage read prevents late publication', async () => {
  let release, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  let published = 0;
  const watch = createQwenWatch({ store: { snapshot: () => ({ tasks: [] }) }, usageReader: async () => { entered(); await new Promise(resolve => { release = resolve; }); return sample(); }, now: () => ms, publishReport: async () => { published++; } });
  const started = watch.start(); await gate;
  const stopped = watch.stop(); release(); await Promise.all([started, stopped]);
  assert.equal(published, 0); assert.equal(watch.status().phase, 'stopped');
});

test('restart followed by source failure retains saved comparison facts for recovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-usage-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reports = createQwenWatchReport({ projectPath: root, now: () => ms });
  const initial = observeUsage(sample(ms, 85), {}, ms);
  await reports.publish({ checkedAt: ms, phase: 'attention', progress: {}, issues: initial.issues, events: initial.events, usage: initial.usage });
  let unavailable = true;
  const watch = createQwenWatch({ store: { snapshot: () => ({ tasks: [{ id: QWEN_PREREQUISITE, status: 'done' }] }) }, now: () => ms + 5 * minute, readReport: reports.read, publishReport: reports.publish,
    usageReader: async () => { if (unavailable) throw new Error('source down'); return sample(ms + 5 * minute, 90); }, qwenClient: { run: async () => '' } });
  t.after(() => watch.stop());
  await watch.start();
  assert.equal((await reports.read()).current.usage.codex.windows[0].usedPercent, 85);
  unavailable = false; await watch.tick();
  assert.ok(!watch.status().events.some(e => e.provider === 'codex' && e.type === 'quota'));
  assert.equal((await reports.read()).current.usage.codex.windows[0].usedPercent, 90);
});
