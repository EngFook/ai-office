import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskStore } from '../server/task-store.mjs';
import { createTaskRunner, maxConcurrentFor, taskPrompt } from '../server/task-runner.mjs';
import { codexSubagentArgs } from '../server/parallel-policy.mjs';

async function fixture(t, runnerOptions = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-parallel-')));
  const project = path.join(home, 'project'), researchDir = path.join(home, 'research');
  await mkdir(project);
  const store = createTaskStore({ home, researchDir });
  const calls = [];
  const runner = createTaskRunner({ store, pollIntervalMs: 100000,
    probeProviders: async () => Object.fromEntries(['claude', 'codex', 'gemini'].map(key => [key, { available: true, authenticated: true, path: `/mock/${key}` }])),
    spawnProcess: (binary, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.pid = 999999; child.exitCode = null; child.signalCode = null;
      child.close = (code = 0) => { child.exitCode = code; child.stdout.end(); child.emit('close', code); };
      calls.push({ binary, args, options, child }); return child;
    }, terminate: child => child.close(143), ...runnerOptions,
  });
  t.after(async () => { await runner.stop(); store.close(); await rm(home, { recursive: true, force: true }); });
  return { store, runner, calls, home, project, researchDir };
}

test('two Gemini research workers share notes folder while third queues and coding lock remains exclusive', async t => {
  const { store, runner, calls, project, researchDir } = await fixture(t);
  for (let i = 0; i < 3; i++) store.createTask({ title: `Research question ${i}`, provider: 'gemini' });
  store.createTask({ title: 'Build feature', provider: 'claude', projectPath: project });
  store.createTask({ title: 'Another feature', provider: 'codex', projectPath: project });
  await runner.start();
  const gemini = calls.filter(call => call.binary === '/mock/gemini');
  assert.equal(gemini.length, 2);
  assert.equal(runner.status().active.research, 2);
  assert.equal(runner.status().active.coding, 1, 'coding project remains locked');
  assert.equal(store.snapshot().tasks.filter(task => task.provider === 'gemini' && task.status === 'pending').length, 1);
  for (const [index, run] of gemini.entries()) {
    assert.equal(run.options.cwd, researchDir);
    assert.equal(run.args[run.args.indexOf('--mode') + 1], 'plan');
    run.child.stdout.write(JSON.stringify({ conversation_id: `research-${index}`, status: 'SUCCESS', response: `Independent note ${index}` }) + '\n');
    run.child.close();
  }
  for (let i = 0; i < 50 && store.snapshot().tasks.filter(task => task.provider === 'gemini' && task.status === 'done').length < 2; i++) await delay(10);
  const files = await readdir(researchDir);
  assert.equal(files.length, 2, 'concurrent research writes distinct notes');
  const notes = await Promise.all(files.map(file => readFile(path.join(researchDir, file), 'utf8')));
  assert.ok(notes.some(note => note.includes('Independent note 0')));
  assert.ok(notes.some(note => note.includes('Independent note 1')));
  await runner.kick();
  assert.equal(calls.filter(call => call.binary === '/mock/gemini').length, 3, 'queued research fills released capacity');
});

test('Codex launch enables bounded native delegation and metadata separates native from external capabilities', async t => {
  const { store, runner, calls, project } = await fixture(t);
  store.createTask({ title: 'Implement feature', provider: 'codex', projectPath: project });
  await runner.start();
  assert.ok(calls[0].args.includes('agents.enabled=true'));
  assert.ok(calls[0].args.includes('agents.max_concurrent_threads_per_session=2'));
  assert.deepEqual(codexSubagentArgs({ kind: 'resolution' }), ['-c', 'agents.enabled=false']);
  const capabilities = runner.status().parallelCapabilities;
  assert.equal(capabilities.codex.taskSlots, 2);
  assert.equal(capabilities.codex.nativeLimit, 2);
  assert.equal(capabilities.claude.taskSlots, 3);
  assert.equal(capabilities.gemini.taskSlots, 2);
  assert.equal(capabilities.gemini.nativeSubagents, 'unverified');
  assert.equal(capabilities['grok-bot'].taskSlots, null);
  assert.equal(capabilities['local-qwen'].taskSlots, 1);
  assert.equal(maxConcurrentFor('local-qwen', { 'local-qwen': 8 }), 1);
  const prompt = taskPrompt({ id: 'parent-1', provider: 'codex', title: 'Feature' });
  assert.match(prompt, /Task ID: parent-1/);
  assert.match(prompt, /at most two native sub-agents/);
  assert.match(prompt, /wait for delegated results/);
});


function answerInfoRequest(store, project, provider = 'any', title = 'Implement specified asset') {
  const task = store.createTask({ title, provider, projectPath: project });
  const claimed = store.claimTask({ id: `initial-${task.id}`, provider: 'codex', roles: ['any'], projectPath: project }, { taskId: task.id });
  store.finishTask(task.id, claimed.claimToken, { status: 'blocked', error: 'Need your information: supply the target asset.' });
  store.syncHumanRequests();
  const request = store.snapshot().humanRequests.find(item => item.taskId === task.id);
  store.acknowledgeHumanRequest(request.id, { source: 'grok-bot', questionHash: request.questionHash, messageId: `delivery-${task.id}` });
  store.answerHumanRequest(request.id, { source: 'grok-bot', replyAuthor: 'user', questionHash: request.questionHash,
    userMessageId: `reply-${task.id}`, userReply: 'Use the existing blue chair asset.', decision: 'provide_info' });
  return task;
}
const freshQuota = (codex = 70, claude = 70, observedAt = Date.now()) => Object.fromEntries([['codex', codex], ['claude', claude]].map(([key, left]) => [key, { observedAt, windows: [{ name: 'weekly', remainingPercent: left }] }]));

test('a bound user reply on an any-provider task waits for fresh quota then uses the available suitable coder', async t => {
  let quota = freshQuota(0, 70, Date.now() - 31 * 60000);
  const { store, runner, calls, project } = await fixture(t, { quotaReader: () => quota });
  const task = answerInfoRequest(store, project);
  await runner.start();
  assert.equal(calls.length, 0, 'stale quota cannot launch answered work');
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).status, 'pending');
  quota = freshQuota(0, 70);
  await runner.kick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/mock/claude', 'Codex exhaustion selects eligible Claude');
  const resumed = store.snapshot().tasks.find(item => item.id === task.id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.provider, 'any', 'the human-bound task is not edited to reroute it');
  assert.equal(resumed.humanGate.state, 'answered');
});

test('human-replied concrete assignments remain pinned when their own quota is exhausted', async t => {
  const { store, runner, calls, project } = await fixture(t, { quotaReader: () => freshQuota(0, 70) });
  const task = answerInfoRequest(store, project, 'codex');
  await runner.start();
  assert.equal(calls.length, 0, 'concrete Codex task cannot reroute to Claude after approval');
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).status, 'pending');
});

test('any-provider balance task resumes through Codex without staling its bound human reply', async t => {
  const { store, runner, calls, project } = await fixture(t, { quotaReader: () => freshQuota() });
  const task = answerInfoRequest(store, project, 'any', 'Game balance proposal');
  await runner.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/mock/codex');
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).humanGate.state, 'answered');
});

test('answered any-provider work rechecks quota after asynchronous project validation', async t => {
  let quota = freshQuota();
  const { store, runner, calls, project } = await fixture(t, { quotaReader: () => quota,
    projectValidator: async projectPath => { await delay(1); quota = freshQuota(0, 0); return { valid: true, canonical: projectPath, projectPath }; },
  });
  const task = answerInfoRequest(store, project);
  await runner.start();
  assert.equal(calls.length, 0, 'exhaustion during validation prevents launch');
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).status, 'pending');
});


test('parallel Gemini notes use the full management task identity rather than a shared ID prefix', async t => {
  const { store, runner, calls, project, researchDir } = await fixture(t);
  const instruction = store.createInstruction({ text: 'Research two independent topics.', projectPath: project });
  const plan = store.applyManagementPlan(instruction.id, { summary: 'Parallel research.', tasks: [
    { provider: 'gemini', title: '调研界面设计', description: 'Find interface references.' },
    { provider: 'gemini', title: '调研渲染方案', description: 'Find rendering references.' },
  ] });
  assert.equal(plan.tasks[0].id.slice(0, 8), plan.tasks[1].id.slice(0, 8));
  await runner.start();
  assert.equal(calls.length, 2);
  for (const [i, run] of calls.entries()) {
    run.child.stdout.write(JSON.stringify({ conversation_id: `managed-research-${i}`, status: 'SUCCESS', response: `Management note ${i}` }) + '\n');
    run.child.close();
  }
  for (let i = 0; i < 50 && store.snapshot().tasks.some(task => task.status !== 'done'); i++) await delay(10);
  const files = await readdir(researchDir);
  assert.equal(files.length, 2, 'different full IDs produce distinct files even when both title slugs are research');
  const notes = await Promise.all(files.map(file => readFile(path.join(researchDir, file), 'utf8')));
  assert.ok(notes.some(note => note.includes('Management note 0')));
  assert.ok(notes.some(note => note.includes('Management note 1')));
});
