import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';
import { relayUserRouteAllowed } from '../server/office-relay.mjs';
import { readGrokPatrolConfig, GROK_PATROL_INTERVAL_MS } from '../server/grok-patrol-config.mjs';
import { runOfficeBoardCommand } from '../scripts/office-board.mjs';

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-grok-patrol-api-'));
  const store = createTaskStore({ home, researchDir: home, crossReview: false });
  const requests = [];
  let middleware;
  taskBoardBridge({ store, meetingFile: path.join(home, 'no-meeting.json'), ...options }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    middleware(request, response, () => { response.statusCode = 404; response.end('{}'); });
  });
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, home, requests, base,
    run: (args, input) => runOfficeBoardCommand({ args, environment: { AI_OFFICE_URL: base }, readInput: async () => input }),
    board: async () => (await fetch(`${base}/api/office/board`)).json(),
    post: (id, input, headers = {}) => fetch(`${base}/api/office/grok/blocked-tasks/${encodeURIComponent(id)}/handle`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(input) }),
  };
}

const activePatrol = { enabled: true, started: true, intervalMs: 600000, phase: 'awaiting_bot', lastRequestedAt: '2026-11-13T00:00:00Z', lastHandledAt: null };

test('Grok patrol board status and CLI read/write roundtrip retain task version and Bot source', async t => {
  const handled = [];
  let blocked;
  const f = await fixture(t, { getGrokPatrol: () => activePatrol, getBlockedTasks: () => ({ roundId: 'round-fixture', tasks: [blocked] }), onHandleBlockedTask: (id, input) => { handled.push({ id, input }); return { accepted: true, taskId: id, action: input.action }; }, enabledProviders: ['grok-bot'] });
  const task = f.store.createTask({ title: 'Synthetic patrol fixture', provider: 'codex', projectPath: f.home });
  const claim = f.store.claimTask({ id: 'fixture-worker', provider: 'codex', roles: ['any'], projectPath: f.home }, { taskId: task.id });
  blocked = f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Fixture dependency unavailable.' });
  const status = await f.run(['status']);
  assert.deepEqual(status.grokPatrol, activePatrol);
  assert.equal(status.tasks.find(value => value.id === task.id).status, 'blocked');
  assert.equal('csrfToken' in status, false);
  const listed = await f.run(['blocked-tasks']);
  assert.equal(listed.roundId, 'round-fixture');
  assert.equal(listed.tasks[0].id, blocked.id);
  assert.equal(listed.tasks[0].version, blocked.version);
  assert.deepEqual(f.requests.at(-1), { method: 'GET', url: '/api/office/grok/blocked-tasks' });
  const input = { source: 'grok-bot', version: blocked.version, roundId: listed.roundId, action: 'follow_up', summary: 'Inspecting the existing failure.', evidence: 'Synthetic fixture only.' };
  const result = await f.run(['handle-blocked-task', blocked.id], input);
  assert.deepEqual(result, { accepted: true, taskId: blocked.id, action: input.action });
  assert.deepEqual(handled, [{ id: blocked.id, input }]);
  assert.deepEqual(f.requests.at(-1), { method: 'POST', url: `/api/office/grok/blocked-tasks/${blocked.id}/handle` });
  assert.equal(f.store.snapshot().tasks.find(value => value.id === blocked.id).status, 'blocked', 'API acceptance must not fabricate completed task state');
  await f.run(['handle-blocked-task', 'fixture:escaped/id'], { ...input, version: 7 });
  assert.equal(handled.at(-1).id, 'fixture:escaped/id');
  assert.equal(handled.at(-1).input.version, 7);
  assert.match(f.requests.at(-1).url, /fixture%3Aescaped%2Fid\/handle$/);
});

test('Grok patrol preserves callback conflicts and unavailable errors instead of reporting success', async t => {
  let failure = 409;
  const callback = () => { throw Object.assign(new Error(`Fixture ${failure}`), { status: failure }); };
  const f = await fixture(t, { getBlockedTasks: callback, onHandleBlockedTask: callback });
  const board = await f.board();
  for (failure of [409, 503]) {
    const read = await fetch(`${f.base}/api/office/grok/blocked-tasks`);
    assert.equal(read.status, failure);
    assert.equal((await read.json()).error, `Fixture ${failure}`);
    const write = await f.post('fixture', { source: 'grok-bot', version: 4 }, { 'X-Office-Token': board.csrfToken });
    assert.equal(write.status, failure);
    assert.equal((await write.json()).error, `Fixture ${failure}`);
    await assert.rejects(f.run(['blocked-tasks']), new RegExp(`\\(${failure}\\).*Fixture ${failure}`));
    await assert.rejects(f.run(['handle-blocked-task', 'fixture'], { source: 'grok-bot', version: 4 }), new RegExp(`\\(${failure}\\).*Fixture ${failure}`));
  }
  const missing = await fixture(t);
  assert.equal((await fetch(`${missing.base}/api/office/grok/blocked-tasks`)).status, 503);
  assert.equal((await missing.board()).grokPatrol, null);
  assert.equal((await missing.post('fixture', {}, { 'X-Office-Token': (await missing.board()).csrfToken })).status, 503);
});

test('Grok patrol writes reject read-only mode, cross-origin, invalid CSRF and disabled Bot provider', async t => {
  let called = 0;
  const options = { getBlockedTasks: () => ({ tasks: [] }), onHandleBlockedTask: () => { called++; return { accepted: true }; } };
  const f = await fixture(t, options);
  const token = (await f.board()).csrfToken;
  const input = { source: 'grok-bot', version: 3 };
  assert.equal((await f.post('fixture', input)).status, 403);
  assert.equal((await f.post('fixture', input, { 'X-Office-Token': 'incorrect' })).status, 403);
  assert.equal((await f.post('fixture', input, { 'X-Office-Token': token, Origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await f.post('fixture', input, { 'X-Office-Token': token, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${f.base}/api/office/grok/blocked-tasks`, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
  const readOnly = await fixture(t, { ...options, readOnly: true });
  assert.equal((await readOnly.post('fixture', input, { 'X-Office-Token': (await readOnly.board()).csrfToken })).status, 403);
  const disabled = await fixture(t, { ...options, enabledProviders: ['codex'] });
  assert.equal((await disabled.post('fixture', input, { 'X-Office-Token': (await disabled.board()).csrfToken })).status, 503);
  assert.equal(called, 0);
  for (const method of ['GET', 'POST', 'PATCH']) {
    assert.equal(relayUserRouteAllowed(method, '/api/office/grok/blocked-tasks/fixture/handle'), false);
  }
  assert.equal(relayUserRouteAllowed('POST', '/api/office/tasks'), true, 'existing user task creation remains separate');
});

test('Grok patrol config requires explicit versioned ten-minute enablement and fails closed', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-grok-patrol-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'grok-blocked-patrol-config.json');
  assert.equal(GROK_PATROL_INTERVAL_MS, 600000);
  assert.deepEqual(readGrokPatrolConfig(home), { enabled: false, intervalMs: 600000 });
  const enabled = { version: 1, enabled: true, intervalMs: 600000 };
  for (const input of ['{', 'null', '[]', '{}', JSON.stringify({ ...enabled, version: 2 }), JSON.stringify({ ...enabled, enabled: 'true' }), JSON.stringify({ version: 1, enabled: true }), JSON.stringify({ ...enabled, intervalMs: 300000 }), JSON.stringify({ ...enabled, intervalMs: '600000' }), JSON.stringify({ ...enabled, unexpected: true }), ' '.repeat(2049)]) {
    await writeFile(file, input);
    const result = readGrokPatrolConfig(home);
    assert.equal(result.enabled, false);
    assert.equal(result.intervalMs, 600000);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }
  await writeFile(file, JSON.stringify(enabled));
  assert.deepEqual(readGrokPatrolConfig(home), { enabled: true, intervalMs: 600000 });
  await writeFile(file, JSON.stringify({ ...enabled, enabled: false }));
  assert.deepEqual(readGrokPatrolConfig(home), { enabled: false, intervalMs: 600000 });
});
