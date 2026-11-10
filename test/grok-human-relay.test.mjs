import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { humanRequestSpec, humanRequestHold } from '../server/human-relay-policy.mjs';
import { runOfficeBoardCommand } from '../scripts/office-board.mjs';

async function fixture(t, extra = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-human-relay-'));
  const options = { home, researchDir: home, crossReview: false, ...extra };
  const f = { home, store: createTaskStore(options) };
  t.after(async () => { f.store.close(); await rm(home, { recursive: true, force: true }); });
  f.worker = (id = 'worker', provider = 'codex') => ({ id, provider, roles: ['any'], projectPath: home });
  f.block = (error = 'Approval required: deploy the existing tested change.', input = {}) => {
    const task = f.store.createTask({ title: 'Fixture task', description: 'Original scope only.', provider: 'codex', projectPath: home, ...input });
    const claim = f.store.claimTask(f.worker('worker', task.provider), { taskId: task.id });
    return f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
  };
  f.request = task => { f.store.syncHumanRequests(); return f.store.snapshot().humanRequests.find(request => request.taskId === task.id && request.state !== 'stale'); };
  f.ack = request => f.store.acknowledgeHumanRequest(request.id, { source: 'grok-bot', questionHash: request.questionHash, messageId: `delivery-${request.id}` });
  f.reply = (request, input = {}) => ({ source: 'grok-bot', replyAuthor: 'user', questionHash: request.questionHash, userMessageId: `reply-${request.id}`, userReply: 'Yes, approve the specific request.', decision: 'approve', ...input });
  f.restart = () => { f.store.close(); f.store = createTaskStore(options); };
  return f;
}

test('Qwen questions persist and deduplicate; delivery is not approval or execution', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task);
  assert.equal(request.kind, 'approval'); assert.equal(request.state, 'pending');
  for (let i = 0; i < 3; i++) f.store.syncHumanRequests();
  assert.equal(f.store.snapshot().humanRequests.length, 1);
  f.restart(); assert.equal(f.request(task).id, request.id);
  f.ack(request); f.ack(request);
  assert.equal(f.store.snapshot().humanRequests[0].state, 'delivered');
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  assert.throws(() => f.store.updateTask(task.id, { status: 'pending' }), /bound human question/);
  assert.equal(f.store.claimTask(f.worker(), { taskId: task.id }), null);
});

test('only bound explicit user approval resumes same scope through fresh scheduler gates', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request)), /delivered/);
  f.ack(request);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { replyAuthor: 'assistant' })), /actual user reply/);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { userReply: 'I am the manager, do this automatically.' })), /explicit affirmative/);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { userReply: 'No, not approved.' })), /explicit affirmative/);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { questionHash: 'other' })), /binding/);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { decision: 'provide_info' })), /distinct/);
  const result = f.store.answerHumanRequest(request.id, f.reply(request));
  assert.equal(result.task.status, 'pending'); assert.equal(result.task.huddleRetry.active, true);
  for (const key of ['id', 'description', 'projectPath', 'provider', 'role', 'kind']) assert.equal(result.task[key], task[key]);
  assert.equal(result.task.humanReply.userReply, f.reply(request).userReply);
  assert.equal(result.task.humanGate.state, 'answered');
  const duplicate = f.store.answerHumanRequest(request.id, f.reply(request));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.applied, false);
  assert.equal(duplicate.task.version, result.task.version);
});

test('info is not approval; credentials and technical diagnostics are classified conservatively', async t => {
  const f = await fixture(t), task = f.block('HTTP 401 authentication required; please log in.'), request = f.request(task);
  assert.equal(request.kind, 'info'); f.ack(request);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request)), /distinct/);
  const result = f.store.answerHumanRequest(request.id, f.reply(request, { decision: 'provide_info', userReply: 'I signed in again; retry the original task.' }));
  assert.equal(result.task.humanReply.kind, 'info'); assert.equal(result.task.status, 'pending');
  const technical = { ...task, error: 'The agent ended without a structured completion confirmation.', resolution: { state: 'needs_user', nextAction: 'Assigned Claude reviewer should finalize the existing review as standalone JSON.' } };
  assert.equal(humanRequestSpec(technical), null);
  assert.equal(humanRequestSpec({ ...technical, resolution: { state: 'needs_user', nextAction: '请提供可访问的项目资料，当前缺少原始文档。' } }).kind, 'info');
  assert.equal(humanRequestSpec({ ...task, kind: 'resolution' }), null);
});

test('denial stays blocked without repeated questions or model-created investigation bypass', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task); f.ack(request);
  const result = f.store.answerHumanRequest(request.id, f.reply(request, { decision: 'deny', userReply: 'No, do not deploy.' }));
  assert.equal(result.request.state, 'denied'); assert.equal(result.task.status, 'blocked');
  for (let i = 0; i < 3; i++) f.store.syncHumanRequests();
  assert.equal(f.store.snapshot().humanRequests.length, 1); assert.ok(humanRequestHold(result.task));
  assert.throws(() => f.store.investigateBlockedTask(task.id, { version: result.task.version, provider: 'codex', reason: 'try again' }), /拒绝/);
  assert.throws(() => f.store.retryBlockedTask(task.id, { version: result.task.version, provider: 'codex', reason: 'try again' }), /拒绝/);
});

test('metadata changes preserve question; manual scope edits stale old replies and require new binding', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task); f.ack(request);
  const latest = f.store.snapshot().tasks[0];
  f.store.recordResolution(task.id, { version: latest.version, owner: 'local-qwen', state: 'needs_user', nextAction: 'Await user decision', nextCheckAt: new Date().toISOString() });
  f.store.syncHumanRequests(); assert.equal(f.store.snapshot().humanRequests[0].state, 'delivered');
  f.store.updateTask(task.id, { description: 'Changed scope with a different deployment.' });
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request)), /unanswered question/);
  const all = f.store.snapshot().humanRequests;
  assert.equal(all.find(value => value.id === request.id).state, 'stale');
  assert.equal(all.filter(value => value.state === 'pending').length, 1);
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
});

test('finished tasks reject late replies; answered user messages cannot be replayed to another task', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task); f.ack(request);
  f.store.updateTask(task.id, { status: 'done' });
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request)), /unanswered question/);
  assert.equal(f.store.snapshot().tasks.find(t => t.id === task.id).status, 'done');
  const a = f.block(), qa = f.request(a); f.ack(qa); f.store.answerHumanRequest(qa.id, f.reply(qa, { decision: 'deny', userReply: 'No.', userMessageId: 'shared-user-message' }));
  const b = f.block(), qb = f.request(b); f.ack(qb);
  assert.throws(() => f.store.answerHumanRequest(qb.id, f.reply(qb, { userMessageId: 'shared-user-message' })), /different question/);
});

test('multiple read-only Gemini researchers claim independently while coding project remains exclusive', async t => {
  const f = await fixture(t);
  const research = [1, 2].map(index => f.store.createTask({ title: `Research ${index}`, provider: 'gemini', projectPath: f.home }));
  const claims = research.map((task, index) => f.store.claimTask(f.worker(`research-${index}`, 'gemini'), { taskId: task.id }));
  assert.ok(claims.every(Boolean));
  const coding = [1, 2].map(index => f.store.createTask({ title: `Code ${index}`, provider: 'codex', projectPath: f.home }));
  assert.ok(f.store.claimTask(f.worker('coding-1'), { taskId: coding[0].id }));
  assert.equal(f.store.claimTask(f.worker('coding-2'), { taskId: coding[1].id }), null);
});

test('Grok relay CLI exposes only pending/delivered questions and posts exact bound input', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/board') ? { csrfToken: 'fixture', humanRequests: [{ id: 'one', state: 'pending' }, { id: 'two', state: 'denied' }, { id: 'three', state: 'delivered' }] } : { applied: true } }; };
  const pending = await runOfficeBoardCommand({ args: ['pending-questions'], fetchImpl });
  assert.deepEqual(pending.humanRequests.map(item => item.id), ['one', 'three']);
  const input = { source: 'grok-bot', questionHash: 'hash', replyAuthor: 'user', userMessageId: 'msg', userReply: 'Yes', decision: 'approve' };
  await runOfficeBoardCommand({ args: ['answer-question', 'human:one'], fetchImpl, readInput: async () => input });
  assert.match(calls.at(-1).url, /human-requests\/human%3Aone\/answer$/);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), input);
  assert.equal(calls.at(-1).options.headers['X-Office-Token'], 'fixture');
});

test('real relay API requires CSRF and same-origin; CLI roundtrip answers only delivered question', async t => {
  const { createServer } = await import('node:http');
  const { taskBoardBridge } = await import('../server/task-board-bridge.mjs');
  const f = await fixture(t), task = f.block(), request = f.request(task);
  let middleware, kicked = 0;
  taskBoardBridge({ store: f.store, onTaskChange: () => kicked++ }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const server = createServer((req, res) => { middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/api/office/human-requests/${request.id}/answer`;
  const missing = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.reply(request)) });
  assert.equal(missing.status, 403);
  const cross = await fetch(`${base}/api/office/human-requests`, { headers: { Origin: 'https://outside.invalid' } });
  assert.equal(cross.status, 403);
  const run = (args, input) => runOfficeBoardCommand({ args, environment: { AI_OFFICE_URL: base }, readInput: async () => input });
  assert.equal((await run(['pending-questions'])).humanRequests[0].id, request.id);
  await run(['acknowledge-question', request.id], { source: 'grok-bot', questionHash: request.questionHash, messageId: 'grok-delivery-1' });
  assert.equal(kicked, 0);
  const result = await run(['answer-question', request.id], f.reply(request));
  assert.equal(result.task.status, 'pending'); assert.equal(kicked, 1);
  assert.deepEqual((await run(['pending-questions'])).humanRequests, []);
});

test('editing diagnosed info request never leaves an orphaned stale gate', async t => {
  const f = await fixture(t), task = f.block('The agent ended without a structured completion confirmation.');
  f.store.recordResolution(task.id, { version: task.version, owner: 'codex', state: 'needs_user', nextAction: '请提供缺少的设计文档。', nextCheckAt: new Date().toISOString() });
  const request = f.request(task); f.ack(request);
  f.store.updateTask(task.id, { description: 'Updated original scope and context.' });
  f.store.syncHumanRequests();
  const pending = f.store.snapshot().humanRequests.filter(item => item.state === 'pending');
  assert.equal(pending.length, 1); assert.notEqual(pending[0].id, request.id);
  assert.equal(f.store.snapshot().tasks[0].humanGate.requestId, pending[0].id);
  assert.equal(pending[0].kind, 'info');
});

test('missing project info requires an existing literal user-supplied path, with provenance and scope preserved', async t => {
  const f = await fixture(t), task = f.block('Please provide the missing project folder.');
  f.store.updateTask(task.id, { projectPath: path.join(f.home, 'no-longer-available') });
  const request = f.request(task); f.ack(request);
  const reply = f.reply(request, { decision: 'provide_info', userReply: `The existing project folder is ${f.home}; continue only the original task.` });
  assert.throws(() => f.store.answerHumanRequest(request.id, reply), /project folder is still unavailable/);
  assert.throws(() => f.store.answerHumanRequest(request.id, { ...reply, projectPath: path.join(f.home, 'not-mentioned') }), /explicitly present/);
  assert.throws(() => f.store.answerHumanRequest(request.id, { ...reply, projectPath: path.join(f.home, 'absent'), userReply: `Use ${path.join(f.home, 'absent')}` }), /unavailable/);
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  assert.equal(f.store.snapshot().humanRequests[0].state, 'delivered');
  const answered = f.store.answerHumanRequest(request.id, { ...reply, projectPath: f.home });
  assert.equal(answered.task.status, 'pending');
  assert.equal(answered.task.projectPath, await realpath(f.home));
  assert.equal(answered.task.description, task.description);
  assert.equal(answered.request.answer.originalProjectPath, path.join(f.home, 'no-longer-available'));
  assert.equal(answered.request.answer.resolvedProjectPath, await realpath(f.home));
  assert.equal(answered.task.humanReply.providedProjectPath, f.home);
  assert.ok(f.store.claimTask(f.worker(), { taskId: task.id }));
});

test('info cannot change a usable project, approval cannot change paths, and restored folders need no replacement', async t => {
  const f = await fixture(t), task = f.block('HTTP 401 authentication required.'), request = f.request(task); f.ack(request);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { decision: 'provide_info', userReply: `Use ${f.home}`, projectPath: f.home })), /original folder is unavailable/);
  const approved = f.block(), approval = f.request(approved); f.ack(approval);
  assert.throws(() => f.store.answerHumanRequest(approval.id, f.reply(approval, { userReply: `Yes, use ${f.home}`, projectPath: f.home })), /information replies/);
  const missing = f.block('Please provide the missing project folder.');
  const restored = path.join(f.home, 'restored');
  f.store.updateTask(missing.id, { projectPath: restored }); const info = f.request(missing); f.ack(info);
  const { mkdir } = await import('node:fs/promises'); await mkdir(restored);
  const answered = f.store.answerHumanRequest(info.id, f.reply(info, { decision: 'provide_info', userReply: 'The original project folder is restored now.' }));
  assert.equal(answered.task.projectPath, await realpath(restored)); assert.equal(answered.task.status, 'pending');
});

test('questions are not explicit approvals and conditional approvals retain exact constraints', async t => {
  const f = await fixture(t), task = f.block(), request = f.request(task); f.ack(request);
  for (const userReply of ['可以吗？', '确认一下是否安全', 'Yes?', '同意吗', '可以不要部署吗？']) {
    assert.throws(() => f.store.answerHumanRequest(request.id, f.reply(request, { userReply })), /explicit affirmative/);
  }
  const answer = f.store.answerHumanRequest(request.id, f.reply(request, { userReply: '同意，仅测试环境。' }));
  assert.equal(answer.task.humanReply.userReply, '同意，仅测试环境。');
});

test('validated text-only local Qwen accepts info without a folder and keeps single-worker serialization', async t => {
  const f = await fixture(t);
  const task = f.block('Please provide the missing source log context.', { title: 'Log triage', provider: 'local-qwen', supportType: 'log-triage', projectPath: '', description: 'Original log: fixture timeout.' });
  const request = f.request(task); f.ack(request);
  const result = f.store.answerHumanRequest(request.id, f.reply(request, { decision: 'provide_info', userReply: 'The timeout happened during fixture startup.' }));
  assert.equal(result.task.projectPath, ''); assert.equal(result.task.status, 'pending');
  const worker = { id: 'qwen-text-only', provider: 'local-qwen', roles: ['Helper'] };
  const claim = f.store.claimTask(worker, { taskId: task.id });
  assert.ok(claim); assert.equal(claim.task.projectPath, '');
  const second = f.store.createTask({ title: 'Other log triage', provider: 'local-qwen', supportType: 'log-triage', description: 'Second log text.' });
  assert.equal(f.store.claimTask({ ...worker, id: 'qwen-other' }, { taskId: second.id }), null);
});

test('Grok verified information resumes original scope without fabricating a human reply', async t => {
  const f = await fixture(t), task = f.block('Please provide the missing test report.'), q = f.request(task);
  const input = { source: 'grok-bot', questionHash: q.questionHash, outcome: 'resolved_info', summary: 'Located the existing report; rerun its failed check.', evidence: 'Read project/reports/check.md and verified the referenced commit.' };
  assert.throws(() => f.store.triageHumanRequest(q.id, { ...input, questionHash: 'stale' }), /binding/);
  assert.throws(() => f.store.triageHumanRequest(q.id, { ...input, userReply: 'approved' }), /not a user answer/);
  assert.throws(() => f.store.triageHumanRequest(q.id, { ...input, projectPath: '/tmp' }), /not a user answer/);
  assert.throws(() => f.store.triageHumanRequest(q.id, { ...input, evidence: '' }), /required/);
  f.store.updateSettings({ autoPickup: false });
  const result = f.store.triageHumanRequest(q.id, input);
  assert.equal(result.request.state, 'resolved'); assert.equal(result.request.answer, null);
  assert.equal(result.task.status, 'pending'); assert.equal(result.task.humanReply, undefined);
  assert.equal(result.task.grokTriage.evidence, input.evidence); assert.equal(humanRequestHold(result.task), null);
  assert.equal(f.store.snapshot().settings.autoPickup, false, 'triage never enables pickup');
  for (const key of ['id', 'description', 'projectPath', 'provider', 'kind', 'role']) assert.equal(result.task[key], task[key]);
  f.restart(); f.store.syncHumanRequests(); assert.equal(f.store.snapshot().humanRequests[0].state, 'resolved');
  assert.throws(() => f.store.triageHumanRequest(q.id, input), /no longer current/);
});

test('Grok triage cannot approve, override denial, stale scope, or missing original project', async t => {
  const f = await fixture(t), task = f.block(), q = f.request(task);
  const input = { source: 'grok-bot', questionHash: q.questionHash, outcome: 'resolved_info', summary: 'Prepared the decision.', evidence: 'Checked the existing scope.' };
  assert.throws(() => f.store.triageHumanRequest(q.id, input), /cannot resolve an approval/);
  const reviewed = f.store.triageHumanRequest(q.id, { ...input, outcome: 'needs_user' });
  assert.equal(reviewed.task.status, 'blocked'); assert.equal(reviewed.request.state, 'pending');
  assert.equal(reviewed.request.delivery, null, 'triage is not delivery');
  f.ack(q); f.store.answerHumanRequest(q.id, f.reply(q, { decision: 'deny', userReply: 'No.' }));
  assert.throws(() => f.store.triageHumanRequest(q.id, input), /no longer current/);
  const info = f.block('Please provide the missing report.');
  f.store.updateTask(info.id, { projectPath: path.join(f.home, 'missing') }); const iq = f.request(info);
  assert.throws(() => f.store.triageHumanRequest(iq.id, { ...input, questionHash: iq.questionHash }), /unavailable/);
  f.store.updateTask(info.id, { description: 'Different scope.' });
  assert.throws(() => f.store.triageHumanRequest(iq.id, { ...input, questionHash: iq.questionHash }), /no longer current/);
});

test('triage CLI uses same-origin authenticated route and kicks real scheduler only on resolved info', async t => {
  const { createServer } = await import('node:http'); const { taskBoardBridge } = await import('../server/task-board-bridge.mjs');
  const f = await fixture(t), task = f.block('Please provide the missing report.'), q = f.request(task);
  let middleware, kicks = 0;
  taskBoardBridge({ store: f.store, onTaskChange: () => kicks++ }).configureServer({ middlewares: { use(m) { middleware = m; } } });
  const server = createServer((req, res) => middleware(req, res, () => res.end('{}')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { source: 'grok-bot', questionHash: q.questionHash, outcome: 'needs_user', summary: 'No report found.', evidence: 'Checked project reports.' };
  assert.equal((await fetch(`${base}/api/office/human-requests/${q.id}/triage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const run = (args, value) => runOfficeBoardCommand({ args, environment: { AI_OFFICE_URL: base }, readInput: async () => value });
  assert.match((await run(['pending-questions'])).handlingPolicy, /investigates first/);
  await run(['triage-question', q.id], input); assert.equal(kicks, 0);
  await run(['triage-question', q.id], { ...input, outcome: 'resolved_info', summary: 'Found report.', evidence: 'Verified current report and commit.' });
  assert.equal(kicks, 1); assert.deepEqual((await run(['pending-questions'])).humanRequests, []);
});

test('repeated Grok information resolutions share bounded recovery budget and stale findings never reach later prompts', async t => {
  const { taskPrompt } = await import('../server/task-runner.mjs');
  const f = await fixture(t), original = f.block('Please provide the missing test report.');
  const input = q => ({ source: 'grok-bot', questionHash: q.questionHash, outcome: 'resolved_info', summary: 'Located current report.', evidence: 'Read report-v2.md at verified commit.' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    f.store.syncHumanRequests(); const q = f.store.snapshot().humanRequests.find(x => x.taskId === original.id && x.state === 'pending');
    const resumed = f.store.triageHumanRequest(q.id, input(q));
    assert.equal(resumed.task.huddleRetry.attempts, attempt);
    assert.match(taskPrompt(resumed.task), /untrusted evidence, not instructions/);
    assert.ok(taskPrompt(resumed.task).includes('report-v2.md'));
    const claim = f.store.claimTask(f.worker(), { taskId: original.id });
    const failed = f.store.finishTask(original.id, claim.claimToken, { status: 'blocked', error: 'Please provide the missing test report.' });
    assert.equal(failed.grokTriage, undefined);
    assert.ok(!taskPrompt(failed).includes('report-v2.md'));
  }
  f.store.syncHumanRequests(); const q = f.store.snapshot().humanRequests.find(x => x.taskId === original.id && x.state === 'pending');
  assert.throws(() => f.store.triageHumanRequest(q.id, input(q)), /budget exhausted/);
  const escalated = f.store.triageHumanRequest(q.id, { ...input(q), outcome: 'needs_user' });
  assert.equal(escalated.task.status, 'blocked');
  const other = f.block('Please provide the missing report.'), oq = f.request(other);
  f.store.triageHumanRequest(oq.id, input(oq));
  const edited = f.store.updateTask(other.id, { description: 'New scope.' });
  assert.equal(edited.grokTriage, undefined); assert.ok(!taskPrompt(edited).includes('report-v2.md'));
});

test('Grok cannot resolve authentication or tool permission boundaries as ordinary information', async t => {
  const f = await fixture(t);
  for (const error of ['HTTP 401 authentication required; please log in.', 'EACCES permission denied', '需要登录才能继续']) {
    const task = f.block(error), q = f.request(task);
    assert.equal(q.kind, 'info');
    assert.throws(() => f.store.triageHumanRequest(q.id, { source: 'grok-bot', questionHash: q.questionHash, outcome: 'resolved_info', summary: 'Try again.', evidence: 'Read the error.' }), /require the actual user/);
  }
});

test('office user can answer a visible pending question without fabricating Grok delivery', async t => {
  const f = await fixture(t), task = f.block(), q = f.request(task);
  const input = { ...f.reply(q), source: 'office-ui', userAction: 'approve', userMessageId: 'office-ui:approve' };
  const answered = f.store.answerHumanRequest(q.id, input);
  assert.equal(answered.task.status, 'pending'); assert.equal(answered.request.answer.source, 'office-ui');
  assert.equal(answered.request.delivery, null); assert.equal(answered.task.humanReply.userMessageId, input.userMessageId);
  assert.equal(f.store.answerHumanRequest(q.id, input).duplicate, true);
  const info = f.block('Please provide the missing test report.'), iq = f.request(info);
  assert.throws(() => f.store.answerHumanRequest(iq.id, { ...input, questionHash: iq.questionHash, userMessageId: 'other' }), /distinct/);
  const denied = f.store.answerHumanRequest(iq.id, { ...input, questionHash: iq.questionHash, userMessageId: 'office-ui:deny', userAction: 'deny', decision: 'deny', userReply: '暂不继续' });
  assert.equal(denied.task.status, 'blocked'); assert.equal(denied.request.state, 'denied');
});

test('explicit re-request reopens only the question, rotates binding, preserves denial history and throttles repeats', async t => {
  const f = await fixture(t), task = f.block(), q = f.request(task);
  f.store.answerHumanRequest(q.id, { ...f.reply(q), source: 'office-ui', userMessageId: 'office-ui:denial', userAction: 'deny', decision: 'deny', userReply: 'No.' });
  const input = { source: 'office-ui', questionHash: q.questionHash, operationId: 'office-ui:rerequest' };
  const result = f.store.rerequestHumanRequest(q.id, input);
  assert.equal(result.task.status, 'blocked'); assert.equal(result.request.state, 'pending');
  assert.equal(result.request.rerequestCount, 1); assert.notEqual(result.request.questionHash, q.questionHash);
  assert.equal(result.request.history[0].questionHash, q.questionHash); assert.equal(result.request.history[0].answer.decision, 'deny'); assert.equal(result.request.answer, null);
  assert.equal(result.request.delivery, null); assert.ok(humanRequestHold(result.task));
  assert.equal(f.store.rerequestHumanRequest(q.id, input).applied, false, 'same operation is idempotent');
  assert.throws(() => f.store.answerHumanRequest(q.id, { ...f.reply(q), source: 'office-ui' }), /binding/);
  assert.throws(() => f.store.rerequestHumanRequest(q.id, { ...input, questionHash: result.request.questionHash, operationId: 'new-operation' }), /one minute/);
  f.restart(); f.store.syncHumanRequests();
  assert.equal(f.store.snapshot().humanRequests[0].questionHash, result.request.questionHash);
  f.store.updateTask(task.id, { title: '[Paused] Wait for user' });
  assert.throws(() => f.store.rerequestHumanRequest(q.id, { ...input, operationId: 'paused' }), /binding|no longer current/);
});

test('direct office response and re-request routes require CSRF and wake only the corresponding work', async t => {
  const { createServer } = await import('node:http'); const { taskBoardBridge } = await import('../server/task-board-bridge.mjs');
  const f = await fixture(t), task = f.block(), q = f.request(task); let middleware, wakes = 0;
  taskBoardBridge({ store: f.store, onTaskChange: () => wakes++ }).configureServer({ middlewares: { use(m) { middleware = m; } } });
  const server = createServer((req, res) => middleware(req, res, () => res.end('{}')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const board = await (await fetch(base + '/api/office/board')).json();
  const post = (route, body, token = board.csrfToken) => fetch(`${base}/api/office/human-requests/${q.id}/${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) });
  const reask = { questionHash: q.questionHash, operationId: 'office-ui:roundtrip' };
  assert.equal((await post('rerequest', reask, 'invalid')).status, 403);
  const rerequest = await (await post('rerequest', reask)).json();
  assert.equal(rerequest.task.status, 'blocked'); assert.equal(wakes, 1);
  const reply = { questionHash: rerequest.request.questionHash, userMessageId: 'office-ui:roundtrip-answer', userAction: 'approve', decision: 'approve', userReply: '同意，仅批准当前事项。' };
  assert.equal((await post('respond', reply, 'invalid')).status, 403);
  assert.equal((await post('answer', { ...reply, source: 'office-ui', replyAuthor: 'user' })).status, 400);
  const answer = await (await post('respond', reply)).json();
  assert.equal(answer.task.status, 'pending'); assert.equal(answer.request.answer.source, 'office-ui'); assert.equal(wakes, 2);
});

test('re-request never lets Grok undo a previous information refusal, and repeated user nudges are bounded', async t => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock });
  const task = f.block('Please provide the missing report.'); let q = f.request(task);
  f.store.answerHumanRequest(q.id, { ...f.reply(q), source: 'office-ui', userAction: 'deny', decision: 'deny', userReply: '', userMessageId: 'office-ui:info-denied' });
  for (let i = 1; i <= 5; i++) {
    q = f.store.rerequestHumanRequest(q.id, { source: 'office-ui', questionHash: q.questionHash, operationId: `office-ui:nudge-${i}` }).request;
    assert.equal(q.requiresUserAction, true); assert.equal(q.rerequestCount, i);
    assert.throws(() => f.store.triageHumanRequest(q.id, { source: 'grok-bot', questionHash: q.questionHash, outcome: 'resolved_info', summary: 'Found it.', evidence: 'Read it.' }), /require the actual user/);
    clock += 61000;
  }
  assert.throws(() => f.store.rerequestHumanRequest(q.id, { source: 'office-ui', questionHash: q.questionHash, operationId: 'office-ui:nudge-6' }), /five re-requests/);
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  const answered = f.store.answerHumanRequest(q.id, { source: 'office-ui', replyAuthor: 'user', userAction: 'provide_info', decision: 'provide_info', questionHash: q.questionHash, userReply: 'Use the existing report. Continue this original task.', userMessageId: 'office-ui:changed-decision' });
  assert.equal(answered.task.status, 'pending', 'only a new user decision lifts the previous refusal');
});

test('office button action is distinct from typed conditions and Grok still needs literal explicit approval', async t => {
  const { taskPrompt } = await import('../server/task-runner.mjs');
  const f = await fixture(t), task = f.block(), q = f.request(task);
  const condition = '仅测试环境，不要推 main，不要部署生产。';
  const result = f.store.answerHumanRequest(q.id, { source: 'office-ui', replyAuthor: 'user', userAction: 'approve', decision: 'approve', userReply: condition, questionHash: q.questionHash, userMessageId: 'office-ui:conditional-approval' });
  assert.equal(result.request.answer.userReply, condition); assert.equal(result.request.answer.userAction, 'approve');
  assert.ok(taskPrompt(result.task).includes('userTypedText')); assert.ok(taskPrompt(result.task).includes(condition));
  assert.ok(!taskPrompt(result.task).includes('verbatimReply'));
  const another = f.block(), aq = f.request(another); f.ack(aq);
  assert.throws(() => f.store.answerHumanRequest(aq.id, f.reply(aq, { userReply: condition })), /explicit affirmative/);
});
