import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGrokConversation } from '../server/grok-conversation.mjs';

const BOT = '00000000-0000-4000-8000-000000000001';
const PREFIX = 'sand.client.slice.account.synthetic';
function encode(value) {
  let bits = 0, carry = 0, result = '';
  for (const byte of Buffer.from(value)) { carry = (carry << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += 'abcdefghijklmnopqrstuvwxyz234567'[(carry >>> bits) & 31]; } }
  if (bits) result += 'abcdefghijklmnopqrstuvwxyz234567'[(carry << (5 - bits)) & 31];
  return result + '.blob';
}
function setup(t, entries = []) {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-native-test-'));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const save = (key, value) => fs.writeFileSync(path.join(sourceDir, encode(`${PREFIX}.${key}`)), JSON.stringify({ schemaVersion: 1, value }));
  const cache = { entries, persistedAt: 1000000, acceptedSequenceHint: 999, precedingTimestampMs: 100 };
  save(`transcript.replicas.${BOT}`, cache);
  save('selection.last-agent', { agentId: BOT }); save('roster.last-roster', { rows: [{ id: BOT, name: 'Synthetic Bot' }] });
  return { sourceDir, save, cache, read: extra => readGrokConversation({ sourceDir, now: 1100000, ...extra }) };
}
const entry = (id, content = 'Synthetic message') => ({ kind: 'message', id, role: 'user', content, timestampMs: 100000, seq: Number(id.replace(/\D/g, '')) || 1 });
test('native cache reads actual roles and widgets, redacts secrets and never exposes non-message fields', t => {
  const f = setup(t, [entry('u1', 'crsr_' + 'SYNTHETIC_LONG_TOKEN_12345678 Authorization: Bearer SYNTHETIC_SECRET https://api2.cursor.sh/automations/webhook/SYNTHETIC_SECRET'), { kind: 'send-message', id: 'b1', timestampMs: 200000, seq: 2, message: { type: 'text', content: 'Actual synthetic reply' }, reasoning: 'DO_NOT_EXPOSE' }, { kind: 'send-message', id: 'w1', timestampMs: 200001, seq: 3, message: { type: 'widget', widget: { prompt: 'Synthetic choice?', options: [{ label: 'Yes', value: 'DO_NOT_EXPOSE' }] } } }, { kind: 'send-message', id: 's1', timestampMs: 200002, seq: 4, message: { type: 'secret-request', secretRequest: { description: 'DO_NOT_EXPOSE' } } }]);
  const result = f.read(); assert.equal(result.phase, 'ready'); assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].role, 'user'); assert.equal(result.messages[1].role, 'grok-bot'); assert.match(result.messages[2].text, /Synthetic choice\?\n• Yes/);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|SYNTHETIC_SECRET|SYNTHETIC_LONG_TOKEN/);
  assert.equal(result.upstreamComplete, false); assert.equal(result.earlierHistoryOmitted, true); assert.equal(result.sourceSequence, 999); assert.equal(result.sourceEntryCount, 4);
  assert.equal(result.bots[0].name, 'Synthetic Bot'); assert.equal(result.sourceAgeMs, 100000);
});
test('pagination is complete within a cache snapshot and detects changes instead of mixing revisions', t => {
  const f = setup(t, Array.from({ length: 250 }, (_, i) => entry(`u${i}`)));
  const newest = f.read({ limit: 80 }); const middle = f.read({ limit: 80, cursor: newest.nextCursor }); const oldest = f.read({ limit: 200, cursor: middle.nextCursor });
  const all = [...oldest.messages, ...middle.messages, ...newest.messages]; assert.equal(all.length, 250); assert.equal(new Set(all.map(x => x.id)).size, 250); assert.equal(oldest.hasMore, false);
  f.cache.persistedAt++; f.save(`transcript.replicas.${BOT}`, f.cache);
  assert.equal(f.read({ cursor: newest.nextCursor }).error, 'STALE_CURSOR');
  assert.equal(f.read({ cursor: 'bad' }).error, 'STALE_CURSOR'); assert.equal(f.read({ botId: '../secrets' }).error, 'UNKNOWN_BOT');
});
test('deduplicates exact source messages and fails closed for conflicting IDs', t => {
  const f = setup(t, [entry('u1'), entry('u1')]); assert.equal(f.read().messages.length, 1);
  f.cache.entries.push(entry('u1', 'different')); f.save(`transcript.replicas.${BOT}`, f.cache);
  assert.equal(f.read().error, 'CONFLICTING_SOURCE'); assert.deepEqual(f.read().messages, []);
});
test('voice transcripts include only visible turns; attachment payload and tool calls stay in original app', t => {
  const f = setup(t, [{ ...entry('v1'), kind: 'voice-call', conversation: { turns: [{ speaker: 'user', text: 'Question', atMs: 100000 }, { speaker: 'assistant', text: 'Answer', atMs: 100001 }], toolCalls: [{ content: 'DO_NOT_EXPOSE' }] } }, { ...entry('a1'), kind: 'user-attachment', file_path: 'DO_NOT_EXPOSE', file_name: 'DO_NOT_EXPOSE' }]);
  const result = f.read(); assert.equal(result.messages.length, 4); assert.equal(result.messages[1].role, 'user'); assert.equal(result.messages[2].role, 'grok-bot'); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/); assert.equal(result.omittedContentCount, 2);
});
test('missing source never creates files; malformed, symlink and unknown schema sources are rejected', t => {
  const f = setup(t, [entry('u1')]); const file = path.join(f.sourceDir, encode(`${PREFIX}.transcript.replicas.${BOT}`));
  const absent = path.join(f.sourceDir, 'absent'); assert.equal(readGrokConversation({ sourceDir: absent }).phase, 'empty'); assert.equal(fs.existsSync(absent), false);
  fs.writeFileSync(file, '{bad'); assert.equal(f.read().phase, 'unavailable');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, value: f.cache })); assert.equal(f.read().error, 'UNSUPPORTED_SOURCE');
  fs.renameSync(file, file + '.real'); fs.symlinkSync(file + '.real', file); assert.equal(f.read().phase, 'unavailable');
});
test('does not open unrelated persistence files or credential stores', t => {
  const f = setup(t, [entry('u1')]); fs.writeFileSync(path.join(f.sourceDir, 'sand-secrets.json'), 'not json');
  fs.writeFileSync(path.join(f.sourceDir, encode(`${PREFIX}.mcp.connect-logs`)), 'not json'); assert.equal(f.read().phase, 'ready');
});
test('credential URL userinfo and query parameters are redacted', t => {
  const f = setup(t, [entry('u1', 'https://synthetic-user:PRIVATE_SYNTHETIC_PASSWORD@example.test/page?key=PRIVATE_SYNTHETIC_KEY&x=1 https://example.test/?pwd=PRIVATE_SYNTHETIC_PWD Authorization:Bearer ' + 'PRIVATE_SYNTHETIC_BEARER')]);
  const text = f.read().messages[0].text;
  assert.doesNotMatch(text, /PRIVATE_SYNTHETIC/); assert.match(text, /https:\/\/\[REDACTED\]@example\.test/);
});
test('URL credentials are redacted before truncation even when the delimiter lies beyond the display boundary', t => {
  const content = 'x'.repeat(99960) + ' https://synthetic-user:PRIVATE_BOUNDARY_SECRET_PASSWORD@example.test/';
  assert.ok(content.indexOf('@') > 100000);
  const f = setup(t, [entry('u1', content), entry('u2', 'https://PRIVATE_USERNAME_ONLY_TOKEN@example.test/')]);
  const result = f.read();
  assert.equal(result.phase, 'ready'); assert.equal(result.messages[0].textTruncated, true);
  assert.ok(result.messages[0].text.length <= 100000);
  assert.doesNotMatch(result.messages[0].text, /PRIVATE_|synthetic-user/);
  assert.match(result.messages[0].text, /https:\/\/\[REDACTED\]@/);
  assert.equal(result.messages[1].text, 'https://[REDACTED]@example.test/');
});
