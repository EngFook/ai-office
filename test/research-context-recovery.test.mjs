import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { humanRequestFingerprint } from '../server/human-relay-policy.mjs';
import { huddleInputHash } from '../server/huddle-policy.mjs';
import { investigationPrompt } from '../server/resolution-policy.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-research-recovery-')));
  const source = path.join(home, 'source'), replacement = path.join(home, 'replacement'), researchDir = path.join(home, 'research');
  await mkdir(source); await mkdir(replacement);
  const store = createTaskStore({ home, researchDir, crossReview: false });
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  function blocked(error = 'Please provide the missing source project folder.') {
    const task = store.createTask({ title: 'Check source project', description: 'Research the selected source without changes.', provider: 'gemini', projectPath: source });
    const claim = store.claimTask({ id: `fixture-${task.id}`, provider: 'gemini', roles: ['any'], projectPath: researchDir }, { taskId: task.id });
    assert.ok(claim);
    return store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
  }
  function question(task) { store.syncHumanRequests(); return store.snapshot().humanRequests.find(item => item.taskId === task.id && item.state === 'pending'); }
  function answer(request, extra = {}) { return { source: 'office-ui', replyAuthor: 'user', questionHash: request.questionHash, userMessageId: `reply-${request.id}`, userAction: 'provide_info', decision: 'provide_info', userReply: `Use the existing source folder ${replacement} for the original read-only research.`, projectPath: replacement, ...extra }; }
  return { home, source, replacement, researchDir, store, blocked, question, answer };
}

test('an information reply repairs the missing research source and retains isolated output', async t => {
  const f = await fixture(t), task = f.blocked();
  await rm(f.source, { recursive: true });
  const request = f.question(task);
  const input = f.answer(request);
  assert.throws(() => f.store.answerHumanRequest(request.id, { ...input, projectPath: undefined }), /folder|path/i);
  assert.throws(() => f.store.answerHumanRequest(request.id, { ...input, userReply: 'Use a different folder.' }), /explicitly present/);
  const result = f.store.answerHumanRequest(request.id, input);
  assert.equal(result.task.status, 'pending');
  assert.equal(result.task.contextProjectPath, f.replacement);
  assert.equal(result.task.projectPath, f.researchDir);
  assert.equal(result.task.humanReply.kind, 'info');
  assert.equal(result.task.humanReply.decision, 'provide_info');
  assert.equal(result.task.humanReply.authorization, undefined);
  assert.equal(result.request.answer.originalContextProjectPath, f.source);
  assert.equal(result.request.answer.resolvedContextProjectPath, f.replacement);
  assert.equal(result.task.huddleRetry.inputHash, huddleInputHash(result.task));
  assert.notEqual(humanRequestFingerprint(result.task), request.fingerprint);
  assert.equal(f.store.answerHumanRequest(request.id, input).duplicate, true);
});

test('a usable research source cannot be switched through an information reply', async t => {
  const f = await fixture(t), task = f.blocked(), request = f.question(task);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.answer(request)), /original folder is unavailable/);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).contextProjectPath, f.source);
});

test('approval cannot relocate the source and restoration needs no replacement path', async t => {
  const f = await fixture(t), task = f.blocked(), request = f.question(task);
  assert.throws(() => f.store.answerHumanRequest(request.id, f.answer(request, { decision: 'approve', userAction: 'approve' })), /distinct/);
  await rm(f.source, { recursive: true });
  const restored = f.answer(request, { userAction: 'restored', userReply: 'The original source folder is restored.' });
  delete restored.projectPath;
  assert.throws(() => f.store.answerHumanRequest(request.id, restored), /still unavailable/);
  await mkdir(f.source);
  const result = f.store.answerHumanRequest(request.id, restored);
  assert.equal(result.task.contextProjectPath, f.source);
  assert.equal(result.task.projectPath, f.researchDir);
});

test('a question for an earlier source cannot approve or resume an edited research card', async t => {
  const f = await fixture(t), task = f.blocked('Approval required: read the selected private source.'), request = f.question(task);
  assert.equal(request.kind, 'approval');
  f.store.updateTask(task.id, { projectPath: f.replacement });
  const reply = f.answer(request, { userAction: 'approve', decision: 'approve', userReply: 'Yes, approve the specific request.' });
  delete reply.projectPath;
  assert.throws(() => f.store.answerHumanRequest(request.id, reply), /task changed|binding|current/);
});

test('research blocker investigation receives the actual source while preserving read-only scope', async t => {
  const f = await fixture(t), task = f.blocked('Tool output failed to decode.');
  f.store.updateSettings({ autoPickup: true });
  const result = f.store.investigateBlockedTask(task.id, { version: task.version, provider: 'codex', reason: 'Inspect the failed source lookup.' });
  const evidence = JSON.parse(result.task.description);
  assert.equal(evidence.contextProjectPath, f.source);
  assert.equal(evidence.contextAccess, 'read-only');
  assert.equal(evidence.researchOutputPath, f.researchDir);
  assert.equal(result.task.projectPath, f.source);
  assert.equal(result.task.kind, 'resolution');
  assert.match(investigationPrompt(result.task), /READ-ONLY investigation/);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).projectPath, f.researchDir);
});

test('unavailable research sources stay explicit in isolated blocker investigations', async t => {
  const f = await fixture(t), task = f.blocked('Tool output failed to decode.');
  await rm(f.source, { recursive: true });
  f.store.updateSettings({ autoPickup: true });
  const result = f.store.investigateBlockedTask(task.id, { version: task.version, provider: 'codex', reason: 'Check the missing source without rewriting it.' });
  assert.equal(JSON.parse(result.task.description).contextProjectPath, f.source);
  assert.equal(result.task.projectPath, path.join(f.home, 'unblock-investigations'));
  assert.notEqual(result.task.projectPath, f.researchDir);
});

test('renewing a legacy diagnosis restores its missing source evidence and read-only directory', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = await fixture(t), original = f.blocked('Tool output failed to decode.');
  f.store.updateSettings({ autoPickup: true });
  const child = f.store.investigateBlockedTask(original.id, { version: original.version, provider: 'codex', reason: 'Inspect failed lookup.' }).task;
  const legacy = { ...child, status: 'blocked', projectPath: f.researchDir, result: 'An earlier diagnosis used the output directory.' };
  delete legacy.investigationPolicy;
  const db = new DatabaseSync(f.store.dbPath);
  try { db.prepare('UPDATE tasks SET record=?,status=? WHERE id=?').run(JSON.stringify(legacy), 'blocked', legacy.id); } finally { db.close(); }
  const parent = f.store.snapshot().tasks.find(item => item.id === original.id);
  const renewed = f.store.investigateBlockedTask(parent.id, { version: parent.version, provider: 'codex', reason: 'Reassess against actual source.' }).task;
  assert.equal(renewed.id, child.id);
  assert.equal(renewed.projectPath, f.source);
  assert.equal(JSON.parse(renewed.description).contextProjectPath, f.source);
  assert.equal(JSON.parse(renewed.description).contextAccess, 'read-only');
});
