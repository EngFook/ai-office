import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-card-actions-'));
  const store = createTaskStore({ home, crossReview: false });
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const worker = { id: 'fixture', provider: 'codex', roles: ['any'], projectPath: home };
  const create = title => store.createTask({ title, provider: 'codex', projectPath: home });
  const current = id => [...store.snapshot().tasks, ...store.snapshot().deletedTasks].find(task => task.id === id);
  const act = (task, action, extra = {}) => store.cardAction(task.id, { version: task.version, action, operationId: 'fixture-op', ...extra });
  return { home, store, worker, create, current, act };
}

test('delete hides and prevents claims; restore preserves history and requires explicit re-request', async t => {
  const f = await fixture(t), task = f.create('recoverable');
  const deleted = f.act(task, 'delete').task;
  assert.equal(f.store.snapshot().tasks.length, 0);
  assert.equal(f.store.snapshot().deletedTasks.length, 1);
  assert.equal(f.store.claimTask(f.worker, { taskId: task.id }), null);
  assert.throws(() => f.act(task, 'restore'), /更新/);
  const restored = f.act(deleted, 'restore').task;
  assert.equal(restored.title, task.title);
  assert.equal(restored.status, 'blocked');
  assert.equal(f.store.claimTask(f.worker), null);
  const queued = f.act(restored, 'rerequest').task;
  assert.equal(queued.status, 'pending');
  assert.equal(f.store.claimTask(f.worker).task.id, task.id);
});

test('running and changed cards cannot be deleted or rejected', async t => {
  const f = await fixture(t), task = f.create('in progress');
  const claim = f.store.claimTask(f.worker);
  assert.throws(() => f.act(task, 'delete'), /更新/);
  for (const action of ['delete', 'deny', 'rerequest']) assert.throws(() => f.act(claim.task, action), /正在执行/);
  assert.equal(f.current(task.id).status, 'running');
});

test('reject ordinary work pauses it and explicit re-request can resume only that user stop', async t => {
  const f = await fixture(t), task = f.create('ordinary');
  const denied = f.act(task, 'deny').task;
  assert.equal(denied.paused, true);
  assert.equal(f.store.claimTask(f.worker), null);
  // Even the old edit route cannot make a paused card runnable.
  const edited = f.store.updateTask(task.id, { status: 'pending' });
  assert.equal(f.store.claimTask(f.worker), null);
  f.store.updateTask(task.id, { status: 'blocked' });
  assert.equal(f.act(f.current(task.id), 'rerequest').task.status, 'pending');
  const parked = f.create('[paused] original user pause');
  const deleted = f.act(parked, 'delete').task;
  const restored = f.act(deleted, 'restore').task;
  assert.throws(() => f.act(restored, 'rerequest'), /暂停/);
});

test('bound approval uses actual deny/re-request without granting approval; trash hides notifications', async t => {
  const f = await fixture(t), task = f.create('needs decision');
  const claim = f.store.claimTask(f.worker);
  f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Approval required: deploy current change.' });
  f.store.syncHumanRequests();
  let question = f.store.snapshot().humanRequests[0];
  const denied = f.act(f.current(task.id), 'deny', { questionHash: question.questionHash }).task;
  assert.equal(denied.humanGate.state, 'denied');
  const deleted = f.act(denied, 'delete').task;
  assert.deepEqual(f.store.syncHumanRequests(), []);
  assert.deepEqual(f.store.snapshot().humanRequests, []);
  const restored = f.act(deleted, 'restore').task;
  assert.equal(restored.humanGate.state, 'denied');
  assert.equal(f.store.snapshot().humanRequests[0].state, 'denied');
  const asked = f.act(restored, 'rerequest', { questionHash: question.questionHash });
  assert.equal(asked.task.status, 'blocked');
  assert.equal(asked.request.requiresUserAction, true);
  assert.equal(f.store.claimTask(f.worker), null);
  assert.throws(() => f.act(asked.task, 'deny', { questionHash: question.questionHash }), /问题已更新/);
  assert.throws(() => f.act(asked.task, 'rerequest', { questionHash: asked.request.questionHash, operationId: 'again' }), /one minute/);
});

test('linked reviews are paused on delete and a running review prevents parent deletion', async t => {
  const f = await fixture(t), parent = f.create('parent');
  const review = f.store.createTask({ title: 'review', kind: 'review', reviewOf: parent.id, projectPath: f.home, provider: 'codex' });
  f.act(parent, 'delete');
  assert.equal(f.current(review.id).paused, true);
  assert.equal(f.store.claimTask(f.worker, { taskId: review.id }), null);
  let parent2 = f.create('parent2');
  const originalClaim = f.store.claimTask(f.worker, { taskId: parent2.id });
  parent2 = f.store.finishTask(parent2.id, originalClaim.claimToken, { status: 'done', result: 'Implementation completed.' });
  const review2 = f.store.createTask({ title: 'review2', kind: 'review', reviewOf: parent2.id, projectPath: f.home, provider: 'claude' });
  assert.ok(f.store.claimTask({ ...f.worker, id: 'independent-reviewer', provider: 'claude' }, { taskId: review2.id }));
  assert.throws(() => f.act(parent2, 'delete'), /关联排查或审查/);
});

test('restoring an answered approval stays paused; re-request opens a fresh question without executing', async t => {
  const f = await fixture(t), task = f.create('approved work');
  const claim = f.store.claimTask(f.worker);
  f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Approval required: deploy current change.' });
  f.store.syncHumanRequests();
  const question = f.store.snapshot().humanRequests[0];
  const answered = f.store.answerHumanRequest(question.id, { source: 'office-ui', replyAuthor: 'user', questionHash: question.questionHash, userMessageId: 'approval', decision: 'approve', userAction: 'approve', userReply: '' }).task;
  const deleted = f.act(answered, 'delete').task;
  const restored = f.act(deleted, 'restore').task;
  assert.equal(restored.paused, true);
  assert.equal(f.store.claimTask(f.worker), null);
  const asked = f.act(restored, 'rerequest').task;
  assert.equal(asked.status, 'blocked');
  assert.equal(asked.humanGate.state, 'pending');
  assert.notEqual(asked.humanGate.requestId, question.id);
  assert.equal(f.store.claimTask(f.worker), null);
});

test('denying a bound question pauses linked reviews; deleted questions cannot be acknowledged', async t => {
  const f = await fixture(t), task = f.create('approval parent');
  const claim = f.store.claimTask(f.worker);
  f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Approval required: deploy current change.' });
  f.store.syncHumanRequests();
  const question = f.store.snapshot().humanRequests[0];
  const review = f.store.createTask({ title: 'linked review', kind: 'review', reviewOf: task.id, provider: 'codex', projectPath: f.home });
  f.act(f.current(task.id), 'deny', { questionHash: question.questionHash });
  assert.equal(f.current(review.id).paused, true);
  assert.equal(f.store.claimTask(f.worker, { taskId: review.id }), null);
  const pending = f.act(f.current(task.id), 'rerequest', { questionHash: question.questionHash });
  f.act(pending.task, 'delete');
  assert.throws(() => f.store.acknowledgeHumanRequest(pending.request.id, { source: 'grok-bot', questionHash: pending.request.questionHash, messageId: 'late-notification' }), /已删除/);
});
