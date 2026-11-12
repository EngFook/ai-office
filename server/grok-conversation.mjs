import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { redactWorkspaceText } from './claude-workspace.mjs';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const REPLICA = new RegExp(`^(sand\\.client\\.slice\\.account\\..+)\\.transcript\\.replicas\\.(${UUID})$`, 'i');
const MAX_BYTES = 16 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function decodeKey(name) {
  if (!/^[a-z2-7]+\.blob$/i.test(name) || name.length > 1024) return '';
  let bits = 0, value = 0, decoded = '';
  for (const c of name.slice(0, -5).toUpperCase()) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; decoded += String.fromCharCode((value >>> bits) & 255); }
  }
  return decoded;
}
function readBlob(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_SOURCE');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value?.schemaVersion !== 1 || !value.value || typeof value.value !== 'object') fail('UNSUPPORTED_SOURCE');
    return value.value;
  } finally { fs.closeSync(fd); }
}
const iso = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toISOString() : null;
function safeText(value) { return redactWorkspaceText(value, 100000); }

function entryMessages(entry, botId) {
  const id = typeof entry.id === 'string' && entry.id.length <= 256 ? entry.id : null;
  if (!id || !iso(entry.timestampMs)) fail('INVALID_SOURCE');
  const base = { id: `${botId}:${id}`, sourceMessageId: id, timestamp: iso(entry.timestampMs), sequence: Number.isSafeInteger(entry.seq) ? entry.seq : null, kind: entry.kind, role: 'event', text: '', streaming: entry.isStreaming === true };
  const text = (value, role, extra = {}) => ({ ...base, role, text: safeText(value), textTruncated: typeof value === 'string' && value.length > 100000, ...extra });
  if (entry.kind === 'message' && ['user', 'assistant'].includes(entry.role)) return [text(entry.content, entry.role === 'user' ? 'user' : 'grok-bot')];
  if (entry.kind === 'send-message') {
    const message = entry.message || {};
    if (message.type === 'text') return [text(message.content, 'grok-bot')];
    if (message.type === 'widget') return [text([message.widget?.prompt, ...(message.widget?.options || []).map(option => typeof option?.label === 'string' ? `• ${option.label}` : '')].filter(Boolean).join('\n'), 'grok-bot', { kind: 'widget', readOnly: true })];
    // A secret-request is not a normal chat message. Never expose its payload,
    // response, target, tool output or any object not explicitly allowed here.
    return [{ ...base, kind: message.type === 'secret-request' ? 'secret-request' : 'unsupported', placeholder: true }];
  }
  if (entry.kind === 'voice-call') {
    const turns = entry.conversation?.turns;
    if (!Array.isArray(turns) || turns.length > 2000) return [{ ...base, placeholder: true }];
    return [{ ...base, placeholder: true }, ...turns.filter(turn => ['user', 'assistant'].includes(turn.speaker) && typeof turn.text === 'string').map((turn, index) => text(turn.text, turn.speaker === 'user' ? 'user' : 'grok-bot', { id: `${base.id}:voice:${index}`, sourceMessageId: `${id}:voice:${index}`, kind: 'voice-transcript', timestamp: iso(turn.atMs) || base.timestamp }))];
  }
  return [{ ...base, placeholder: true, kind: entry.kind === 'user-attachment' ? 'attachment' : 'event' }];
}

// Read the application's own saved visible transcript. No account tokens,
// cookies, cloud requests, UI automation, writes, wakeups or inferred messages.
export function readGrokConversation({ sourceDir = path.join(os.homedir(), 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence'), botId, defaultBotId = process.env.AI_OFFICE_GROK_BOT_ID, cursor, limit = 80, now = Date.now() } = {}) {
  const checkedAt = new Date(now).toISOString();
  const empty = { phase: 'empty', source: 'grok-bot-local-cache', checkedAt, bots: [], messages: [], hasMore: false, upstreamComplete: false };
  try {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID_REQUEST');
    let names;
    try {
      const stat = fs.lstatSync(sourceDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_SOURCE');
      names = fs.readdirSync(sourceDir);
    } catch (error) { if (error.code === 'ENOENT') return { ...empty, reason: 'SOURCE_NOT_FOUND' }; throw error; }
    if (names.length > 20000) fail('SOURCE_LIMIT');
    const keys = names.map(name => ({ name, key: decodeKey(name) }));
    const replicas = keys.map(item => ({ ...item, match: item.key.match(REPLICA) })).filter(item => item.match);
    if (!replicas.length) return { ...empty, reason: 'NO_CACHED_CONVERSATIONS' };
    if (replicas.length > 100) fail('SOURCE_LIMIT');
    const ids = new Set();
    for (const replica of replicas) { if (ids.has(replica.match[2])) fail('AMBIGUOUS_SOURCE'); ids.add(replica.match[2]); }
    let preferred = null;
    const labels = new Map();
    for (const prefix of new Set(replicas.map(item => item.match[1]))) {
      const roster = keys.find(item => item.key === `${prefix}.roster.last-roster`);
      const selection = keys.find(item => item.key === `${prefix}.selection.last-agent`);
      // Optional display metadata is never needed to read a transcript.
      try { for (const row of roster ? readBlob(path.join(sourceDir, roster.name)).rows || [] : []) if (ids.has(row.id)) labels.set(row.id, safeText(row.name).slice(0, 100)); } catch { /* Use stable Bot ID instead. */ }
      try { const selected = selection && readBlob(path.join(sourceDir, selection.name)).agentId; if (ids.has(selected)) preferred = selected; } catch { /* Use first cached Bot. */ }
    }
    const bots = replicas.map(item => ({ id: item.match[2], name: labels.get(item.match[2]) || `Bot ${item.match[2].slice(0, 8)}` }));
    const selectedId = botId || defaultBotId || preferred || bots[0].id;
    const selected = replicas.find(item => item.match[2] === selectedId);
    if (!selected) fail('UNKNOWN_BOT');
    const cache = readBlob(path.join(sourceDir, selected.name));
    if (!Array.isArray(cache.entries) || cache.entries.length > 10000 || !iso(cache.persistedAt)) fail('INVALID_SOURCE');
    const seen = new Map();
    for (const entry of cache.entries) {
      if (!entry || typeof entry !== 'object') fail('INVALID_SOURCE');
      for (const message of entryMessages(entry, selectedId)) {
        const prior = seen.get(message.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(message)) fail('CONFLICTING_SOURCE');
        seen.set(message.id, message);
      }
    }
    const messages = [...seen.values()];
    const revision = createHash('sha256').update(JSON.stringify([selectedId, cache.persistedAt, cache.acceptedSequenceHint, messages])).digest('hex').slice(0, 24);
    let end = messages.length;
    if (cursor) {
      const match = /^([a-f0-9]{24}):(\d+)$/.exec(cursor);
      if (!match || match[1] !== revision) fail('STALE_CURSOR');
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < 0 || end > messages.length) fail('INVALID_REQUEST');
    }
    const start = Math.max(0, end - limit);
    return { ...empty, phase: messages.length ? 'ready' : 'empty', bots, botId: selectedId, messages: messages.slice(start, end), revision, hasMore: start > 0, nextCursor: start > 0 ? `${revision}:${start}` : null, cachedAt: iso(cache.persistedAt), sourceAgeMs: Math.max(0, now - cache.persistedAt), sourceEntryCount: cache.entries.length, visibleMessageCount: messages.length, sourceSequence: Number.isSafeInteger(cache.acceptedSequenceHint) ? cache.acceptedSequenceHint : null, earlierHistoryOmitted: Boolean(cache.precedingTimestampMs), precedingTimestamp: iso(cache.precedingTimestampMs), cacheComplete: !messages.some(item => item.textTruncated), omittedContentCount: messages.filter(item => item.placeholder).length, redacted: true };
  } catch (error) {
    const known = ['UNSAFE_SOURCE', 'UNSUPPORTED_SOURCE', 'INVALID_SOURCE', 'SOURCE_LIMIT', 'AMBIGUOUS_SOURCE', 'UNKNOWN_BOT', 'CONFLICTING_SOURCE', 'STALE_CURSOR', 'INVALID_REQUEST'];
    return { ...empty, phase: 'unavailable', error: known.includes(error.code) ? error.code : 'SOURCE_UNAVAILABLE' };
  }
}
