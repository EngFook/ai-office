import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createTaskStore, MAINTENANCE_PROTOCOL } from '../server/task-store.mjs';

async function fixture(t, extra = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-board-')));
  await mkdir(path.join(home, 'project'));
  await mkdir(path.join(home, 'other'));
  const clock = { value: 1000 };
  const options = { home, now: () => clock.value, leaseMs: 1000, ...extra };
  const store = createTaskStore(options);
  t.after(() => { try { store.close(); } catch {} });
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectPath = path.join(home, 'project');
  const worker = { id: 'codex-worker', name: 'Codex worker', provider: 'codex', roles: ['Helper', 'Tester'], projectPath };
  return { home, store, clock, options, projectPath, worker };
}

test('validates bounded tasks and blank paths; running requires a claim and manual completion is labeled', async t => {
  const { store, projectPath, worker } = await fixture(t);
  assert.throws(() => store.createTask({ title: 'x', projectPath: 'relative' }), /absolute/);
  assert.throws(() => store.createTask({ title: 'x'.repeat(241) }), /240/);
  assert.throws(() => store.createTask({ title: 'Grok task', provider: 'grok' }), /management instruction/);
  const task = store.createTask({ title: 'Task', description: 'Do real work', provider: 'codex', role: 'Helper' });
  assert.equal(task.status, 'pending');
  assert.equal(store.claimTask(worker), null);
  assert.throws(() => store.updateTask(task.id, { status: 'running' }), /Invalid task status/);
  assert.throws(() => store.updateTask(task.id, { assignee: worker }), /Cannot change/);
  const updated = store.updateTask(task.id, { projectPath }, { version: task.version });
  assert.equal(updated.version, 2);
  assert.throws(() => store.updateTask(task.id, { title: 'stale' }, { version: 1 }), /Refresh/);
  const claim = store.claimTask(worker);
  assert.equal(claim.task.status, 'running');
  assert.throws(() => store.updateTask(task.id, { description: 'changed during work' }), /Only pending or blocked/);
  assert.ok(!JSON.stringify(store.snapshot()).includes(claim.claimToken));
  assert.ok(!Object.hasOwn(store.snapshot().tasks[0], 'claimToken'));
  const manual = store.createTask({ title: 'User completed externally' });
  const completed = store.updateTask(manual.id, { status: 'done' });
  assert.equal(completed.result, 'Marked done manually by user.');
  assert.equal(completed.completionSource, 'manual');
  assert.equal(completed.assignee, null);
});

test('claims match provider, role and canonical project; same project and worker cannot run twice', async t => {
  const { store, home, projectPath, worker } = await fixture(t, { crossReview: false });
  const alias = path.join(home, 'project-alias');
  await symlink(projectPath, alias);
  const claude = store.createTask({ title: 'Claude only', provider: 'claude', projectPath, role: 'Tester', priority: 'high' });
  const codex = store.createTask({ title: 'Codex help', provider: 'codex', projectPath: alias, role: 'Helper' });
  const other = store.createTask({ title: 'Other project', projectPath: path.join(home, 'other') });
  assert.equal(store.claimTask({ ...worker, roles: ['Admin'] }), null);
  const first = store.claimTask(worker);
  assert.equal(first.task.id, codex.id);
  assert.equal(first.task.projectPath, projectPath);
  assert.equal(store.claimTask({ ...worker, id: 'second', provider: 'claude' }), null);
  assert.equal(store.claimTask({ ...worker, projectPaths: [path.join(home, 'other')] }), null);
  assert.equal(store.claimTask({ ...worker, id: 'other-worker', projectPaths: [path.join(home, 'other')] }).task.id, other.id);
  store.finishTask(first.task.id, first.claimToken, { status: 'done', result: 'Finished verified work.' });
  assert.equal(store.claimTask({ ...worker, providers: ['codex', 'claude'], projectPaths: [alias] }).task.id, claude.id);
});

test('heartbeat renews lease; expired claims block on restart and require explicit retry', async t => {
  const { store, options, clock, projectPath, worker } = await fixture(t);
  const task = store.createTask({ title: 'May edit files', projectPath });
  const claim = store.claimTask(worker);
  clock.value = 1500;
  store.heartbeat(task.id, claim.claimToken);
  clock.value = 2200;
  assert.equal(store.snapshot().tasks[0].status, 'running');
  assert.throws(() => store.finishTask(task.id, 'wrong-token', { status: 'done' }), /claim/);
  store.close();
  clock.value = 3000;
  const restarted = createTaskStore(options);
  t.after(() => restarted.close());
  const blocked = restarted.snapshot().tasks[0];
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error, /Review the project/);
  assert.equal(restarted.claimTask(worker), null);
  assert.throws(() => restarted.finishTask(task.id, claim.claimToken, { status: 'done' }), /claim/);
  restarted.updateTask(task.id, { status: 'pending' }, { version: blocked.version });
  const retry = restarted.claimTask(worker);
  assert.notEqual(retry.claimToken, claim.claimToken);
  assert.equal(restarted.finishTask(task.id, retry.claimToken, { status: 'blocked', error: 'Needs user input' }).status, 'blocked');
});

test('management plans are atomic, idempotent and create pending tasks with provenance', async t => {
  const { store, projectPath } = await fixture(t);
  const instruction = store.createInstruction({ text: 'Create a delivery plan', projectPath });
  store.updateInstruction(instruction.id, { status: 'running' });
  assert.throws(() => store.applyManagementPlan(instruction.id, { roles: [{ name: 'Release lead' }], tasks: [{ title: 'valid' }, { title: '' }] }), /required/);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().roles.length, 0);
  const plan = { summary: 'Implement, then verify.', roles: [{ name: 'Release lead', description: 'Coordinate delivery', provider: 'grok' }], tasks: [{ title: 'Implement', provider: 'codex', role: 'Helper' }, { title: 'Verify', provider: 'claude', role: 'Tester' }] };
  const applied = store.applyManagementPlan(instruction.id, plan);
  assert.equal(applied.applied, true);
  assert.equal(applied.instruction.status, 'done');
  assert.ok(applied.tasks.every(task => task.status === 'pending' && task.source === 'grok' && task.managementRequestId === instruction.id && task.projectPath === projectPath));
  assert.equal(store.applyManagementPlan(instruction.id, plan).applied, false);
  assert.equal(store.snapshot().tasks.length, 2);
  assert.equal(store.snapshot().roles.length, 1);
  assert.deepEqual(store.updateSettings({ autoPickup: true }), { autoPickup: true });
});

test('fresh stores enable pickup while an existing explicit pause is preserved', async t => {
  const { store, options } = await fixture(t);
  assert.equal(store.snapshot().settings.autoPickup, true);
  store.updateSettings({ autoPickup: false }); store.close();
  const reopened = createTaskStore(options); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().settings.autoPickup, false);
});

test('independent SQLite connections atomically prevent concurrent double pickup', async t => {
  const { store, home, projectPath } = await fixture(t, { now: Date.now, leaseMs: 60000 });
  store.createTask({ title: 'Only one worker', projectPath });
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const flags = new Int32Array(gate);
  const moduleUrl = new URL('../server/task-store.mjs', import.meta.url).href;
  const results = [1, 2].map(index => new Promise((resolve, reject) => {
    const thread = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {createTaskStore}=await import(workerData.moduleUrl); const store=createTaskStore({home:workerData.home});const flags=new Int32Array(workerData.gate);Atomics.add(flags,0,1);Atomics.wait(flags,1,0);const claim=store.claimTask({id:'worker-'+workerData.index,provider:'codex',role:'Helper',projectPath:workerData.projectPath});store.close();parentPort.postMessage(Boolean(claim));})().catch(error=>{throw error;});`, { eval: true, workerData: { moduleUrl, home, projectPath, gate, index } });
    thread.once('message', resolve); thread.once('error', reject);
  }));
  while (Atomics.load(flags, 0) < 2) await new Promise(resolve => setTimeout(resolve, 5));
  Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
  assert.equal((await Promise.all(results)).filter(Boolean).length, 1);
  assert.equal(store.snapshot().tasks.filter(task => task.status === 'running').length, 1);
});


test('observer snapshots never recover leases or mutate task records', async t => {
  const { store, clock, projectPath, worker } = await fixture(t);
  const task = store.createTask({ title: 'External observed worker', projectPath });
  store.claimTask(worker, { taskId: task.id });
  const before = store.snapshot({ recoverLeases: false }).tasks;
  clock.value += 5000;
  assert.deepEqual(store.snapshot({ recoverLeases: false }).tasks, before);
  assert.equal(store.snapshot().tasks[0].status, 'blocked', 'normal scheduler still recovers expired claims');
});


test('maintenance persists across connections and restart, is owner-bound and never changes pickup settings', async t => {
  const { store, options, projectPath, worker, clock } = await fixture(t, { crossReview: false });
  const owner = randomUUID(), otherOwner = randomUUID();
  const idle = { protocol: MAINTENANCE_PROTOCOL, active: false };
  const active = { protocol: MAINTENANCE_PROTOCOL, active: true };
  assert.equal(MAINTENANCE_PROTOCOL, 1);
  assert.deepEqual(store.snapshot().maintenance, idle);
  assert.throws(() => store.acquireMaintenance(''), /UUID/);
  assert.throws(() => store.releaseMaintenance(null), /UUID/);
  store.createTask({ title: 'Must wait for deployment', projectPath });
  store.updateSettings({ autoPickup: false });
  assert.deepEqual(store.acquireMaintenance(owner), active);
  assert.deepEqual(store.acquireMaintenance(owner), active, 'retry after a lost response is idempotent');
  const conflict = error => error.code === 'MAINTENANCE_CONFLICT' && error.status === 409;
  assert.throws(() => store.acquireMaintenance(otherOwner), conflict);
  assert.throws(() => store.releaseMaintenance(otherOwner), conflict);
  assert.ok(!JSON.stringify(store.snapshot()).includes(owner));
  assert.equal(store.snapshot().settings.autoPickup, false);
  const second = createTaskStore(options);
  assert.deepEqual(second.snapshot().maintenance, active);
  assert.equal(second.claimTask(worker), null);
  second.close();
  store.close();
  clock.value += 30 * 24 * 60 * 60 * 1000;
  const restarted = createTaskStore(options); t.after(() => restarted.close());
  assert.deepEqual(restarted.snapshot().maintenance, active, 'there is no automatic expiration');
  assert.equal(restarted.claimTask(worker), null);
  assert.deepEqual(restarted.releaseMaintenance(owner), idle);
  assert.deepEqual(restarted.releaseMaintenance(owner), idle, 'release retries are idempotent');
  assert.deepEqual(restarted.releaseMaintenance(otherOwner), idle, 'an absent gate has no owner');
  assert.equal(restarted.snapshot().settings.autoPickup, false);
  assert.ok(restarted.claimTask(worker));
});

test('maintenance blocks every store claim while existing work can heartbeat and finish', async t => {
  const { store, options, projectPath, worker, home } = await fixture(t, { crossReview: false });
  const running = store.createTask({ title: 'Already running', projectPath });
  const claim = store.claimTask(worker, { taskId: running.id });
  const pending = store.createTask({ title: 'Pending elsewhere', projectPath: path.join(home, 'other') });
  const owner = randomUUID();
  store.acquireMaintenance(owner);
  const second = createTaskStore(options); t.after(() => second.close());
  const nextWorker = { ...worker, id: 'next-worker', projectPath: pending.projectPath };
  assert.equal(second.claimTask(nextWorker), null);
  assert.equal(second.claimTask(nextWorker, { taskId: pending.id }), null);
  assert.equal(second.heartbeat(running.id, claim.claimToken).status, 'running');
  assert.equal(second.finishTask(running.id, claim.claimToken, { result: 'Completed during drain' }).status, 'done');
  assert.equal(second.claimTask(nextWorker, { taskId: pending.id }), null);
  store.releaseMaintenance(owner);
  assert.equal(second.claimTask(nextWorker, { taskId: pending.id }).task.id, pending.id);
});

test('independent worker connections cannot acquire another owner gate or claim behind it', async t => {
  const { store, home, projectPath } = await fixture(t, { now: Date.now, leaseMs: 60000 });
  const task = store.createTask({ title: 'Wait behind the maintenance transaction', projectPath });
  store.acquireMaintenance(randomUUID());
  const moduleUrl = new URL('../server/task-store.mjs', import.meta.url).href;
  const results = await Promise.all([1, 2].map(index => new Promise((resolve, reject) => {
    const thread = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {createTaskStore}=await import(workerData.moduleUrl);const store=createTaskStore({home:workerData.home});const worker={id:'worker-'+workerData.index,provider:'codex',projectPath:workerData.projectPath};let conflict;try{store.acquireMaintenance(workerData.owner);}catch(error){conflict=error.code;}const automatic=store.claimTask(worker);const explicit=store.claimTask(worker,{taskId:workerData.taskId});store.close();parentPort.postMessage({automatic,explicit,conflict});})().catch(error=>{throw error;});`, { eval: true, workerData: { moduleUrl, home, projectPath, taskId: task.id, index, owner: randomUUID() } });
    thread.once('message', resolve); thread.once('error', reject);
  })));
  for (const result of results) assert.deepEqual(result, { automatic: null, explicit: null, conflict: 'MAINTENANCE_CONFLICT' });
  assert.equal(store.snapshot().tasks[0].status, 'pending');
});


test('simultaneous deployment owners serialize acquisition and leave all new claims blocked', async t => {
  const { store, home, projectPath } = await fixture(t, { now: Date.now, leaseMs: 60000 });
  const task = store.createTask({ title: 'No pickup after the winning acquisition', projectPath });
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2), flags = new Int32Array(gate);
  const moduleUrl = new URL('../server/task-store.mjs', import.meta.url).href;
  const results = [1, 2].map(index => new Promise((resolve, reject) => {
    const thread = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {createTaskStore}=await import(workerData.moduleUrl);const store=createTaskStore({home:workerData.home});const flags=new Int32Array(workerData.gate);Atomics.add(flags,0,1);Atomics.wait(flags,1,0);let acquired=false;try{store.acquireMaintenance(workerData.owner);acquired=true;}catch(error){if(error.code!=='MAINTENANCE_CONFLICT')throw error;}const claim=store.claimTask({id:'worker-'+workerData.index,provider:'codex',projectPath:workerData.projectPath},{taskId:workerData.taskId});store.close();parentPort.postMessage({acquired,claim});})().catch(error=>{throw error;});`, { eval: true, workerData: { moduleUrl, home, projectPath, taskId: task.id, index, gate, owner: randomUUID() } });
    thread.once('message', resolve); thread.once('error', reject);
  }));
  while (Atomics.load(flags, 0) < 2) await new Promise(resolve => setTimeout(resolve, 5));
  Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
  const completed = await Promise.all(results);
  assert.equal(completed.filter(result => result.acquired).length, 1);
  assert.ok(completed.every(result => result.claim === null));
  assert.deepEqual(store.snapshot().maintenance, { protocol: 1, active: true });
});

test('original author cannot claim its own review even after reviewer reassignment', async t => {
  const { store, projectPath, worker } = await fixture(t);
  const original = store.createTask({ title: 'Implementation', provider: 'codex', projectPath });
  const claimed = store.claimTask(worker, { taskId: original.id });
  store.finishTask(original.id, claimed.claimToken, { status: 'done', result: 'Implemented and checked.' });
  const review = store.snapshot().tasks.find(task => task.reviewOf === original.id);
  assert.equal(review.provider, 'claude');
  store.updateTask(review.id, { provider: 'codex' });
  assert.equal(store.claimTask(worker, { taskId: review.id }), null);
  store.updateTask(review.id, { provider: 'any' });
  assert.equal(store.claimTask(worker, { taskId: review.id }), null);
  assert.ok(store.claimTask({ ...worker, id: 'independent-claude', provider: 'claude' }, { taskId: review.id }));
});

test('restored watch recovery cannot bypass unsynced approval or user-denied gates', async t => {
  const { store, projectPath, worker } = await fixture(t, { crossReview: false });
  const task = store.createTask({ title: 'Authorized implementation', provider: 'codex', projectPath });
  const claim = store.claimTask(worker, { taskId: task.id });
  const blocked = store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Waiting for user approval before deployment.' });
  assert.equal(store.watchRetryAvailable(blocked), false, 'permission boundary holds even before questions are synchronized');
  assert.equal(store.applyWatchDecision({ provider: 'codex', taskId: task.id, version: blocked.version, action: 'retry' }), false);
  const [question] = store.syncHumanRequests();
  const response = store.answerHumanRequest(question.id, { source: 'office-ui', replyAuthor: 'user', userMessageId: 'user-denial', userReply: '不批准', userAction: 'deny', decision: 'deny', questionHash: question.questionHash });
  assert.equal(response.task.humanGate.state, 'denied');
  assert.equal(store.watchRetryAvailable(response.task), false);
  assert.equal(store.applyWatchDecision({ provider: 'codex', taskId: task.id, version: response.task.version, action: 'retry' }), false);
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).status, 'blocked');
});
