import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createGrokManagement, validateManagementPlan, MANAGEMENT_SCHEMA } from '../server/grok-management.mjs';

const KEY = 'fixture-key-never-public';
const models = { data: [{ id: 'grok-4-fast-non-reasoning' }, { id: 'grok-imagine-image' }] };
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(payload); } });
const plan = () => ({ summary: 'Implement and verify the requested work.', roles: [{ name: 'Delivery lead', description: 'Coordinate the implementation and verification.' }], tasks: [{ title: 'Implement change', description: 'Implement the requested behavior and verify it.', provider: 'codex', role: 'Helper', priority: 'normal', projectPath: '/model-cannot-select-this' }] });
const completed = value => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let tries = 0; tries < 200; tries++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Timed out waiting for fixture state'); }

async function fixture(t, options = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-grok-')));
  const projectPath = path.join(home, 'project'); await mkdir(projectPath);
  const store = createTaskStore({ home });
  const manager = createGrokManagement({ store, home, env: {}, intervalMs: 100000, requestTimeout: 1000, fetchImpl: async () => response(models), ...options });
  t.after(async () => { manager.stop(); store.close(); await rm(home, { recursive: true, force: true }); });
  return { home, projectPath, store, manager };
}

test('connect validates a text model, saves private credentials at mode600, and status never exposes its key', async t => {
  const { home, manager, store } = await fixture(t);
  const status = await manager.connect({ apiKey: KEY });
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.loading, false);
  assert.equal(status.model, 'grok-4-fast-non-reasoning');
  assert.ok(!JSON.stringify(status).includes(KEY));
  const file = path.join(home, 'grok-credentials.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY);
  const restored = createGrokManagement({ store, home, env: {}, fetchImpl: async () => response(models), intervalMs: 100000 });
  t.after(() => restored.stop()); await restored.start();
  assert.equal(restored.status().connected, true);
  assert.ok(!JSON.stringify(restored.status()).includes(KEY));
});

test('instructions queue without credentials, then an actual planning response applies roles and pending tasks', async t => {
  let calls = 0;
  const { projectPath, manager, store } = await fixture(t, { fetchImpl: async url => { calls++; return response(url.endsWith('/models') ? models : completed(plan())); } });
  const instruction = store.createInstruction({ text: 'Plan this project', projectPath });
  await manager.start(); manager.kick();
  assert.equal(calls, 0);
  assert.equal(store.snapshot().instructions[0].status, 'pending');
  await manager.connect({ apiKey: KEY });
  await until(() => store.snapshot().instructions[0].status === 'done');
  const snapshot = store.snapshot();
  assert.equal(snapshot.roles.length, 1);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].status, 'pending');
  assert.equal(snapshot.tasks[0].source, 'grok');
  assert.equal(snapshot.tasks[0].managementRequestId, instruction.id);
  assert.equal(snapshot.tasks[0].projectPath, projectPath);
  assert.ok(!JSON.stringify(manager.status()).includes(KEY));
});

test('an invalid provider plan adds no partial roles or tasks and blocks the instruction', async t => {
  const invalid = plan(); invalid.tasks.push({ ...invalid.tasks[0], title: '' });
  const { manager, store, projectPath } = await fixture(t, { env: { XAI_API_KEY: KEY }, fetchImpl: async url => response(url.endsWith('/models') ? models : completed(invalid)) });
  store.createInstruction({ text: 'Plan safely', projectPath });
  await manager.start();
  await until(() => store.snapshot().instructions[0].status === 'blocked');
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().roles.length, 0);
  assert.throws(() => validateManagementPlan({ ...plan(), roles: Array.from({ length: 21 }, () => ({ name: 'Role', description: 'Description' })) }), /incomplete/);
  assert.throws(() => validateManagementPlan({ ...plan(), summary: 'x'.repeat(10001) }), /incomplete/);
});

test('authentication failure is sanitized and never reads a provider error body', async t => {
  const { manager, store } = await fixture(t, { env: { XAI_API_KEY: KEY }, fetchImpl: async () => ({ ok: false, status: 401, text() { assert.fail('Error bodies must not be read'); } }) });
  store.createInstruction({ text: 'This stays queued' }); await manager.start();
  const status = manager.status();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.match(status.error, /rejected/);
  assert.ok(!JSON.stringify(status).includes(KEY));
  assert.equal(store.snapshot().instructions[0].status, 'pending');
});

test('concurrent credential changes are rejected so an older check cannot overwrite the selected key', async t => {
  const wait = deferred(); let requests = 0;
  const { manager, home } = await fixture(t, { fetchImpl: async () => { requests++; await wait.promise; return response(models); } });
  const first = manager.connect({ apiKey: KEY });
  await until(() => requests === 1);
  await assert.rejects(manager.connect({ apiKey: 'other-fixture-key' }), /already in progress/);
  assert.equal(requests, 1);
  wait.resolve(); await first;
  assert.equal(JSON.parse(await readFile(path.join(home, 'grok-credentials.json'), 'utf8')).apiKey, KEY);
});

test('stop aborts planning, removes active presence, and a late response cannot apply a plan', async t => {
  const wait = deferred(); let planningSignal;
  const { manager, store, projectPath } = await fixture(t, { env: { XAI_API_KEY: KEY }, fetchImpl: async (url, options) => { if (url.endsWith('/models')) return response(models); planningSignal = options.signal; await wait.promise; return response(completed(plan())); } });
  store.createInstruction({ text: 'Plan before stopping', projectPath }); await manager.start();
  await until(() => Boolean(planningSignal));
  assert.equal(manager.status().agents.length, 1);
  manager.stop();
  assert.equal(planningSignal.aborted, true);
  assert.equal(manager.status().agents.length, 0);
  assert.equal(store.snapshot().instructions[0].status, 'blocked');
  wait.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().roles.length, 0);
  assert.equal(store.snapshot().instructions[0].status, 'blocked');
});

test('stop during credential startup cannot reconnect or begin queued work when the check finishes late', async t => {
  const wait = deferred(); let signal;
  const { manager, store } = await fixture(t, { env: { XAI_API_KEY: KEY }, fetchImpl: async (url, options) => { signal = options.signal; await wait.promise; return response(models); } });
  store.createInstruction({ text: 'Must remain pending' }); const start = manager.start();
  await until(() => Boolean(signal)); manager.stop();
  assert.equal(signal.aborted, true);
  wait.resolve(); await start;
  assert.equal(manager.status().connected, false);
  assert.equal(store.snapshot().instructions[0].status, 'pending');
});


test('management can enqueue separate external bot cards without starting or claiming their work', async t => {
  const botPlan = plan(); botPlan.tasks[0].provider = 'grok-bot';
  const { manager, store, projectPath } = await fixture(t, { env: { XAI_API_KEY: KEY }, fetchImpl: async url => response(url.endsWith('/models') ? models : completed(botPlan)) });
  assert.ok(MANAGEMENT_SCHEMA.properties.tasks.items.properties.provider.enum.includes('grok-bot'));
  store.createInstruction({ text: 'Ask Grok Bot to coordinate delivery', projectPath });
  await manager.start();
  await until(() => store.snapshot().instructions[0].status === 'done');
  const snapshot = store.snapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].provider, 'grok-bot');
  assert.equal(snapshot.tasks[0].status, 'pending');
  assert.equal(snapshot.tasks[0].assignee, null);
  assert.equal(snapshot.tasks[0].projectPath, projectPath);
  assert.equal(snapshot.roles[0].provider, 'grok', 'management roles remain separate from external execution');
  const invalid = plan(); invalid.tasks[0].provider = 'grok';
  assert.throws(() => validateManagementPlan(invalid, projectPath), /invalid task/);
});
