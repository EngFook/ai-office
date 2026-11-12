import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeEventHub, createClaudeLiveFeed } from '../src/claude-live.js';

function clock() {
  let now = 0, next = 0; const tasks = new Map();
  return { now: () => now, setTimer: (fn, ms) => { const id = ++next; tasks.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => tasks.delete(id),
    advance(ms) { const target = now + ms; for (;;) { const entry = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= target); if (!entry) break; tasks.delete(entry[0]); now = entry[1].at; entry[1].fn(); } now = target; },
    delays: () => [...tasks.values()].map(task => task.at - now).sort((a, b) => a - b) };
}
function eventSource() {
  const instances = [];
  class Source {
    constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; instances.push(this); }
    addEventListener(kind, fn) { this.handlers.set(kind, fn); }
    emit(kind, data) { this.handlers.get(kind)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  return { Source, instances };
}
const packet = (revision, extra = {}) => ({ revision, observedAt: '2026-11-10T00:00:00.000Z', sources: ['lifecycle'], ...extra });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function bus() {
  const listeners = new Set(); let state = { transport: 'connecting' };
  return { subscribe(fn) { listeners.add(fn); fn({ kind: 'state', state }); return () => listeners.delete(fn); }, emit(kind, transport = state.transport) { state = { ...state, transport }; for (const fn of listeners) fn({ kind, state }); }, get size() { return listeners.size; } };
}
const response = value => ({ ok: true, json: async () => value });

test('three consumers share one channel and bursts coalesce to the newest source revision', () => {
  const timers = clock(), { Source, instances } = eventSource();
  const hub = createClaudeEventHub({ EventSourceImpl: Source, ...timers });
  const seen = [[], [], []], stops = seen.map(events => hub.subscribe(event => events.push(event)));
  assert.equal(instances.length, 1); assert.equal(instances[0].url, '/api/claude/events');
  const channel = instances[0];
  channel.emit('snapshot', packet(0)); channel.emit('change', packet(1)); channel.emit('change', packet(2));
  channel.emit('change', packet(1)); channel.emit('change', packet(-1)); channel.emit('change', 'invalid');
  timers.advance(100);
  for (const events of seen) { const invalidations = events.filter(event => event.kind === 'invalidate'); assert.equal(invalidations.length, 1); assert.equal(invalidations[0].state.revision, 2); }
  stops[0](); stops[1](); assert.equal(channel.closed, false); stops[2](); assert.equal(channel.closed, true); assert.deepEqual(timers.delays(), []);
});

test('visible heartbeat reports degraded sources without refetching, and half-open channels recover', () => {
  const timers = clock(), { Source, instances } = eventSource(), events = [];
  const hub = createClaudeEventHub({ EventSourceImpl: Source, ...timers });
  const stop = hub.subscribe(event => events.push(event));
  const first = instances[0]; first.emit('snapshot', packet(7)); timers.advance(100);
  first.emit('heartbeat', packet(7, { fallbackSources: ['transcripts'] }));
  assert.deepEqual(events.at(-1).state.fallbackSources, ['transcripts']);
  assert.equal(events.filter(event => event.kind === 'invalidate').length, 1);
  timers.advance(45000);
  assert.equal(first.closed, true); assert.equal(events.at(-1).state.transport, 'fallback');
  timers.advance(1000); assert.equal(instances.length, 2);
  first.emit('change', packet(999));
  instances[1].emit('snapshot', packet(0)); timers.advance(100);
  assert.equal(events.at(-1).state.revision, 0); assert.equal(events.at(-1).state.transport, 'live');
  instances[1].emit('error'); assert.equal(events.at(-1).state.transport, 'fallback');
  instances[1].emit('snapshot', packet(1)); timers.advance(100);
  assert.equal(events.at(-1).state.transport, 'live'); stop();
});

test('events during a slow read queue only one follow-up without overlapping requests', async () => {
  const timers = clock(), events = bus(), requests = [], snapshots = [];
  let active = 0, peak = 0;
  const feed = createClaudeLiveFeed({ url: '/api/claude/workspace', events, ...timers, onSnapshot: data => snapshots.push(data), fetchImpl: async (_url, options) => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => requests.push({ options, finish(value) { active--; resolve(response(value)); } }));
  } });
  const running = feed.start(); assert.equal(requests.length, 1);
  events.emit('invalidate', 'live'); events.emit('invalidate'); events.emit('invalidate');
  requests[0].finish({ revision: 1 }); await flush(); assert.equal(requests.length, 2);
  requests[1].finish({ revision: 3 }); await running;
  assert.equal(peak, 1); assert.deepEqual(snapshots, [{ revision: 1 }, { revision: 3 }]);
  assert.deepEqual(timers.delays(), [30000]);
  await feed.stop(); assert.equal(events.size, 0); assert.deepEqual(timers.delays(), []);
});

test('connection loss switches to polling and failed reads retain records until a successful refresh', async () => {
  const timers = clock(), events = bus(), snapshots = [], errors = [];
  let calls = 0;
  const feed = createClaudeLiveFeed({ url: '/api/claude/status', events, pollMs: 2000, ...timers,
    onSnapshot: data => snapshots.push(data), onError: error => errors.push(error), fetchImpl: async () => { calls++; if (calls === 2) throw Error('offline'); return response({ agents: [] }); } });
  await feed.start(); events.emit('state', 'live'); assert.deepEqual(timers.delays(), [30000]);
  events.emit('state', 'fallback'); assert.deepEqual(timers.delays(), [2000]);
  timers.advance(2000); await flush(); assert.equal(errors.length, 1); assert.equal(snapshots.length, 1);
  timers.advance(2000); await flush(); assert.equal(calls, 3); assert.equal(snapshots.length, 2);
  await feed.stop();
});

test('changing the query or unmounting aborts the old request and cannot publish its late response', async () => {
  const timers = clock(), events = bus(), snapshots = []; let resolve, signal;
  const feed = createClaudeLiveFeed({ url: '/api/claude/background-tasks?sessionId=old', events, ...timers, onSnapshot: data => snapshots.push(data),
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
  const started = feed.start(); const stopping = feed.stop(); assert.equal(signal.aborted, true);
  resolve(response({ sessionId: 'old', tasks: [] })); await Promise.all([started, stopping]);
  assert.deepEqual(snapshots, []); assert.equal(events.size, 0); assert.deepEqual(timers.delays(), []);
});


test('heartbeat metadata does not postpone the periodic source verification read', async () => {
  const timers = clock(), events = bus(); let calls = 0;
  const feed = createClaudeLiveFeed({ url: '/api/claude/status', events, ...timers, onSnapshot() {}, fetchImpl: async () => { calls++; return response({ agents: [] }); } });
  await feed.start(); events.emit('state', 'live');
  timers.advance(15000); events.emit('state', 'live');
  assert.deepEqual(timers.delays(), [15000]);
  timers.advance(15000); await flush();
  assert.equal(calls, 2); await feed.stop();
});
