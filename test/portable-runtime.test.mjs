import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { officeServices } from '../server/office-services.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { loadOfficeConfig } from '../server/office-config.mjs';
import { readonlyStore, acquireOfficeLock } from '../server/portable-runtime.mjs';

async function fixture(t, mode = 'disabled', seed = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'office-portable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  if (seed) { const s = createTaskStore({ home: dataDir }); s.createTask({ title: 'Preserve me', projectPath: root }); s.close(); }
  const configuration = { ...loadOfficeConfig({ env: {}, home: root, cwd: root }), dataDir, mode };
  const plugin = officeServices({ configuration, runner: { probeProviders: async () => ({}) } });
  let middleware;
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(fn) { middleware = fn; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { root, dataDir, plugin, url, board: () => fetch(url + '/api/office/board').then(r => r.json()) };
}

test('fresh disabled office opens without creating database or starting services', async t => {
  const f = await fixture(t), board = await f.board();
  assert.equal(board.configuration.mode, 'disabled'); assert.equal(board.runtime.started, false);
  assert.deepEqual(board.tasks, []); assert.equal(board.settings.autoPickup, false);
  assert.equal(board.grokWake.configured, false); assert.equal(board.qwenWatch, null);
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' });
});

test('read-only office preserves existing tasks/settings and rejects every mutation with valid CSRF', async t => {
  const f = await fixture(t, 'read-only', true);
  const before = await readFile(path.join(f.dataDir, 'board.sqlite'));
  const board = await f.board(); assert.equal(board.tasks[0].title, 'Preserve me'); assert.equal(board.settings.autoPickup, true);
  for (const route of ['tasks', 'tasks/claim-next', 'tasks/x/claim', 'tasks/x/finish', 'grok/bot/heartbeat', 'grok/wake/config', 'grok/connect', 'instructions', 'human-requests/x/respond', 'human-requests/x/answer', 'settings']) {
    const r = await fetch(f.url + '/api/office/' + route, { method: route === 'settings' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': board.csrfToken }, body: '{}' });
    assert.equal(r.status, 403, route);
  }
  assert.deepEqual(await readFile(path.join(f.dataDir, 'board.sqlite')), before);
});

test('enabled office starts with manual pickup and configured workspace, disabled provider cannot claim', async t => {
  const f = await fixture(t, 'enabled'), board = await f.board();
  assert.equal(board.configuration.mode, 'enabled'); assert.equal(board.settings.autoPickup, false);
  const post = (route, body) => fetch(f.url + '/api/office/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': board.csrfToken }, body: JSON.stringify(body) });
  const created = await post('tasks', { title: 'Generic task', provider: 'codex' });
  assert.equal(created.status, 201); assert.equal((await created.json()).task.projectPath, await realpath(f.root));
  assert.equal((await post('tasks/claim-next', { worker: { provider: 'codex' } })).status, 403);
  assert.equal((await post('grok/connect', { apiKey: 'fixture' })).status, 503);
  assert.equal((await post('grok/bot/heartbeat', { id: 'fixture' })).status, 503);
  assert.throws(() => acquireOfficeLock(f.dataDir), /运行锁/);
});

test('read-only snapshot never expires an active claim; new-store defaults preserve existing settings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'office-preserve-')); t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const store = createTaskStore({ home: root, now: () => now });
  const task = store.createTask({ title: 'Live work', projectPath: root, provider: 'codex' });
  store.claimTask({ id: 'worker', name: 'Worker', provider: 'codex', projectPath: root }, { taskId: task.id });
  store.close();
  const reader = readonlyStore(root); assert.equal(reader.snapshot().tasks[0].status, 'running'); reader.close();
  const reopened = createTaskStore({ home: root, now: () => now, autoPickup: false });
  assert.equal(reopened.snapshot().settings.autoPickup, true); reopened.close();
});

test('runner lock prevents same-directory execution and releases only its own lease', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'office-lock-')); t.after(() => rm(root, { recursive: true, force: true }));
  const release = acquireOfficeLock(root); assert.throws(() => acquireOfficeLock(root), /运行锁/);
  release(); release(); const next = acquireOfficeLock(root); next();
});
