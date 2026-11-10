import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTaskStore } from '../server/task-store.mjs';
import { createTaskRunner, routeTask } from '../server/task-runner.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

// Independent acceptance coverage: all stores, HTTP adapters and workers are
// disposable fixtures. This suite never uses the live office or a model API.
async function fixture(t, extra = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'grok-bot-acceptance-')));
  const projectPath = path.join(home, 'project');
  await mkdir(projectPath);
  let store = createTaskStore({ home, ...extra });
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.stop();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  function runner(options = {}) {
    const value = createTaskRunner({ store, probeProviders: async () => ({}), pollIntervalMs: 10000, ...options });
    runners.push(value);
    return value;
  }
  function reopen() { store.close(); store = createTaskStore({ home, ...extra }); return store; }
  const worker = (provider = 'grok-bot', id = `${provider}-acceptance`) => ({ id, name: id, provider, projectPath, role: 'any' });
  return { store, projectPath, runner, reopen, worker };
}

async function http(store) {
  let middleware;
  taskBoardBridge({ store }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  async function request(url, input, token) {
    const stream = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]);
    Object.assign(stream, { url, method: input === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:5173', ...(input === undefined ? {} : { 'content-type': 'application/json', 'x-office-token': token }) }, socket: { remoteAddress: '127.0.0.1' } });
    let payload;
    const response = { statusCode: 200, setHeader() {}, end(value) { payload = JSON.parse(value); } };
    await middleware(stream, response, () => assert.fail('Expected API route'));
    return { status: response.statusCode, payload };
  }
  const token = (await request('/api/office/board')).payload.csrfToken;
  return (url, input) => request(url, input, token);
}

test('external Bot can explicitly claim, heartbeat and finish through the guarded public API', async t => {
  const { store, projectPath, worker } = await fixture(t);
  const request = await http(store);
  const create = await request('/api/office/tasks', { provider: 'grok-bot', title: 'Coordinate release readiness', projectPath });
  assert.equal(create.status, 201);
  const id = create.payload.task.id;
  const claim = await request(`/api/office/tasks/${id}/claim`, { worker: worker() });
  assert.equal(claim.status, 200);
  assert.equal(claim.payload.task.assignee.provider, 'grok-bot');
  const claimToken = claim.payload.claimToken;
  assert.equal((await request(`/api/office/tasks/${id}/heartbeat`, { claimToken: 'wrong' })).status, 409);
  assert.equal((await request(`/api/office/tasks/${id}/finish`, { claimToken: 'wrong', result: 'Not authorized' })).status, 409);
  assert.equal((await request(`/api/office/tasks/${id}/heartbeat`, { claimToken })).status, 200);
  const board = (await request('/api/office/board')).payload;
  assert.ok(!JSON.stringify(board).includes(claimToken));
  assert.equal(board.tasks[0].status, 'running');
  const done = await request(`/api/office/tasks/${id}/finish`, { claimToken, status: 'done', result: 'Readiness checks coordinated.' });
  assert.equal(done.payload.task.status, 'done');
  assert.equal(done.payload.task.result, 'Readiness checks coordinated.');
  assert.equal(store.snapshot().tasks.length, 1, 'External coordination must not fabricate a coder cross-review');
  assert.equal((await request(`/api/office/tasks/${id}/heartbeat`, { claimToken })).status, 409);
});

test('any and explicit coding cards remain inaccessible to Bot workers, including explicit ID claims', async t => {
  const { store, projectPath, worker } = await fixture(t);
  const wildcard = store.createTask({ title: 'General coding', projectPath });
  const coding = store.createTask({ title: 'Claude code change', projectPath, provider: 'claude' });
  assert.equal(store.claimTask(worker()), null);
  assert.equal(store.claimTask(worker(), { taskId: wildcard.id }), null);
  assert.equal(store.claimTask(worker(), { taskId: coding.id }), null);
  const bot = store.createTask({ title: 'Bot own work', projectPath, provider: 'grok-bot' });
  assert.equal(store.claimTask(worker()).task.id, bot.id);
  assert.equal(store.snapshot().tasks.find(task => task.id === wildcard.id).status, 'pending');
});

test('normal and mixed-provider workers cannot capture a Bot card', async t => {
  const { store, projectPath, worker } = await fixture(t);
  const bot = store.createTask({ title: 'Own Bot work', provider: 'grok-bot', projectPath });
  for (const provider of ['codex', 'claude', 'gemini', 'local-qwen', 'grok']) {
    assert.equal(store.claimTask(worker(provider), { taskId: bot.id }), null);
  }
  for (const input of [
    { ...worker('codex'), providers: ['codex', 'grok-bot'] },
    { ...worker(), providers: ['grok-bot', 'codex'] },
    { ...worker(), provider: undefined, providers: ['grok-bot'] },
    { ...worker('claude'), providers: ['grok-bot'] },
  ]) {
    assert.throws(() => store.claimTask(input, { taskId: bot.id }));
    assert.equal(store.snapshot().tasks[0].status, 'pending');
  }
  assert.equal(store.claimTask(worker(), { taskId: bot.id }).task.provider, 'grok-bot');
});

test('coding and external management can share a workspace while Bot claims stay serialized', async t => {
  const { store, projectPath, worker } = await fixture(t);
  const coding = store.createTask({ title: 'Implementation', provider: 'codex', projectPath });
  const bot = store.createTask({ title: 'Management', provider: 'grok-bot', projectPath });
  const another = store.createTask({ title: 'More management', provider: 'grok-bot', projectPath });
  assert.ok(store.claimTask(worker('codex'), { taskId: coding.id }));
  const active = store.claimTask(worker(), { taskId: bot.id });
  assert.ok(active);
  assert.equal(store.snapshot().tasks.filter(task => task.status === 'running').length, 2);
  assert.equal(store.claimTask(worker('grok-bot', 'second-bot'), { taskId: another.id }), null);
  store.finishTask(bot.id, active.claimToken, { result: 'Management done' });
  assert.ok(store.claimTask(worker('grok-bot', 'second-bot'), { taskId: another.id }));
});

test('claimed external task survives persistent store reopen and runner start/stop without local spawn', async t => {
  const f = await fixture(t);
  const bot = f.store.createTask({ title: 'Externally running work', provider: 'grok-bot', projectPath: f.projectPath });
  const claim = f.store.claimTask(f.worker(), { taskId: bot.id });
  const store = f.reopen();
  let calls = 0;
  const runner = f.runner({ spawnProcess() { calls++; throw new Error('No bot process may launch'); } });
  await runner.start();
  await runner.stop();
  await runner.start();
  assert.equal(calls, 0);
  assert.equal(runner.status().running.length, 0, 'Runner must not own external tasks');
  assert.equal(store.snapshot().tasks[0].status, 'running');
  store.heartbeat(bot.id, claim.claimToken);
  assert.equal(store.finishTask(bot.id, claim.claimToken, { result: 'Completed by external bot' }).status, 'done');
});

test('external queue cannot be routed by quotas or auto pickup, and explains why it waits', async t => {
  const { store, projectPath, runner: makeRunner } = await fixture(t);
  const bot = store.createTask({ title: 'Urgent release balance review', kind: 'review', provider: 'grok-bot', projectPath, priority: 'high' });
  for (const quota of [null, {}, { codex: { windows: [{ usedPercent: 100 }] }, claude: { windows: [{ usedPercent: 100 }] } }]) {
    assert.deepEqual(routeTask(bot, quota).eligible, []);
  }
  let calls = 0;
  const runner = makeRunner({ probeProviders: async () => ({ codex: { available: true, authenticated: true, path: '/mock/codex' }, claude: { available: true, authenticated: true, path: '/mock/claude' } }), spawnProcess() { calls++; throw new Error('Must not launch'); } });
  await runner.start();
  assert.equal(calls, 0);
  assert.equal(store.snapshot().tasks[0].status, 'pending');
  assert.match(runner.status().pending.find(task => task.taskId === bot.id).reason, /external|Grok Bot/i);
  store.updateSettings({ autoPickup: false });
  await runner.kick();
  assert.match(runner.status().pending.find(task => task.taskId === bot.id).reason, /external|Grok Bot/i);
});

test('external heartbeat renewal works and lost claims expire without automatic success or retry', async t => {
  let clock = Date.parse('2026-11-03T00:00:00Z');
  const { store, projectPath, worker } = await fixture(t, { now: () => clock, leaseMs: 1000 });
  const task = store.createTask({ provider: 'grok-bot', title: 'Leased work', projectPath });
  const claim = store.claimTask(worker());
  clock += 800;
  store.heartbeat(task.id, claim.claimToken);
  clock += 800;
  assert.equal(store.snapshot().tasks[0].status, 'running');
  clock += 300;
  assert.equal(store.snapshot().tasks[0].status, 'blocked');
  assert.throws(() => store.finishTask(task.id, claim.claimToken, { result: 'Late completion' }));
  assert.equal(store.claimTask(worker()), null);
  assert.equal(store.snapshot().tasks[0].result, '');
});
