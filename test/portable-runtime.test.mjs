import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat, realpath, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
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

async function lockFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'office-lock-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function lockChild(t, root, mode = 'owner') {
  const program = `
    import { acquireOfficeLock } from ${JSON.stringify(new URL('../server/portable-runtime.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    process.once('message', () => {
      try {
        if (process.argv[2] === 'gate') {
          globalThis.gate = new DatabaseSync(path.join(process.argv[1], 'office-runner-gate.sqlite'));
          gate.exec('BEGIN IMMEDIATE');
        } else globalThis.release = acquireOfficeLock(process.argv[1]);
        process.send('held'); setInterval(() => {}, 1000);
      } catch { process.send('blocked', () => process.exit(0)); }
    });
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  assert.equal((await once(child, 'message'))[0], 'ready');
  return { child, run() { const result = once(child, 'message').then(([value]) => value); child.send('acquire'); return result; } };
}

async function killChild(child) {
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

test('runner recovers a SIGKILL owner without removing a live owner', { timeout: 10000 }, async t => {
  const root = await lockFixture(t), worker = await lockChild(t, root);
  assert.equal(await worker.run(), 'held');
  const file = path.join(root, 'office-runner.lock'), old = await readFile(file, 'utf8');
  assert.throws(() => acquireOfficeLock(root), /运行锁/);
  assert.equal(await readFile(file, 'utf8'), old);
  await killChild(worker.child);
  const release = acquireOfficeLock(root), owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.pid, process.pid); assert.notEqual(owner.token, JSON.parse(old).token);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  release(); await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('two starts cannot both claim a fresh directory or the same dead owner', { timeout: 10000 }, async t => {
  for (const stale of [false, true]) {
    const root = await lockFixture(t);
    if (stale) { const old = await lockChild(t, root); assert.equal(await old.run(), 'held'); await killChild(old.child); }
    const [first, second] = await Promise.all([lockChild(t, root), lockChild(t, root)]);
    const results = await Promise.all([first.run(), second.run()]);
    assert.deepEqual([...results].sort(), ['blocked', 'held']);
    const winner = [first, second][results.indexOf('held')].child;
    assert.equal(JSON.parse(await readFile(path.join(root, 'office-runner.lock'), 'utf8')).pid, winner.pid);
    await killChild(winner);
    acquireOfficeLock(root)();
  }
});

test('runner gate recovers after its process is killed and does not steal a live gate', { timeout: 10000 }, async t => {
  const root = await lockFixture(t), worker = await lockChild(t, root, 'gate');
  assert.equal(await worker.run(), 'held');
  assert.throws(() => acquireOfficeLock(root), /运行锁/);
  await assert.rejects(stat(path.join(root, 'office-runner.lock')), { code: 'ENOENT' });
  await killChild(worker.child);
  acquireOfficeLock(root)();
});

test('malformed, linked and old live locks remain intact; release cannot delete another token', async t => {
  const root = await lockFixture(t), file = path.join(root, 'office-runner.lock');
  for (const value of ['', '{bad', JSON.stringify({ pid: process.pid }), JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: '2000-01-01' })]) {
    await writeFile(file, value);
    assert.throws(() => acquireOfficeLock(root), /运行锁/);
    assert.equal(await readFile(file, 'utf8'), value);
  }
  await unlink(file);
  const target = path.join(root, 'do-not-touch'); await writeFile(target, 'preserve'); await symlink(target, file);
  assert.throws(() => acquireOfficeLock(root), /运行锁/);
  assert.equal(await readFile(target, 'utf8'), 'preserve'); await unlink(file);
  const release = acquireOfficeLock(root), replacement = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await writeFile(file, replacement); release();
  assert.equal(await readFile(file, 'utf8'), replacement);
});

test('read-only office shows registered projects without tasks and leaves its database unchanged', async t => {
  const f = await fixture(t, 'read-only', true);
  const project = path.join(f.root, 'registered with no tasks'); await mkdir(project);
  const catalog = [{ id: 'new-project', name: 'New project', path: project }];
  await writeFile(path.join(f.dataDir, 'project-catalog.json'), JSON.stringify(catalog));
  const before = await readFile(path.join(f.dataDir, 'board.sqlite')), board = await f.board();
  assert.equal(board.projectCatalog[0].id, 'new-project');
  assert.equal(board.projectCatalog[0].path, project);
  assert.equal(board.tasks.some(task => task.projectPath === project), false);
  assert.equal(board.capabilities.projects, false);
  assert.deepEqual(await readFile(path.join(f.dataDir, 'board.sqlite')), before);
  await assert.rejects(stat(path.join(f.dataDir, 'office-runner-gate.sqlite')), { code: 'ENOENT' });
});
