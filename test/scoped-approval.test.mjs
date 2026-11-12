import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createTaskStore } from '../server/task-store.mjs';
import { humanRequestFingerprint, explicitApproval } from '../server/human-relay-policy.mjs';
import { PREPARE_ACTION, parsePreparationApproval } from '../server/scoped-approval.mjs';
import { recoveryPrompt } from '../server/resolution-policy.mjs';
import { huddleInputHash } from '../server/huddle-policy.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

const CN = '同意净化准备方案';
const MIX = '同意净化准备方案，保留旧本地历史和未提交改动，不批准最终合并。';
const positives = [CN, MIX, '批准净化准备方案。', '允许准备净化快照',
  'I approve sanitized snapshot preparation.',
  'I authorize prepare_sanitized_snapshot; preserve old local history and uncommitted changes; I do not approve final merge.',
  '同意净化准备方案，不批准合并，不允许推送，暂不批准部署。'];
const negatives = ['', '同意', 'Yes', 'Yes, approve the specific request.', '不同意净化准备方案', '不批准净化准备方案',
  'I do not approve sanitized snapshot preparation', 'No', '批准：不是净化准备方案',
  '同意净化准备方案，不同意净化准备方案', '同意净化准备方案，批准最终合并', '同意净化准备方案和合并',
  '同意净化准备方案，允许推送', '同意净化准备方案，执行未知动作', '同意净化准备方案，如果测试通过',
  '同意净化准备方案吗', '是否同意净化准备方案', '同意净化准备方案？', '“同意净化准备方案”',
  '他说同意净化准备方案', '请回复同意净化准备方案', '同意净化准备方案，但不是许可',
  'I approve sanitized snapshot preparation; deploy', 'I approve sanitized snapshot preparation; I approve merge',
  'I approve sanitized snapshot preparation; I do not approve sanitized snapshot preparation',
  '同意净化准备方案\n部署', '同意净化准备方案，，不批准合并', '同意净化准备方案，确认'];

async function fixture(t, scoped = true) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-scoped-synthetic-')));
  const options = { home, researchDir: home, crossReview: false, now: () => Date.parse('2026-11-08T00:00:00Z') };
  const f = { home, store: createTaskStore(options) };
  t.after(async () => { f.store.close(); await rm(home, { recursive: true, force: true }); });
  f.worker = { id: 'synthetic-worker', provider: 'codex', roles: ['any'], projectPath: home };
  f.block = (input = {}, error = 'Approval required: prepare a sanitized snapshot. Later merge needs separate approval.') => {
    let task = f.store.createTask({ title: 'Synthetic scoped preparation', description: 'Preparation only. Future merge/push/deploy require separate authorization.', provider: 'codex', projectPath: home, ...input });
    const claim = f.store.claimTask(f.worker, { taskId: task.id });
    f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
    if (scoped) task = f.store.updateTask(task.id, { approvalAction: PREPARE_ACTION });
    f.store.syncHumanRequests();
    return f.store.snapshot().humanRequests.find(q => q.taskId === task.id && q.state === 'pending');
  };
  f.ack = q => f.store.acknowledgeHumanRequest(q.id, { source: 'grok-bot', questionHash: q.questionHash, messageId: `synthetic-delivery-${q.id}` });
  f.reply = (q, extra = {}) => ({ source: 'grok-bot', replyAuthor: 'user', userMessageId: `synthetic-user-${q.id}`, userReply: MIX, questionHash: q.questionHash, decision: 'approve', ...extra });
  f.raw = () => {
    const db = new DatabaseSync(f.store.dbPath);
    try { return ['tasks', 'human_requests', 'human_replies', 'settings'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
    finally { db.close(); }
  };
  f.reject = (q, extra, pattern = /./) => {
    const before = f.raw(); assert.throws(() => f.store.answerHumanRequest(q.id, f.reply(q, extra)), pattern);
    assert.deepEqual(f.raw(), before, JSON.stringify(extra));
  };
  f.restart = () => { f.store.close(); f.store = createTaskStore(options); };
  return f;
}

test('finite preparation grammar consumes every clause and retains mixed denials', () => {
  assert.equal(explicitApproval(CN), false); assert.equal(explicitApproval(MIX), false);
  for (const text of positives) assert.deepEqual(parsePreparationApproval(text)?.allowedActions, [PREPARE_ACTION], text);
  for (const text of negatives) assert.equal(parsePreparationApproval(text), null, text);
  assert.deepEqual(parsePreparationApproval(MIX).deniedActions, ['merge']);
  assert.deepEqual(parsePreparationApproval(positives.at(-1)).deniedActions, ['merge', 'push', 'deploy']);
});

test('new synthetic approvals bind one action/project and preserve verbatim evidence and denials', async t => {
  const f = await fixture(t);
  for (const [i, userReply] of positives.entries()) {
    const q = f.block(); f.ack(q);
    assert.deepEqual(q.approvalScope, { version: 1, action: PREPARE_ACTION, projectPath: f.home });
    assert.match(q.question, /不授权 merge、push、deploy/);
    const raw = `  ${userReply}  `, input = f.reply(q, { userReply: raw, userMessageId: `synthetic-positive-${i}` });
    const result = f.store.answerHumanRequest(q.id, input), a = result.request.answer;
    assert.equal(result.task.status, 'pending'); assert.equal(a.userReply, raw); assert.equal(a.replyAuthor, 'user');
    assert.equal(a.requestId, q.id); assert.equal(a.questionHash, q.questionHash); assert.equal(a.fingerprint, q.fingerprint);
    assert.equal(a.delivery.messageId, `synthetic-delivery-${q.id}`); assert.deepEqual(a.authorization.allowedActions, [PREPARE_ACTION]);
    assert.deepEqual(result.task.humanReply.approvalScope, q.approvalScope);
    assert.ok(recoveryPrompt(result.task).includes('never authorizes merge, push, deploy'));
    if (userReply === MIX) assert.deepEqual(a.authorization.deniedActions, ['merge']);
    const duplicate = f.store.answerHumanRequest(q.id, input);
    assert.equal(duplicate.applied, false); assert.equal(duplicate.task.version, result.task.version);
    const claim = f.store.claimTask(f.worker, { taskId: q.taskId });
    f.store.finishTask(q.taskId, claim.claimToken, { status: 'done', summary: 'Synthetic fixture only.' });
  }
});

test('invalid prose, metadata, evidence and office button bypass leave all fixture records unchanged', async t => {
  const f = await fixture(t), q = f.block(); f.reject(q, {}, /delivered/); f.ack(q);
  for (const userReply of negatives) f.reject(q, { userReply });
  for (const extra of [
    { questionHash: 'wrong-or-expired-hash' }, { questionHash: undefined }, { replyAuthor: 'assistant' }, { replyAuthor: undefined },
    { source: 'codex' }, { source: 'user' }, { userReply: undefined }, { userMessageId: undefined }, { userMessageId: '' },
    { userMessageId: `synthetic-delivery-${q.id}` }, { decision: 'provide_info' }, { projectPath: f.home },
    { source: 'office-ui', userAction: 'approve', userReply: '' },
    { source: 'office-ui', userAction: 'approve', userReply: undefined },
    { source: 'office-ui', userAction: 'approve', userReply: '不批准净化准备方案' },
    { source: 'office-ui', userAction: 'approve', userReply: '同意净化准备方案，批准合并' },
  ]) f.reject(q, extra);
});

test('stale fingerprint and cross-question replay reject without sync side effects', async t => {
  const f = await fixture(t), q = f.block(); f.ack(q);
  f.store.updateTask(q.taskId, { description: 'Changed synthetic scope.' }); f.reject(q, {}, /unanswered question/);
  f.store.syncHumanRequests(); f.reject(q, {}, /unanswered question/);
  const next = f.store.snapshot().humanRequests.find(r => r.taskId === q.taskId && r.state === 'pending'); f.ack(next);
  f.store.answerHumanRequest(next.id, f.reply(next, { userMessageId: 'synthetic-reused-evidence' }));
  const other = f.block(); f.ack(other); f.reject(other, { userMessageId: 'synthetic-reused-evidence' }, /different question/);
});

test('expired hash after synthetic rerequest preserves action but never grants using old evidence', async t => {
  const f = await fixture(t), q = f.block(); f.ack(q);
  f.store.answerHumanRequest(q.id, f.reply(q, { decision: 'deny', userReply: '不批准净化准备方案' }));
  const fresh = f.store.rerequestHumanRequest(q.id, { source: 'office-ui', operationId: 'synthetic-rerequest', questionHash: q.questionHash }).request;
  assert.notEqual(fresh.questionHash, q.questionHash); assert.deepEqual(fresh.approvalScope, q.approvalScope);
  f.ack(fresh); f.reject(fresh, { questionHash: q.questionHash, userMessageId: 'synthetic-expired' }, /binding/);
});

test('legacy restart/sync preserves records and hash; explicit task edits create a distinct action binding', async t => {
  const f = await fixture(t, false), q = f.block(); f.ack(q);
  const original = f.store.snapshot().humanRequests[0], task = f.store.snapshot().tasks[0];
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const legacy = digest([task.id, task.title, task.description, task.provider, task.projectPath, task.kind, task.role, task.reviewOf, task.supportType, task.priority, task.error || '', task.result || '', task.humanRevision || 0, task.humanEpisode || 0]);
  assert.equal(q.fingerprint, legacy); assert.equal(q.questionHash, digest([task.id, q.fingerprint, q.kind, q.question]));
  f.restart(); f.store.syncHumanRequests(); assert.deepEqual(f.store.snapshot().humanRequests[0], original);
  for (const userReply of [CN, '同意，净化准备方案', 'Yes, sanitized snapshot preparation only.', 'I approve preparation only.', 'Yes, only create the clean snapshot.', 'Yes, but keep merge blocked.', '同意，只创建干净快照。', 'I approve an unknown action.']) f.reject(q, { userReply }, /explicit action binding/);
  f.reject(q, { source: 'office-ui', userAction: 'approve', userReply: 'Yes, only create the clean snapshot.' }, /explicit action binding/);
  f.store.updateTask(task.id, { approvalAction: PREPARE_ACTION });
  const changed = f.store.snapshot().tasks[0];
  assert.notEqual(humanRequestFingerprint(changed), legacy); assert.notEqual(huddleInputHash(changed), huddleInputHash(task));
  f.reject(q, {}, /scope binding/); f.store.syncHumanRequests();
  const all = f.store.snapshot().humanRequests, fresh = all.find(r => r.state === 'pending');
  assert.equal(all.find(r => r.id === q.id).questionHash, q.questionHash); assert.equal(all.find(r => r.id === q.id).approvalScope, undefined);
  assert.notEqual(fresh.id, q.id); assert.notEqual(fresh.questionHash, q.questionHash); assert.equal(fresh.approvalScope.action, PREPARE_ACTION);
  assert.throws(() => f.store.updateTask(task.id, { approvalAction: 'merge' }), /approval action/);
  f.store.updateTask(task.id, { approvalAction: null }); f.store.syncHumanRequests();
  assert.equal(f.store.snapshot().humanRequests.find(r => r.state === 'pending').approvalScope, undefined);
});

test('unknown actions, unsupported workers and information never become preparation approvals', async t => {
  const f = await fixture(t);
  for (const approvalAction of ['merge', 'push', 'deploy', [PREPARE_ACTION], { action: PREPARE_ACTION }])
    assert.throws(() => f.store.createTask({ title: 'Synthetic invalid', projectPath: f.home, approvalAction }), /approval action/);
  for (const provider of ['local-qwen', 'gemini', 'grok-bot']) assert.throws(() => f.store.createTask({ title: 'Synthetic invalid', provider, approvalAction: PREPARE_ACTION }), /coding worker|supported assistance/);
  const q = f.block({}, 'HTTP 401 authentication required; please log in.'); f.ack(q);
  assert.equal(q.kind, 'info'); assert.equal(q.approvalScope, undefined); f.reject(q, {}, /distinct/);
  f.store.answerHumanRequest(q.id, f.reply(q, { decision: 'provide_info', userReply: 'Synthetic environment restored.' }));
  assert.equal(f.store.claimTask(f.worker, { taskId: q.taskId }), null);
  assert.equal(f.store.snapshot().tasks.find(task => task.id === q.taskId).status, 'blocked');
  f.store.syncHumanRequests();
  const preparationQuestion = f.store.snapshot().humanRequests.find(r => r.taskId === q.taskId && r.state === 'pending');
  assert.equal(preparationQuestion.kind, 'approval'); assert.equal(preparationQuestion.approvalScope.action, PREPARE_ACTION);
  assert.notEqual(preparationQuestion.questionHash, q.questionHash);
  const fresh = f.store.createTask({ title: 'Synthetic direct scoped task', provider: 'codex', projectPath: f.home, approvalAction: PREPARE_ACTION });
  assert.equal(fresh.status, 'blocked'); assert.equal(f.store.claimTask(f.worker, { taskId: fresh.id }), null);
  f.store.syncHumanRequests();
  assert.equal(f.store.snapshot().humanRequests.find(r => r.taskId === fresh.id).approvalScope.action, PREPARE_ACTION);
  assert.throws(() => f.store.createTask({ title: 'Synthetic invalid review', provider: 'codex', kind: 'review', approvalAction: PREPARE_ACTION }), /ordinary coding task/);
});

test('synthetic HTTP failures/duplicates trigger neither scheduler nor webhook; success is isolated', async t => {
  const f = await fixture(t), q = f.block(); f.ack(q);
  let middleware, scheduler = 0, webhook = 0;
  taskBoardBridge({ store: f.store, onTaskChange: () => { scheduler++; webhook++; } }).configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, { csrfToken } = await (await fetch(`${base}/api/office/board`)).json();
  const post = (extra, headers = {}, route = 'answer') => fetch(`${base}/api/office/human-requests/${q.id}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': csrfToken, ...headers }, body: JSON.stringify(f.reply(q, extra)) });
  for (const userReply of negatives) {
    const before = f.raw(); assert.equal((await post({ userReply })).status, 400); assert.deepEqual(f.raw(), before);
    assert.equal(scheduler, 0); assert.equal(webhook, 0);
  }
  for (const [extra, headers, status] of [
    [{}, { 'X-Office-Token': '' }, 403], [{}, { Origin: 'https://outside.invalid' }, 403],
    [{ source: 'office-ui' }, {}, 400], [{ replyAuthor: 'assistant' }, {}, 400],
    [{ questionHash: 'old-hash' }, {}, 409], [{ userMessageId: undefined }, {}, 400],
  ]) { const before = f.raw(); assert.equal((await post(extra, headers)).status, status); assert.deepEqual(f.raw(), before); }
  assert.equal((await post({ source: 'office-ui', userAction: 'approve', userReply: '不批准净化准备方案' }, {}, 'respond')).status, 400);
  assert.equal(scheduler, 0); assert.equal(webhook, 0);
  assert.equal((await post({})).status, 200); assert.equal(scheduler, 1); assert.equal(webhook, 1);
  const before = f.raw(); assert.equal((await post({})).status, 200); assert.deepEqual(f.raw(), before);
  assert.equal(scheduler, 1); assert.equal(webhook, 1);
});

test('valid HTTP denials persist without waking scheduler or webhook on either reply route', async t => {
  for (const kind of ['scoped', 'legacy', 'info']) for (const route of ['answer', 'respond', 'card-actions']) await t.test(`${kind} ${route}`, async t => {
    const f = await fixture(t, kind === 'scoped');
    const q = f.block({}, kind === 'info' ? 'Please provide the missing test report.' : undefined);
    if (route === 'answer') f.ack(q);
    const unrelated = f.store.createTask({ title: 'Synthetic unrelated pending work', provider: 'codex', projectPath: f.home });
    let middleware, scheduler = 0, webhook = 0;
    taskBoardBridge({ store: f.store, onTaskChange: () => {
      webhook++; scheduler++;
      f.store.claimTask(f.worker, { taskId: unrelated.id });
    } }).configureServer({ middlewares: { use(fn) { middleware = fn; } } });
    const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { csrfToken } = await (await fetch(`${base}/api/office/board`)).json();
    const input = f.reply(q, { decision: 'deny', userReply: kind === 'scoped' ? '不批准净化准备方案' : 'No, do not proceed.',
      ...(route === 'respond' ? { source: 'office-ui', userAction: 'deny', userReply: '' } : {}) });
    const current = () => f.store.snapshot().tasks.find(task => task.id === q.taskId);
    const post = () => fetch(route === 'card-actions' ? `${base}/api/office/tasks/card-actions` : `${base}/api/office/human-requests/${q.id}/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': csrfToken },
      body: JSON.stringify(route === 'card-actions' ? { action: 'deny', items: [{ id: q.taskId, version: current().version,
        questionHash: q.questionHash, operationId: input.userMessageId }] } : input) });
    if (route === 'card-actions') {
      // An explicit refusal grants no action, so every category supports the button.
      const result = await (await post()).json();
      assert.equal(result.results[0].ok, true);
      assert.equal(current().status, 'blocked'); assert.equal(current().humanGate.state, 'denied');
      const request = f.store.snapshot().humanRequests.find(request => request.id === q.id);
      assert.equal(request.answer.decision, 'deny'); assert.equal(request.answer.userMessageId, input.userMessageId);
      assert.equal(request.answer.userReply, ''); assert.equal(request.answer.authorization, undefined);
      assert.equal(f.store.claimTask(f.worker, { taskId: q.taskId }), null);
      assert.equal(scheduler, 0); assert.equal(webhook, 0);
      assert.equal(f.store.snapshot().tasks.find(task => task.id === unrelated.id).status, 'pending');
      return;
    }
    const response = await post(); assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.applied, true); assert.equal(result.task.status, 'blocked');
    assert.equal(result.request.state, 'denied'); assert.equal(result.request.answer.decision, 'deny');
    assert.equal(result.request.answer.userReply, input.userReply);
    assert.equal(result.request.questionHash, q.questionHash); assert.equal(result.request.fingerprint, q.fingerprint);
    assert.equal(result.request.answer.userMessageId, input.userMessageId);
    assert.equal(result.request.answer.source, route === 'respond' ? 'office-ui' : 'grok-bot');
    assert.equal(result.request.answer.replyAuthor, 'user');
    assert.equal(result.request.delivery?.messageId ?? null, route === 'answer' ? `synthetic-delivery-${q.id}` : null);
    assert.equal(scheduler, 0); assert.equal(webhook, 0);
    assert.equal(f.store.snapshot().tasks.find(task => task.id === unrelated.id).status, 'pending');
    assert.equal(f.store.claimTask(f.worker, { taskId: q.taskId }), null);
    const beforeReplay = f.raw(), duplicate = await (await post()).json();
    assert.equal(duplicate.applied, false); assert.equal(duplicate.duplicate, true);
    assert.deepEqual(f.raw(), beforeReplay); assert.equal(scheduler, 0); assert.equal(webhook, 0);
  });
});

test('accepted scoped information still notifies once to create the separate preparation question', async t => {
  for (const route of ['answer', 'respond']) await t.test(route, async t => {
    const f = await fixture(t), q = f.block({}, 'HTTP 401 authentication required; please log in.');
    assert.equal(q.kind, 'info'); if (route === 'answer') f.ack(q);
    let middleware, notifications = 0;
    taskBoardBridge({ store: f.store, onTaskChange: () => { notifications++; f.store.syncHumanRequests(); } })
      .configureServer({ middlewares: { use(fn) { middleware = fn; } } });
    const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { csrfToken } = await (await fetch(`${base}/api/office/board`)).json();
    const input = f.reply(q, { decision: 'provide_info', userReply: 'Synthetic test report is available.',
      ...(route === 'respond' ? { source: 'office-ui', userAction: 'provide_info' } : {}) });
    const post = () => fetch(`${base}/api/office/human-requests/${q.id}/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': csrfToken }, body: JSON.stringify(input) });
    const response = await post(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.applied, true);
    assert.equal(result.task.status, 'blocked'); assert.equal(notifications, 1);
    const next = f.store.snapshot().humanRequests.find(request => request.taskId === q.taskId && request.state === 'pending');
    assert.equal(next.kind, 'approval'); assert.equal(next.approvalScope.action, PREPARE_ACTION);
    const beforeReplay = f.raw(), duplicate = await (await post()).json();
    assert.equal(duplicate.duplicate, true); assert.equal(notifications, 1); assert.deepEqual(f.raw(), beforeReplay);
  });
});

test('direct scoped office response requires typed permission and never fabricates relay delivery', async t => {
  const f = await fixture(t), q = f.block();
  const result = f.store.answerHumanRequest(q.id, f.reply(q, { source: 'office-ui', userAction: 'approve', userReply: CN }));
  assert.equal(result.request.answer.delivery, null); assert.equal(result.request.answer.source, 'office-ui');
  assert.deepEqual(result.request.answer.authorization.allowedActions, [PREPARE_ACTION]);
  assert.ok(f.store.claimTask(f.worker, { taskId: q.taskId }));
});

test('editing a granted task never reuses its grant, and changed source cannot replay its message', async t => {
  const f = await fixture(t), q = f.block(); f.ack(q);
  f.store.answerHumanRequest(q.id, f.reply(q));
  f.reject(q, { source: 'office-ui', userAction: 'approve' }, /different question/);
  f.store.updateTask(q.taskId, { title: 'Changed synthetic plan after approval.' });
  assert.equal(f.store.claimTask(f.worker, { taskId: q.taskId }), null);
  const beforeReplay = f.raw();
  assert.equal(f.store.answerHumanRequest(q.id, f.reply(q)).applied, false);
  assert.deepEqual(f.raw(), beforeReplay);
  f.reject(q, { userMessageId: 'synthetic-stale-after-grant' }, /unanswered question/);
  f.store.syncHumanRequests();
  const fresh = f.store.snapshot().humanRequests.find(r => r.state === 'pending');
  assert.notEqual(fresh.id, q.id); assert.equal(fresh.approvalScope.action, PREPARE_ACTION);
  const before = f.raw();
  assert.equal(f.store.claimTask({ ...f.worker, id: 'synthetic-wrong-folder', projectPath: path.dirname(f.home) }, { taskId: fresh.taskId }), null);
  assert.deepEqual(f.raw(), before);
});


test('empty scoped office denial retains hash, message and button protections without granting work', async t => {
  const f = await fixture(t), q = f.block();
  const task = f.store.snapshot().tasks.find(task => task.id === q.taskId), before = f.raw();
  for (const extra of [{ version: task.version - 1 }, { questionHash: 'stale-hash' }]) {
    assert.throws(() => f.store.cardAction(q.taskId, { action: 'deny', version: task.version, questionHash: q.questionHash, operationId: 'invalid-denial', ...extra }));
    assert.deepEqual(f.raw(), before);
  }
  for (const extra of [
    { questionHash: 'stale-hash' }, { userMessageId: undefined },
    { userAction: 'approve', decision: 'deny' }, { userAction: 'deny', decision: 'approve' },
    { source: 'grok-bot', userAction: undefined },
  ]) f.reject(q, { source: 'office-ui', userAction: 'deny', decision: 'deny', userReply: '', ...extra });
  const result = f.store.answerHumanRequest(q.id, f.reply(q, { source: 'office-ui', userAction: 'deny', decision: 'deny', userReply: '' }));
  assert.equal(result.request.state, 'denied'); assert.equal(result.request.answer.authorization, undefined);
  assert.equal(f.store.claimTask(f.worker, { taskId: q.taskId }), null);
});
