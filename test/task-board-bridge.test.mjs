import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

async function fixture(t, callbacks = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-board-http-'));
  await mkdir(path.join(home, 'project'));
  const store = createTaskStore({ home });
  t.after(() => store.close()); t.after(() => rm(home, { recursive: true, force: true }));
  let middleware;
  taskBoardBridge({ store, ...callbacks }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const request = async (url, { method = 'GET', input, headers = {}, address = '127.0.0.1', raw } = {}) => {
    const stream = Readable.from(raw == null ? input == null ? [] : [Buffer.from(JSON.stringify(input))] : [Buffer.from(raw)]);
    Object.assign(stream, { url, method, headers: { host: '127.0.0.1:5173', ...(input != null || raw != null ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: address } });
    let content; const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { content = value; } };
    await middleware(stream, response, () => assert.fail('Expected board route'));
    return { status: response.statusCode, body: JSON.parse(content), headers: response.headers };
  };
  const board = await request('/api/office/board');
  const tokenHeaders = { 'x-office-token': board.body.csrfToken };
  return { store, request, tokenHeaders, projectPath: path.join(home, 'project') };
}

test('same-origin loopback plus CSRF token and bounded JSON are required for mutations', async t => {
  const { request, tokenHeaders } = await fixture(t);
  assert.equal((await request('/api/office/board', { address: '10.0.0.1' })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'No token' } })).status, 403);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'Wrong content' }, headers: { ...tokenHeaders, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/office/tasks', { method: 'POST', raw: '{', headers: tokenHeaders })).status, 400);
  assert.equal((await request('/api/office/tasks', { method: 'POST', raw: 'x'.repeat(128 * 1024 + 1), headers: tokenHeaders })).status, 413);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'CLI without Origin' }, headers: tokenHeaders })).status, 201);
});

test('task routes persist claims and results without exposing claim tokens in snapshots', async t => {
  const { request, tokenHeaders, projectPath } = await fixture(t);
  const created = await request('/api/office/tasks', { method: 'POST', headers: tokenHeaders, input: { title: 'Work', projectPath } });
  const id = created.body.task.id;
  const edited = await request(`/api/office/tasks/${id}`, { method: 'PATCH', headers: tokenHeaders, input: { title: 'Updated', version: 1 } });
  assert.equal(edited.body.task.title, 'Updated');
  const claim = await request('/api/office/tasks/claim-next', { method: 'POST', headers: tokenHeaders, input: { worker: { id: 'worker', provider: 'codex', role: 'Helper', projectPath } } });
  assert.equal(claim.body.task.id, id);
  const claimToken = claim.body.claimToken;
  assert.ok(!JSON.stringify((await request('/api/office/board')).body).includes(claimToken));
  assert.equal((await request(`/api/office/tasks/${id}/heartbeat`, { method: 'POST', headers: tokenHeaders, input: { claimToken } })).status, 200);
  const finished = await request(`/api/office/tasks/${id}/finish`, { method: 'POST', headers: tokenHeaders, input: { claimToken, status: 'done', result: 'Verified result' } });
  assert.equal(finished.body.task.status, 'done');
  assert.equal(finished.body.task.result, 'Verified result');
});

test('management instructions return immediately and callback failures are sanitized and retryable', async t => {
  let settle;
  const neverUntilReleased = new Promise(resolve => { settle = resolve; });
  let calls = 0;
  const { request, tokenHeaders, store } = await fixture(t, { onInstruction: async () => { calls++; await neverUntilReleased; throw new Error('PRIVATE_API_KEY'); }, getRuntimeStatus: async () => ({ available: true }), getGrokStatus: () => ({ configured: true, connected: true }) });
  const result = await request('/api/office/instructions', { method: 'POST', headers: tokenHeaders, input: { text: 'Plan this work' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.instruction.status, 'pending');
  assert.equal(calls, 1);
  settle(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.snapshot().instructions[0].status, 'blocked');
  assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_API_KEY'));
  const retry = await request(`/api/office/instructions/${result.body.instruction.id}/retry`, { method: 'POST', headers: tokenHeaders, input: {} });
  assert.equal(retry.status, 202);
  assert.equal(calls, 2);
  const board = await request('/api/office/board');
  assert.equal(board.body.runtime.available, true);
  assert.equal(board.body.grok.configured, true);
});

test('Grok key configuration is delegated without echoing secret input or provider errors', async t => {
  const { request, tokenHeaders } = await fixture(t, { onConfigureGrok: async () => { throw new Error('PRIVATE_API_KEY'); } });
  const result = await request('/api/office/grok/connect', { method: 'POST', headers: tokenHeaders, input: { apiKey: 'PRIVATE_API_KEY' } });
  assert.equal(result.status, 400);
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE_API_KEY'));
});

test('external GrokBot plans are atomic, project-scoped, idempotent and cannot replace running planning', async t => {
  const { request, tokenHeaders, store, projectPath } = await fixture(t);
  const instruction = store.createInstruction({ text: 'Plan this project', projectPath });
  const route = `/api/office/instructions/${instruction.id}/apply-plan`;
  const plan = { summary: 'Implement and verify.', roles: [{ name: 'Delivery lead', description: 'Coordinate this delivery.' }], tasks: [{ title: 'Implement', description: 'Implement and test this behavior.', provider: 'codex', role: 'Helper', priority: 'normal', projectPath: '/untrusted-model-path' }] };
  const invalid = structuredClone(plan); invalid.tasks[0].provider = 'grok';
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: invalid })).status, 400);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().roles.length, 0);
  store.updateInstruction(instruction.id, { status: 'running' });
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: plan })).status, 409);
  store.updateInstruction(instruction.id, { status: 'blocked' });
  const applied = await request(route, { method: 'POST', headers: tokenHeaders, input: { plan } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.tasks[0].projectPath, instruction.projectPath);
  assert.equal(applied.body.tasks[0].source, 'grok');
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: plan })).body.applied, false);
  assert.equal(store.snapshot().tasks.length, 1);
});

test('GrokBot heartbeat uses the same mutation guards and delegates only after a valid token', async t => {
  let calls = 0;
  const { request, tokenHeaders } = await fixture(t, { onBotHeartbeat: async input => { calls++; return { id: 'fixture-bot', name: input.name, status: input.status }; } });
  const input = { name: 'Fixture GrokBot', status: 'idle' };
  assert.equal((await request('/api/office/grok/bot/heartbeat', { method: 'POST', input })).status, 403);
  assert.equal(calls, 0);
  const result = await request('/api/office/grok/bot/heartbeat', { method: 'POST', input, headers: tokenHeaders });
  assert.equal(result.status, 200);
  assert.equal(result.body.bot.id, 'fixture-bot');
  assert.equal(calls, 1);
});

test('bulk card actions require CSRF, preserve per-card failures and validate selection bounds', async t => {
  const { store, request, tokenHeaders } = await fixture(t);
  const first = store.createTask({ title: 'Delete fixture' });
  const second = store.createTask({ title: 'Changed fixture' });
  store.updateTask(second.id, { title: 'Updated fixture' });
  const input = { action: 'delete', items: [first, second].map(task => ({ id: task.id, version: task.version })) };
  const url = '/api/office/tasks/card-actions';
  assert.equal((await request(url, { method: 'POST', input })).status, 403);
  const result = await request(url, { method: 'POST', headers: tokenHeaders, input });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results.map(item => item.ok), [true, false]);
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().deletedTasks.length, 1);
  assert.equal((await request(url, { method: 'POST', headers: tokenHeaders, input: { ...input, items: Array(101).fill(input.items[0]) } })).status, 400);
  const malformed = await request(url, { method: 'POST', headers: tokenHeaders, input: { action: 'deny', items: [null] } });
  assert.equal(malformed.body.results[0].ok, false);
});
