import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeSync, createClaudeLifecycleIndex } from '../server/claude-sync.mjs';
import { claudeBridge, readLifecycleEvents } from '../server/claude-bridge.mjs';
import { createClaudeWorkspaceReader } from '../server/claude-workspace.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-sync-'));
  for (const dir of ['ai-office/events', 'sessions', 'projects']) await mkdir(path.join(home, dir), { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const event = (name, time = 1000) => JSON.stringify({ event: name, sessionId: 'session', timestamp: time });
class Response extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.body = ''; }
  setHeader(name, value) { this.headers[name] = value; }
  write(text) { this.body += text; return true; }
  end(text = '') { this.body += text; this.writableEnded = true; this.emit('close'); }
}

test('SSE coalesces source changes, sends no paths or content, bounds clients and cleans up watches', async t => {
  const home = await fixture(t), watches = [], invalidations = [];
  const sync = createClaudeSync({ claudeHome: home, debounceMs: 5, heartbeatMs: 10, recoveryMs: 10000, maxClients: 1,
    onInvalidate: (...args) => invalidations.push(args), watchImpl(directory, options, callback) {
      const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; }; watches.push({ directory, options, callback, watcher }); return watcher;
    } });
  t.after(sync.close);
  const first = new Response(); sync.attach({}, first);
  assert.equal(watches.length, 3);
  assert.match(first.body, /event: snapshot/);
  const rejected = new Response(); sync.attach({}, rejected); assert.equal(rejected.statusCode, 503);
  watches[0].callback('rename', '.private.tmp');
  watches[0].callback('rename', 'private-event.json');
  watches[2].callback('change', 'private-project/session.jsonl');
  await delay(25);
  assert.equal((first.body.match(/event: change/g) || []).length, 1);
  assert.match(first.body, /event: heartbeat/);
  assert.ok(!first.body.includes('private'));
  assert.deepEqual(invalidations.map(([source]) => source), ['lifecycle', 'transcripts']);
  sync.close(); assert.ok(watches.every(w => w.watcher.closed)); assert.ok(first.writableEnded);
});

test('watch failure is reconciled and retried without turning raw errors into SSE data', async t => {
  const home = await fixture(t), watches = [];
  const sync = createClaudeSync({ claudeHome: home, debounceMs: 1, recoveryMs: 10, watchImpl(directory, options, callback) {
    const watcher = new EventEmitter(); watcher.close = () => {}; watches.push(watcher); return watcher;
  } }); t.after(sync.close);
  const response = new Response(); sync.attach({}, response); watches[0].emit('error', Error('PRIVATE ERROR'));
  await delay(30); assert.ok(watches.length >= 4); assert.ok(!response.body.includes('PRIVATE'));
});

test('a missing watch root is marked as fallback and rebuilt when restored; late errors cannot remove its replacement', async t => {
  const home = await fixture(t), watches = [];
  const sync = createClaudeSync({ claudeHome: home, debounceMs: 1, recoveryMs: 10, heartbeatMs: 5, watchImpl(directory, options, callback) {
    const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; }; watches.push({ directory, watcher }); return watcher;
  } }); t.after(sync.close);
  const response = new Response(); sync.attach({}, response);
  const root = path.join(home, 'ai-office/events'), first = watches.find(w => w.directory === root).watcher;
  await rm(root, { recursive: true }); await delay(30);
  assert.ok(first.closed);
  const payloads = () => response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(payloads().at(-1).fallbackSources.includes('lifecycle'));
  await mkdir(root); await delay(30);
  assert.ok(payloads().at(-1).watchedSources.includes('lifecycle'));
  first.emit('error', Error('late error')); await delay(10);
  assert.ok(payloads().at(-1).watchedSources.includes('lifecycle'));
});

test('lifecycle index reads only changed names between bounded reconciliation, including deletes and damaged records', async t => {
  const home = await fixture(t), inbox = path.join(home, 'ai-office/events'), reads = [];
  let now = 1000;
  await writeFile(path.join(inbox, 'first.json'), event('SessionStart'));
  const index = createClaudeLifecycleIndex({ inbox, now: () => now, reconcileMs: 100, readEvents(...args) { reads.push(args[3].changedFiles); return readLifecycleEvents(...args); } });
  assert.equal((await index.read()).length, 1); assert.equal(reads[0], undefined);
  await index.read(); assert.deepEqual(reads[1], []);
  await writeFile(path.join(inbox, 'next.json'), event('PreToolUse', 2000)); index.invalidate('next.json');
  assert.equal((await index.read()).length, 2); assert.deepEqual(reads[2], ['next.json']);
  await unlink(path.join(inbox, 'first.json')); index.invalidate('first.json'); assert.equal((await index.read()).length, 1);
  await writeFile(path.join(inbox, 'next.json'), 'broken'); index.invalidate('next.json'); const health = {};
  assert.equal((await index.read(health)).length, 0); assert.equal(health.unreadableRecords, 1);
  const stillBad = {}; await index.read(stillBad); assert.equal(stillBad.unreadableRecords, 1);
  await writeFile(path.join(inbox, 'missed.json'), event('Stop', 3000)); now += 101;
  assert.equal((await index.read()).length, 1); assert.equal(reads.at(-1), undefined);
});

test('event stream keeps existing local, same-origin and GET-only boundaries and closes with server', async t => {
  const home = await fixture(t), server = new EventEmitter(); let handler;
  claudeBridge({ claudeHome: home }).configureServer({ httpServer: server, middlewares: { use: value => { handler = value; } } });
  t.after(() => server.emit('close'));
  const base = { url: '/api/claude/events', method: 'GET', headers: { host: '127.0.0.1:5186' }, socket: { remoteAddress: '127.0.0.1' } };
  for (const extra of [{ method: 'POST' }, { socket: { remoteAddress: '10.0.0.2' } }, { headers: { host: '127.0.0.1:5186', origin: 'https://evil.test' } }]) {
    const response = new Response(); await handler({ ...base, ...extra }, response, () => assert.fail());
    assert.ok([403, 405].includes(response.statusCode)); assert.ok(!response.body.includes('event: snapshot'));
  }
  const response = new Response(); await handler(base, response, () => assert.fail()); assert.match(response.body, /event: snapshot/);
  server.emit('close'); assert.ok(response.writableEnded);
});

test('Vite plugin shutdown ends open streams before waiting for HTTP server close', async t => {
  const home = await fixture(t); let handler;
  const plugin = claudeBridge({ claudeHome: home });
  plugin.configureServer({ middlewares: { use: value => { handler = value; } } }); t.after(plugin.closeBundle);
  const response = new Response();
  await handler({ url: '/api/claude/events', method: 'GET', headers: { host: '127.0.0.1:5186' }, socket: { remoteAddress: '127.0.0.1' } }, response, () => assert.fail());
  plugin.closeBundle(); assert.ok(response.writableEnded);
});

test('new transcript becomes readable immediately after an earlier missing-source lookup', async t => {
  const home = await fixture(t), directory = path.join(home, 'projects', 'project'); await mkdir(directory);
  const read = createClaudeWorkspaceReader({ claudeHome: home });
  const agent = { id: 'session:main', sessionId: 'session', observed: true, status: 'working', isSubagent: false };
  assert.equal((await read({ agents: [agent] })).agents[0].sourceAvailable, false);
  await writeFile(path.join(directory, 'session.jsonl'), JSON.stringify({ type: 'user', sessionId: 'session', message: { role: 'user', content: 'A real assignment' } }) + '\n');
  assert.equal((await read({ agents: [agent] })).agents[0].instruction, 'A real assignment');
});

test('background endpoint waits for the latest scan instead of returning the previous snapshot', async t => {
  const home = await fixture(t), server = new EventEmitter(); let handler;
  await writeFile(path.join(home, 'ai-office/events', 'first.json'), event('UserPromptSubmit'));
  const project = path.join(home, 'projects', 'project'); await mkdir(project);
  const transcript = path.join(project, 'session.jsonl');
  const record = status => JSON.stringify({ type: 'attachment', sessionId: 'session', timestamp: status === 'running' ? '2026-01-01T00:00:00Z' : '2026-01-01T00:01:00Z', attachment: { type: 'task_status', taskId: 'command', taskType: 'local_bash', status } }) + '\n';
  await writeFile(transcript, record('running'));
  claudeBridge({ claudeHome: home }).configureServer({ httpServer: server, middlewares: { use: value => { handler = value; } } }); t.after(() => server.emit('close'));
  async function read() { const response = new Response(); await handler({ url: '/api/claude/background-tasks', method: 'GET', headers: { host: '127.0.0.1:5186' }, socket: { remoteAddress: '127.0.0.1' } }, response, () => assert.fail()); return JSON.parse(response.body); }
  assert.equal((await read()).counts.running, 1);
  await writeFile(transcript, record('running') + record('completed'));
  const updated = await read(); assert.equal(updated.counts.completed, 1); assert.equal(updated.counts.running, undefined); assert.equal(updated.indexing, false);
});
