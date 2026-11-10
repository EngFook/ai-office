import test from 'node:test';
import assert from 'node:assert/strict';
import { tightestQuota, quotaResetAt } from '../src/usage-utils.js';

const snapshot = quota => ({ quota });
const windows = (...remaining) => ({ windows: remaining.map((remainingPercent, index) => ({ name: `Window ${index}`, remainingPercent })) });

test('quota indicator selects the tightest available model window across providers', () => {
  const data = snapshot({ claude: windows(67, 25), codex: windows(40, 8), gemini: windows(95) });
  assert.equal(tightestQuota(data).provider, 'Codex');
  assert.equal(tightestQuota(data).remaining, 8);
  assert.equal(tightestQuota(data, 'Claude Code').remaining, 25);
  assert.equal(tightestQuota(data, 'Claude').remaining, 25);
  assert.equal(tightestQuota(data, 'Gemini').remaining, 95);
});

test('missing, errored and non-numeric quotas never imply available capacity', () => {
  assert.equal(tightestQuota(null), null);
  assert.equal(tightestQuota({}), null);
  assert.equal(tightestQuota(snapshot({ gemini: { status: 'Subscription login' } })), null);
  assert.equal(tightestQuota(snapshot({ claude: windows('10', NaN, null, undefined, Infinity) })), null);
  const data = snapshot({ claude: windows(2), claudeError: 'Sign-in needed', codex: windows(31) });
  assert.equal(tightestQuota(data).provider, 'Codex');
  assert.equal(tightestQuota(data, 'Claude Code'), null);
  assert.equal(tightestQuota(data, 'Grok'), null);
});

test('quota display bounds percentages without changing the original snapshot', () => {
  const data = snapshot({ codex: windows(120, -5) });
  assert.equal(tightestQuota(data).remaining, 0);
  assert.equal(data.quota.codex.windows[1].remainingPercent, -5);
  assert.equal(tightestQuota(snapshot({ claude: windows(120) })).remaining, 100);
});

const observed = Date.parse('2026-11-02T10:00:00+08:00');
test('reset times support server timestamps and CLI relative windows from observation time', () => {
  const timestamp = observed + 2 * 3600000;
  assert.equal(quotaResetAt({ resetsAt: timestamp, resetsText: 'unavailable' }, observed), timestamp);
  assert.equal(quotaResetAt({ resetsText: 'in 2h 15m (Asia/Singapore)' }, observed), observed + 135 * 60000);
  assert.equal(quotaResetAt({ resetsText: '1 day 3 hours 5 minutes' }, observed), observed + 1625 * 60000);
  assert.equal(quotaResetAt({ resetsText: 'unknown' }, observed), null);
  assert.equal(quotaResetAt({}, observed), null);
});

test('CLI clock and calendar resets are resolved in Singapore time with rollover', () => {
  assert.equal(quotaResetAt({ resetsText: '12pm (Asia/Singapore)' }, observed), Date.parse('2026-11-02T12:00:00+08:00'));
  assert.equal(quotaResetAt({ resetsText: '9am SGT' }, observed), Date.parse('2026-11-03T09:00:00+08:00'));
  assert.equal(quotaResetAt({ resetsText: 'Nov 9 at 10:30pm (Asia/Singapore)' }, observed), Date.parse('2026-11-09T22:30:00+08:00'));
  assert.equal(quotaResetAt({ resetsText: 'Nov 9, 2026, 12am' }, observed), Date.parse('2026-11-09T00:00:00+08:00'));
  assert.equal(quotaResetAt({ resetsText: 'Jan 1 at 12am' }, Date.parse('2026-12-31T10:00:00+08:00')), Date.parse('2027-01-01T00:00:00+08:00'));
});

import { writeGrokQuota } from '../scripts/office-board.mjs';
import { readGrokQuota } from '../server/usage-bridge.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Grok quota file: written by CLI, read fresh, stale after 6h', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grokq-'));
  const now = Date.parse('2026-11-02T10:15:00Z');
  writeGrokQuota({ usedPercent: 37.3, resetsAt: '2026-11-06T22:38:00Z', plan: 'Premium' }, { AI_OFFICE_DIR: dir }, now);
  const fresh = readGrokQuota(dir, now + 1000);
  assert.equal(fresh.error, null);
  assert.equal(Math.round(fresh.value.windows[0].remainingPercent), 63);
  assert.equal(fresh.value.windows[0].resetsAt, Date.parse('2026-11-06T22:38:00Z'));
  assert.equal(readGrokQuota(dir, now + 7 * 36e5).error, 'stale');
  assert.equal(readGrokQuota(join(dir, 'none')).error, 'stale');
  assert.throws(() => writeGrokQuota({ usedPercent: 140 }, { AI_OFFICE_DIR: dir }));
});
