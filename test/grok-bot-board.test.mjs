import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createTaskRunner, routeTask, GROK_BOT_PENDING_REASON } from '../server/task-runner.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'office-grok-bot-')));
  let clock = Date.now();
  const store = createTaskStore({ home: directory, now: () => clock, leaseMs: 1000 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = (extra = {}) => store.createTask({ title: 'Organize delivery notes', provider: 'grok-bot', projectPath: directory, ...extra });
  const worker = (extra = {}) => ({ id: 'bot-one', provider: 'grok-bot', projectPath: directory, ...extra });
  return { directory, store, add, worker, advance: ms => { clock += ms; } };
}

test('Grok Bot stays external before balance, quota, review and priority routing', () => {
  for (const task of [
    { title: 'Game balance values', priority: 'high' },
    { title: 'Release build', kind: 'review' },
    { title: 'Coordinate daily tasks' },
  ]) {
    assert.deepEqual(routeTask({ ...task, provider: 'grok-bot' }, {
      codex: { windows: [{ name: 'weekly', remainingPercent: 0 }] },
      claude: { windows: [{ name: 'weekly', remainingPercent: 0 }] },
    }), { eligible: [], reason: GROK_BOT_PENDING_REASON });
  }
});

test('external bot claims are role/project scoped, serial per project, and separate from coding', async t => {
  const { store, add, worker, directory } = await fixture(t);
  const coding = add({ provider: 'codex' });
  const first = add({ role: 'Manager' });
  const second = add();
  assert.ok(store.claimTask(worker({ id: 'coder', provider: 'codex' }), { taskId: coding.id }));
  assert.equal(store.claimTask(worker({ role: 'Tester' }), { taskId: first.id }), null);
  assert.equal(store.claimTask(worker({ projectPath: '' }), { taskId: first.id }), null);
  const claim = store.claimTask(worker({ role: 'Manager' }), { taskId: first.id });
  assert.equal(claim.task.projectPath, directory);
  assert.equal(claim.task.assignee.provider, 'grok-bot');
  assert.equal(store.claimTask(worker({ id: 'bot-two' }), { taskId: second.id }), null);
  store.finishTask(first.id, claim.claimToken, { result: 'Notes verified.' });
  assert.ok(store.claimTask(worker({ id: 'bot-two' }), { taskId: second.id }));
  assert.equal(store.snapshot().tasks.some(task => task.kind === 'review'), false, 'external completion must not create coding cross-review');
  assert.throws(() => add({ provider: 'grok' }), /management instruction/);
});

test('provider edits recompute the lock and keep bot/coding claims independent in either order', async t => {
  const { store, add, worker } = await fixture(t);
  const bot = add({ provider: 'codex' });
  store.updateTask(bot.id, { provider: 'grok-bot' });
  const claim = store.claimTask(worker(), { taskId: bot.id });
  assert.ok(claim);
  const coding = add({ provider: 'grok-bot' });
  store.updateTask(coding.id, { provider: 'codex' });
  assert.ok(store.claimTask(worker({ id: 'coder', provider: 'codex' }), { taskId: coding.id }));
  store.finishTask(bot.id, claim.claimToken, { status: 'blocked', error: 'Need source notes.' });
  store.updateTask(bot.id, { status: 'pending' });
  assert.ok(store.claimTask(worker({ id: 'bot-retry' }), { taskId: bot.id }));
});

test('external leases still expire without heartbeat and stale claims cannot complete retried work', async t => {
  const { store, add, worker, advance } = await fixture(t);
  const task = add();
  const first = store.claimTask(worker(), { taskId: task.id });
  advance(750); store.heartbeat(task.id, first.claimToken);
  advance(750); assert.equal(store.snapshot().tasks[0].status, 'running');
  advance(300); assert.equal(store.snapshot().tasks[0].status, 'blocked');
  assert.throws(() => store.finishTask(task.id, first.claimToken, { result: 'Late result' }), /no longer active/);
  store.updateTask(task.id, { status: 'pending' });
  const next = store.claimTask(worker(), { taskId: task.id });
  assert.notEqual(first.claimToken, next.claimToken);
  assert.throws(() => store.heartbeat(task.id, first.claimToken), /no longer active/);
  assert.equal(store.finishTask(task.id, next.claimToken, { result: 'Current result' }).status, 'done');
});

test('paused and restarted office runner keeps external pending reasons and does not own bot leases', async t => {
  const { store, add, worker } = await fixture(t);
  const active = add();
  const claim = store.claimTask(worker(), { taskId: active.id });
  const queued = add({ projectPath: '' });
  store.updateSettings({ autoPickup: false });
  let claims = 0, heartbeats = 0;
  const monitoredStore = { ...store,
    claimTask(...args) { claims++; return store.claimTask(...args); },
    heartbeat(...args) { heartbeats++; return store.heartbeat(...args); },
  };
  const runner = createTaskRunner({ store: monitoredStore, probeProviders: async () => ({}),
    projectValidator: () => assert.fail('external cards must not enter local project validation'),
    spawnProcess: () => assert.fail('external cards must never spawn a local agent'), pollIntervalMs: 10000 });
  try {
    for (let run = 0; run < 2; run++) {
      await runner.start();
      assert.deepEqual(runner.status().pending, [{ taskId: queued.id, reason: GROK_BOT_PENDING_REASON }]);
      assert.equal(runner.status().running.length, 0);
      await runner.stop();
      assert.equal(store.snapshot().tasks.find(task => task.id === active.id).status, 'running');
      store.updateSettings({ autoPickup: true });
    }
    assert.equal(claims, 0); assert.equal(heartbeats, 0);
    assert.equal(store.heartbeat(active.id, claim.claimToken).status, 'running');
    assert.equal(store.finishTask(active.id, claim.claimToken, { result: 'External work complete' }).status, 'done');
  } finally { await runner.stop(); }
});
