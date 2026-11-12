import test from 'node:test';
import assert from 'node:assert/strict';
import { huddleQuota } from '../server/huddle-policy.mjs';
import { quotaFresh, quotaRemaining } from '../src/usage-utils.js';

const now = Date.parse('2026-11-10T01:00:00+08:00');
const minute = 60000;
const snapshot = (provider, observedAt = now, windows = [{ usedPercent: 10, remainingPercent: 90 }]) => ({ [provider]: { observedAt, windows } });

test('automatic huddle decisions use the same freshness limits as the displayed quota', () => {
  for (const [provider, displayName, limit] of [['codex', 'Codex', 3 * minute], ['claude', 'Claude Code', 15 * minute], ['gemini', 'Gemini', 15 * minute], ['grok', 'Grok', 6 * 60 * minute]]) {
    for (const elapsed of [limit, limit + 1]) {
      const data = snapshot(provider, now - elapsed);
      const fresh = quotaFresh(data[provider], displayName, now);
      const decision = huddleQuota(provider, data, {}, now);
      assert.equal(decision.allowed, fresh, `${provider}: ${elapsed}ms old`);
      if (!fresh) { assert.equal(decision.remainingPercent, null); assert.match(decision.reason, /过期/); }
    }
  }
  assert.equal(huddleQuota('codex', snapshot('codex', now + minute + 1), {}, now).allowed, false);
  assert.equal(huddleQuota('codex', { ...snapshot('codex'), codexError: 'Unavailable' }, {}, now).allowed, false);
});

test('invalid source usage cannot authorize work using a fabricated derived balance', () => {
  for (const usedPercent of [null, NaN, '10', -1, 101]) {
    const window = { usedPercent, remainingPercent: 100 };
    assert.equal(quotaRemaining(window), null);
    const decision = huddleQuota('codex', snapshot('codex', now, [window]), {}, now);
    assert.equal(decision.allowed, false); assert.equal(decision.remainingPercent, null);
  }
  const remainingOnly = { remainingPercent: 80 };
  assert.equal(huddleQuota('codex', snapshot('codex', now, [remainingOnly]), {}, now).allowed, true);
  for (const window of [{ remainingPercent: 0 }, { usedPercent: 0, remainingPercent: 100, resetsAt: now }]) {
    assert.equal(huddleQuota('codex', snapshot('codex', now, [{ remainingPercent: 90 }, window]), {}, now).allowed, false);
  }
  assert.equal(huddleQuota('local-qwen', null, {}, now).allowed, true);
});
