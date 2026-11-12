import test from 'node:test';
import assert from 'node:assert/strict';
import { observeUsage } from '../server/qwen-usage-watch.mjs';

const now = Date.parse('2026-11-10T01:00:00+08:00');
const qwenOnly = extra => ({ generatedAt: now, providers: [{ provider: 'Local Qwen', todayTokens: 0, timeZone: 'UTC' }],
  quota: { claudeError: 'Disabled in office settings.', codexError: 'Disabled in office settings.', geminiError: 'Disabled in office settings.', grokError: 'Disabled in office settings.' }, ...extra });

test('explicit enabled scope excludes disabled providers instead of inventing missing-quota alerts', () => {
  const result = observeUsage(qwenOnly({ enabledProviders: ['local-qwen'] }), {}, now);
  assert.deepEqual(Object.keys(result.usage), ['local-qwen']);
  assert.equal(result.usage['local-qwen'].quotaState, 'no-quota');
  assert.deepEqual(result.issues, []); assert.deepEqual(result.events, []);
  assert.deepEqual(observeUsage(qwenOnly({ enabledProviders: [] }), result.usage, now), { usage: {}, issues: [], events: [] });
});

test('previous disabled-provider states disappear without new phantom alerts or refresh events', () => {
  const previous = observeUsage(qwenOnly(), {}, now).usage;
  assert.equal(Object.keys(previous).length, 5);
  const next = observeUsage(qwenOnly({ generatedAt: now + 1000, enabledProviders: ['local-qwen'] }), previous, now + 1000);
  assert.deepEqual(Object.keys(next.usage), ['local-qwen']);
  assert.deepEqual(next.issues, []); assert.deepEqual(next.events, []);
});

test('unknown scope IDs are ignored; absent or malformed scope retains legacy visibility', () => {
  const known = observeUsage(qwenOnly({ enabledProviders: ['not-an-office-provider', 'local-qwen', 'local-qwen'] }), {}, now);
  assert.deepEqual(Object.keys(known.usage), ['local-qwen']);
  assert.deepEqual(observeUsage(qwenOnly({ enabledProviders: ['not-an-office-provider'] }), {}, now), { usage: {}, issues: [], events: [] });
  for (const enabledProviders of [undefined, null, 'local-qwen', { 'local-qwen': true }, ['local-qwen', null]]) {
    const result = observeUsage(qwenOnly({ enabledProviders }), {}, now);
    assert.equal(Object.keys(result.usage).length, 5);
    assert.equal(result.issues.filter(item => item.type === 'quota-unavailable').length, 4);
  }
});
