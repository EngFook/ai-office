import test from 'node:test';
import assert from 'node:assert/strict';
import { tightestQuota, quotaResetAt, quotaRemaining } from '../src/usage-utils.js';

const snapshot = quota => ({ quota });
const windows = (...remaining) => ({ observedAt: Date.now(), windows: remaining.map((remainingPercent, index) => ({ name: `Window ${index}`, remainingPercent })) });

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

test('legacy derived balance is rejected when its present source percentage is invalid', () => {
  for (const usedPercent of [null, undefined, '0', -1, 101, NaN]) {
    const window = { usedPercent, remainingPercent: 100 };
    assert.equal(quotaRemaining(window), null);
    assert.equal(tightestQuota(snapshot({ codex: { observedAt: Date.now(), windows: [window] } })), null);
  }
  assert.equal(quotaRemaining({ remainingPercent: 55 }), 55, 'remaining-only sources stay valid');
  assert.equal(quotaRemaining({ usedPercent: 0, remainingPercent: 100 }), 100, 'numeric zero is real capacity');
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
  assert.equal(quotaResetAt({ resetsText: 'Nov 9, 2026, 12am' }, observed, 'Asia/Singapore'), Date.parse('2026-11-09T00:00:00+08:00'));
  assert.equal(quotaResetAt({ resetsText: 'Jan 1 at 12am' }, Date.parse('2026-12-31T10:00:00+08:00'), 'Asia/Singapore'), Date.parse('2027-01-01T00:00:00+08:00'));
});

import { writeGrokQuota } from '../scripts/office-board.mjs';
import { readGrokQuota } from '../server/usage-bridge.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Grok quota file: written by CLI, read fresh, stale after 6h', t => {
  const dir = mkdtempSync(join(tmpdir(), 'grokq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, mode: 'enabled', providers: { 'grok-bot': { enabled: true } } }), { mode: 0o600 });
  const now = Date.parse('2026-11-02T10:15:00Z');
  writeGrokQuota({ usedPercent: 37.3, resetsAt: '2026-11-06T22:38:00Z', plan: 'Premium' }, { AI_OFFICE_HOME: dir }, now);
  const fresh = readGrokQuota(dir, now + 1000);
  assert.equal(fresh.error, null);
  assert.equal(Math.round(fresh.value.windows[0].remainingPercent), 63);
  assert.equal(fresh.value.windows[0].resetsAt, Date.parse('2026-11-06T22:38:00Z'));
  assert.equal(readGrokQuota(dir, now + 7 * 36e5).error, 'stale');
  assert.equal(readGrokQuota(join(dir, 'none')).error, 'stale');
  assert.throws(() => writeGrokQuota({ usedPercent: 140 }, { AI_OFFICE_HOME: dir }));
});

test('Grok rejects corrupt, missing and future quota evidence instead of implying capacity', t => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'reports'));
  const now = Date.now();
  for (const payload of [null, {}, { usedPercent: null, observedAt: now }, { usedPercent: -1, observedAt: now }, { usedPercent: 101, observedAt: now }, { usedPercent: 0, observedAt: null }, { usedPercent: 0, observedAt: now + 120000 }]) {
    writeFileSync(join(dir, 'reports/grok-quota.json'), JSON.stringify(payload));
    const report = readGrokQuota(dir, now);
    assert.equal(report.value, null); assert.equal(report.error, 'stale'); assert.equal(report.status.state, 'invalid');
  }
});


test('absolute reset text uses explicit UTC/IANA sources before a configured fallback zone', () => {
  const at = Date.parse('2026-11-02T02:00:00Z');
  assert.equal(quotaResetAt({ resetsText: '12pm UTC' }, at, 'Asia/Singapore'), Date.parse('2026-11-02T12:00:00Z'));
  assert.equal(quotaResetAt({ resetsText: '12pm (America/New_York)' }, at, 'UTC'), Date.parse('2026-11-02T17:00:00Z'));
  assert.equal(quotaResetAt({ resetsText: '12pm', timeZone: 'Asia/Kolkata' }, at, 'UTC'), Date.parse('2026-11-02T06:30:00Z'));
  assert.equal(quotaResetAt({ resetsText: '12pm' }, at, 'UTC'), Date.parse('2026-11-02T12:00:00Z'));
  assert.equal(quotaResetAt({ resetsText: '12pm' }, at), quotaResetAt({ resetsText: '12pm' }, at, Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.equal(quotaResetAt({ resetsText: '12pm (Unknown/Zone)' }, at), null);
  assert.equal(quotaResetAt({ resetsText: 'Feb 31, 2026, 12pm UTC' }, at), null);
});

test('DST reset parsing uses civil-day rollover, rejects gaps, and chooses the next repeated hour', () => {
  const zone = 'America/New_York';
  assert.equal(quotaResetAt({ resetsText: '10am' }, Date.parse('2026-03-07T16:00:00Z'), zone), Date.parse('2026-03-08T14:00:00Z'), 'spring rollover is 23 hours');
  assert.equal(quotaResetAt({ resetsText: '10am' }, Date.parse('2026-10-31T15:00:00Z'), zone), Date.parse('2026-11-01T15:00:00Z'), 'fall rollover is 25 hours');
  assert.equal(quotaResetAt({ resetsText: 'Mar 8, 2026, 2:30am' }, Date.parse('2026-03-08T05:00:00Z'), zone), null, 'nonexistent clock time must not produce a fabricated quota reset');
  assert.equal(quotaResetAt({ resetsText: '1:30am' }, Date.parse('2026-11-01T05:45:00Z'), zone), Date.parse('2026-11-01T06:30:00Z'), 'second occurrence is still upcoming');
  assert.equal(quotaResetAt({ resetsText: '1:30am' }, Date.parse('2026-11-01T04:00:00Z'), zone), Date.parse('2026-11-01T05:30:00Z'), 'first occurrence is selected when both are upcoming');
});

test('quota rejects old, missing, future and reset-past observations instead of displaying them as live',()=>{
 const now=Date.now();
 const data={quota:{codex:{observedAt:now-4*60000,windows:[{remainingPercent:36}]}}};
 assert.equal(tightestQuota(data,'Codex',now),null);
 data.quota.codex.observedAt=now;assert.equal(tightestQuota(data,'Codex',now).remaining,36);
 data.quota.codex.windows[0].resetsAt=now-1000;assert.equal(tightestQuota(data,'Codex',now),null);
 delete data.quota.codex.windows[0].resetsAt;delete data.quota.codex.observedAt;assert.equal(tightestQuota(data,'Codex',now),null);
 data.quota.codex.observedAt=now+120000;assert.equal(tightestQuota(data,'Codex',now),null);
});
