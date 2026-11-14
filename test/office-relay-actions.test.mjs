import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { officeRelay } from '../server/office-relay.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';
import { createTaskStore } from '../server/task-store.mjs';

async function fixture(t, userActions = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-relay-actions-'));
  const store = createTaskStore({ home, crossReview: false, autoPickup: false });
  const configuration = { mode: 'enabled' };
  let upstream, relay, taskChanges = 0, uncertain = false, forwarded = 0;
  taskBoardBridge({ store, configuration, onTaskChange: () => { taskChanges++; } }).configureServer({ middlewares: { use: fn => upstream = fn } });
  const invoke = async (handler, port, url, method = 'GET', input, headers = {}, address = '127.0.0.1') => {
    const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]);
    Object.assign(req, { url, method, socket: { remoteAddress: address }, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } });
    let body; const res = { statusCode: 200, setHeader() {}, end(text) { body = JSON.parse(text); } };
    await handler(req, res, () => assert.fail('Unexpected route'));
    return { status: res.statusCode, body };
  };
  const upstreamToken = (await invoke(upstream, 5173, '/api/office/board')).body.csrfToken;
  const httpServer = new EventEmitter();
  officeRelay({ home, userActions, upstream: 'http://127.0.0.1:5173', fetchImpl: async (url, options = {}) => {
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    if (options.method) { assert.equal(headers['x-office-token'], upstreamToken); forwarded++; }
    const result = await invoke(upstream, 5173, new URL(url).pathname, options.method, options.body && JSON.parse(options.body), headers);
    if (options.method && uncertain) throw new Error('Network failed after durable write');
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  } }).configureServer({ httpServer, middlewares: { use: fn => relay = fn } });
  t.after(() => { httpServer.emit('close'); store.close(); return rm(home, { recursive: true, force: true }); });
  const call = (url = '/api/office/board', options = {}) => invoke(relay, 5186, url, options.method, options.input, options.headers, options.address);
  const token = (await call()).body.csrfToken;
  const write = (url, input, method = 'POST', headers = {}) => call(url, { method, input, headers: { 'x-office-token': token, ...headers } });
  const blocked = (error = 'Fixture unavailable') => {
    const task = store.createTask({ title: 'Isolated fixture', provider: 'codex', projectPath: home });
    const claim = store.claimTask({ id: 'fixture-worker', provider: 'codex', roles: ['any'], projectPath: home }, { taskId: task.id });
    return store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
  };
  return { store, configuration, call, write, blocked, token, upstreamToken, home, taskChanges: () => taskChanges, forwarded: () => forwarded, setUncertain: () => uncertain = true };
}

test('user controls are opt-in and enforce both origin/token layers while never enabling worker or credential routes', async t => {
  const f = await fixture(t);
  const board = (await f.call()).body;
  assert.equal(board.configuration.mode, 'read-only');
  for (const key of ['taskActions', 'humanQuestions', 'taskSettings', 'roles']) assert.equal(board.capabilities[key], true);
  assert.equal(board.capabilities.grokWakeConfiguration, false);
  assert.notEqual(f.token, f.upstreamToken);
  assert.equal((await f.call('/api/office/tasks', { method: 'POST', input: { title: 'No token' } })).status, 403);
  assert.equal((await f.write('/api/office/tasks', { title: 'Wrong token' }, 'POST', { 'x-office-token': f.upstreamToken })).status, 403);
  assert.equal((await f.write('/api/office/tasks', { title: 'Wrong origin' }, 'POST', { origin: 'https://evil.example' })).status, 403);
  for (const url of ['/api/office/tasks/claim-next', '/api/office/tasks/x/claim', '/api/office/tasks/x/heartbeat', '/api/office/tasks/x/finish', '/api/office/human-requests/x/answer', '/api/office/human-requests/x/acknowledge', '/api/office/human-requests/x/triage', '/api/office/instructions/x/apply-plan', '/api/office/agents/heartbeat', '/api/office/grok/bot/heartbeat', '/api/office/grok/connect', '/api/office/grok/wake/config', '/api/office/maintenance']) assert.equal((await f.write(url, {})).status, 403, url);
  assert.equal(f.forwarded(), 0);
  const readonly = await fixture(t, false);
  assert.equal((await readonly.call()).body.capabilities.taskActions, false);
  assert.equal((await readonly.write('/api/office/tasks', { title: 'Disabled' })).status, 403);
  f.configuration.mode = 'read-only';
  assert.equal((await f.call()).body.capabilities.taskActions, false);
  assert.equal((await f.write('/api/office/tasks', { title: 'Upstream paused' })).status, 403);
});

test('batch controls reach the same store, preserve version checks and do not mutate running work', async t => {
  const f = await fixture(t), task = f.blocked();
  const current = id => [...f.store.snapshot().tasks, ...f.store.snapshot().deletedTasks].find(item => item.id === id);
  const action = (action, items) => f.write('/api/office/tasks/card-actions', { action, items });
  let result = await action('rerequest', [{ id: task.id, version: task.version, operationId: 'retry-fixture' }]);
  assert.equal(result.body.results[0].ok, true); assert.equal(current(task.id).status, 'pending');
  result = await action('delete', [{ id: task.id, version: task.version, operationId: 'stale-fixture' }]);
  assert.equal(result.body.results[0].ok, false); assert.equal(current(task.id).status, 'pending');
  assert.equal(f.taskChanges(), 1);
  const changesBeforeDeny = f.taskChanges();
  result = await action('deny', [{ id: task.id, version: current(task.id).version, operationId: 'deny-fixture' }]);
  assert.equal(result.body.results[0].ok, true); assert.equal(current(task.id).paused, true);
  assert.equal(f.taskChanges(), changesBeforeDeny, 'Deny must not wake a worker');
  result = await action('delete', [{ id: task.id, version: current(task.id).version, operationId: 'delete-fixture' }]);
  assert.equal(result.body.results[0].ok, true); assert.equal(f.store.snapshot().deletedTasks.length, 1);
  const running = f.store.createTask({ title: 'Running fixture', projectPath: f.home, provider: 'codex' });
  const claim = f.store.claimTask({ id: 'worker', provider: 'codex', roles: ['any'], projectPath: f.home }, { taskId: running.id });
  result = await action('delete', [{ id: running.id, version: claim.task.version, operationId: 'running-delete' }]);
  assert.equal(result.body.results[0].ok, false); assert.equal(current(running.id).status, 'running');
  assert.equal(f.taskChanges(), 2, 'Only successful re-request and delete notify the board');
});

test('question re-request cannot approve work; exact user reply reaches upstream and stale answers are rejected', async t => {
  const f = await fixture(t), task = f.blocked('Approval required: publish this fixture.');
  f.store.syncHumanRequests();
  const question = f.store.snapshot().humanRequests[0];
  const reask = await f.write(`/api/office/human-requests/${question.id}/rerequest`, { questionHash: question.questionHash, operationId: 'ask-fixture' });
  assert.equal(reask.status, 200); assert.equal(reask.body.task.status, 'blocked');
  const current = reask.body.request;
  const answer = { questionHash: current.questionHash, userMessageId: 'fixture-user-decision', decision: 'approve', userAction: 'approve', userReply: 'Only this isolated fixture.' };
  const stale = await f.write(`/api/office/human-requests/${question.id}/respond`, { ...answer, questionHash: question.questionHash });
  assert.equal(stale.status, 409);
  assert.equal((await f.write(`/api/office/tasks/${task.id}`, { status: 'pending' }, 'PATCH')).status, 409);
  const records = () => { const { tasks, humanRequests } = f.store.snapshot(); return { tasks, humanRequests }; };
  const beforeConditional = records(), changesBeforeConditional = f.taskChanges();
  const conditional = await f.write(`/api/office/human-requests/${current.id}/respond`, answer);
  assert.equal(conditional.status, 400);
  assert.match(conditional.body.error, /partial or conditional legacy replies require explicit action binding/);
  assert.deepEqual(records(), beforeConditional, 'Rejected conditional approval must not change the task or question');
  assert.equal(f.taskChanges(), changesBeforeConditional, 'Rejected approval must not wake a worker');
  const explicitAnswer = { ...answer, userMessageId: 'fixture-user-explicit-decision', userReply: 'Yes' };
  const approved = await f.write(`/api/office/human-requests/${current.id}/respond`, explicitAnswer);
  assert.equal(approved.status, 200); assert.equal(approved.body.task.status, 'pending');
  assert.equal(approved.body.task.humanReply.userReply, explicitAnswer.userReply);
  assert.equal(f.taskChanges(), changesBeforeConditional + 1, 'An accepted approval wakes a worker once');
  assert.equal(approved.body.task.humanReply.source, 'office-ui');
  assert.equal(f.store.snapshot().tasks.length, 1);
});

test('settings are bounded to pickup and uncertain writes are reported without automatic retries', async t => {
  const f = await fixture(t);
  assert.equal((await f.write('/api/office/settings', { autoPickup: true, providers: {} }, 'PATCH')).status, 400);
  assert.equal(f.forwarded(), 0);
  assert.equal((await f.write('/api/office/settings', { autoPickup: true }, 'PATCH')).status, 200);
  assert.equal(f.store.snapshot().settings.autoPickup, true);
  assert.equal((await f.write('/api/office/roles', { name: 'Coordinator', description: 'Fixture role' })).status, 201);
  f.setUncertain(); const before = f.forwarded();
  assert.equal((await f.write('/api/office/tasks', { title: 'One fixture request', projectPath: f.home })).status, 503);
  assert.equal(f.forwarded(), before + 1);
  assert.equal(f.store.snapshot().tasks.length, 1);
});
