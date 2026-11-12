import test from 'node:test';
import assert from 'node:assert/strict';
import { providerWeeklyRemaining, providerQuotaExhausted, quotaFallbackProvider, quotaStopTargets, quotaRerouteTargets } from '../server/resolution-policy.mjs';

const now = Date.now();
const minute = 60000;
const quota = () => ({ codex: { observedAt: now, windows: [{ name: 'Weekly', usedPercent: 100, remainingPercent: 0, resetsAt: now + 60 * minute }] },
  claude: { observedAt: now, windows: [{ name: 'Weekly', usedPercent: 20, remainingPercent: 80, resetsAt: now + 60 * minute }] } });
const running = { id: 'running', status: 'running', provider: 'codex' };
const pending = { id: 'pending', status: 'pending', provider: 'codex', title: 'Ordinary task' };

test('only fresh verified exhaustion can stop a running worker or automatically move a task', () => {
  const fresh = quota();
  assert.equal(providerWeeklyRemaining(fresh, 'codex', now), 0);
  assert.equal(providerQuotaExhausted(fresh, 'codex', now), true);
  assert.deepEqual(quotaStopTargets([running], fresh, now), [running]);
  assert.deepEqual(quotaRerouteTargets([pending], fresh, now), [pending]);
  for (const mutate of [
    data => { data.codex.observedAt = now - 4 * minute; },
    data => { data.codex.observedAt = now + 2 * minute; },
    data => { delete data.codex.observedAt; },
    data => { data.codexError = 'Unavailable'; },
    data => { data.codex.windows[0].resetsAt = now; },
    data => { data.codex.windows[0].usedPercent = null; },
    data => { data.codex.windows[0].remainingPercent = -1; },
    data => { data.codex.windows[0].usedPercent = 0; },
  ]) {
    const data = quota(); mutate(data);
    assert.equal(providerWeeklyRemaining(data, 'codex', now), null);
    assert.equal(providerQuotaExhausted(data, 'codex', now), false);
    assert.deepEqual(quotaStopTargets([running], data, now), []);
    assert.deepEqual(quotaRerouteTargets([pending], data, now), []);
  }
});

test('automatic fallback requires positive fresh alternate quota and preserves review and human gates', () => {
  assert.equal(quotaFallbackProvider('codex', quota(), now), 'claude');
  for (const alternate of [undefined, { observedAt: now, windows: [] }, { observedAt: now - 16 * minute, windows: [{ name: 'Weekly', remainingPercent: 80 }] }, { observedAt: now, windows: [{ name: 'Weekly', remainingPercent: 0 }] }]) {
    const data = quota(); data.claude = alternate;
    assert.equal(quotaFallbackProvider('codex', data, now), null);
    assert.deepEqual(quotaRerouteTargets([pending], data, now), []);
  }
  const held = [
    { ...pending, kind: 'review' }, { ...pending, reviewOf: 'original' },
    { ...pending, paused: true }, { ...pending, userStopped: true },
    { ...pending, humanGate: { state: 'pending' } }, { ...pending, humanGate: { state: 'denied' } },
  ];
  assert.deepEqual(quotaRerouteTargets(held, quota(), now), []);
});

test('weekly summaries validate every relevant window and accept valid used-only evidence', () => {
  const data = quota();
  data.codex.windows = [{ name: '5-hour', remainingPercent: 0 }, { name: 'Weekly', remainingPercent: 60 }, { name: 'Weekly model', usedPercent: 65 }];
  assert.equal(providerWeeklyRemaining(data, 'codex', now), 35);
  data.codex.windows.push({ name: 'Weekly extra', usedPercent: null, remainingPercent: 100 });
  assert.equal(providerWeeklyRemaining(data, 'codex', now), null);
  assert.equal(providerWeeklyRemaining({}, 'codex', now), null);
  assert.equal(providerWeeklyRemaining(quota(), 'gemini', now), null);
});
