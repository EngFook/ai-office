import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, realpath, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskStore, reviewTaskFor } from '../server/task-store.mjs';
import { createTaskRunner, researchPrompt, routeTask, taskPrompt } from '../server/task-runner.mjs';
import { huddleInputHash, huddleQuota } from '../server/huddle-policy.mjs';
import { isReviewLike } from '../server/division-policy.mjs';

const configured = { codex: { enabled: true, concurrency: 2 }, claude: { enabled: true }, gemini: { enabled: true } };
const ready = { codex: { available: true, authenticated: true, path: '/mock/codex' }, claude: { available: true, authenticated: true, path: '/mock/claude' } };

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'portable runner ')));
  const project = path.join(root, "项目 `literal` $(literal) ' one"), second = path.join(root, 'other project');
  await mkdir(project); await mkdir(second);
  const options = { home: path.join(root, 'data'), researchDir: path.join(root, 'notes'), crossReview: false };
  const store = createTaskStore(options), stores = [store], runners = [], calls = [], logs = [];
  t.after(async () => { for (const runner of runners) await runner.stop(); for (const item of stores) item.close(); await rm(root, { recursive: true, force: true }); });
  const worker = (provider, projectPath, id = provider) => ({ id, provider, projectPath });
  const makeRunner = extra => {
    const runner = createTaskRunner({ store, providers: configured, probeProviders: async () => ready,
      pollIntervalMs: 60000, taskTimeoutMs: 60000, onLog: value => logs.push(value),
      spawnProcess(binary, args, options) {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.prompt = '';
        child.stdin = new Writable({ write(chunk, encoding, next) { child.prompt += chunk.toString(); next(); } });
        child.event = value => child.stdout.write(`${JSON.stringify(value)}\n`);
        child.close = (code = 0) => { child.stdout.end(); child.stderr.end(); child.emit('close', code); };
        calls.push({ binary, args, options, child }); return child;
      }, terminate(child) { child.close(143); }, ...extra });
    runners.push(runner); return runner;
  };
  return { root, project, second, options, store, stores, calls, logs, worker, makeRunner };
}

test('configured Codex runs arbitrary plain folders with spaces and Unicode without requiring Git', async t => {
  const f = await fixture(t);
  for (const projectPath of [f.project, f.second]) f.store.createTask({ title: 'Edit the supplied document', provider: 'codex', projectPath });
  const runner = f.makeRunner(); await runner.start();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(new Set(f.calls.map(call => call.options.cwd)), new Set([f.project, f.second]));
  for (const call of f.calls) {
    assert.ok(call.args.includes('--skip-git-repo-check'));
    assert.equal(call.args[call.args.indexOf('-C') + 1], call.options.cwd);
    assert.equal(call.options.shell, false);
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(call.args.some(arg => arg.startsWith('--dangerously-')), false);
    assert.match(call.child.prompt, /plain folder.*without initializing Git/);
  }
  assert.deepEqual(await readdir(f.project), [], 'office never initializes a repository');
  assert.match(reviewTaskFor({ id: 'plain', status: 'done', kind: 'task', projectPath: f.project, assignee: { provider: 'codex' } }).description, /otherwise review the supplied files directly/);
});

for (const parentFirst of [true, false]) test(`atomic project lock excludes overlapping parent/child folders (${parentFirst ? 'parent' : 'child'} first)`, async t => {
  const f = await fixture(t), nested = path.join(f.project, 'package'); await mkdir(nested);
  const first = parentFirst ? f.project : nested, overlap = parentFirst ? nested : f.project;
  const other = createTaskStore(f.options); f.stores.push(other);
  const a = f.store.createTask({ title: 'First worker', provider: 'codex', projectPath: first });
  const b = other.createTask({ title: 'Overlapping worker', provider: 'claude', projectPath: overlap });
  const claim = f.store.claimTask(f.worker('codex', first), { taskId: a.id }); assert.ok(claim);
  assert.equal(other.claimTask(f.worker('claude', overlap), { taskId: b.id }), null);
  const sibling = f.store.createTask({ title: 'Independent folder', provider: 'claude', projectPath: f.second });
  assert.ok(other.claimTask(f.worker('claude', f.second, 'sibling'), { taskId: sibling.id }));
  f.store.finishTask(a.id, claim.claimToken, { status: 'done', result: 'Completed the actual task.' });
  assert.ok(other.claimTask(f.worker('claude', overlap, 'nested'), { taskId: b.id }), 'overlap is released only after completion');
});

test('canonical symlink aliases cannot evade the hierarchical lock and sibling name prefixes do not collide', async t => {
  const f = await fixture(t), nested = path.join(f.project, 'package'), sibling = `${f.project}-other`, alias = path.join(f.root, 'alias');
  await mkdir(nested); await mkdir(sibling); await symlink(nested, alias);
  const rootTask = f.store.createTask({ title: 'Root work', provider: 'codex', projectPath: f.project });
  const nestedTask = f.store.createTask({ title: 'Alias work', provider: 'claude', projectPath: alias });
  const siblingTask = f.store.createTask({ title: 'Sibling worktree', provider: 'claude', projectPath: sibling });
  assert.ok(f.store.claimTask(f.worker('codex', f.project), { taskId: rootTask.id }));
  assert.equal(f.store.claimTask(f.worker('claude', alias), { taskId: nestedTask.id }), null);
  assert.ok(f.store.claimTask(f.worker('claude', sibling), { taskId: siblingTask.id }));
});

test('runner reports overlapping folders as waiting while continuing independent projects', async t => {
  const f = await fixture(t), nested = path.join(f.project, 'package'); await mkdir(nested);
  f.store.createTask({ title: 'First', provider: 'codex', projectPath: f.project, priority: 'high' });
  const held = f.store.createTask({ title: 'Nested', provider: 'claude', projectPath: nested });
  f.store.createTask({ title: 'Independent', provider: 'codex', projectPath: f.second });
  const runner = f.makeRunner(); await runner.start();
  assert.equal(f.calls.length, 2);
  assert.match(runner.status().pending.find(task => task.taskId === held.id).reason, /overlapping/);
});

test('quota observer cannot release another worker live claim or fabricate that its process stopped', async t => {
  const f = await fixture(t), now = Date.now();
  const task = f.store.createTask({ title: 'External owner', provider: 'codex', projectPath: f.project });
  const claim = f.store.claimTask(f.worker('codex', f.project, 'other-process'), { taskId: task.id });
  const quota = { codex: { observedAt: now, windows: [{ name: 'Weekly', usedPercent: 100, remainingPercent: 0, resetsAt: now + 3600000 }] } };
  const runner = f.makeRunner({ quotaReader: () => quota }); await runner.start();
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).status, 'running');
  assert.ok(f.store.heartbeat(task.id, claim.claimToken), 'actual owner retains its claim');
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.some(log => log.type === 'task_blocked'), false);
});

test('quota exhaustion still stops the runner own process and blocks its claim', async t => {
  const f = await fixture(t), now = Date.now(); let quota = null;
  const task = f.store.createTask({ title: 'Owned task', provider: 'codex', projectPath: f.project });
  const runner = f.makeRunner({ quotaReader: () => quota }); await runner.start();
  assert.equal(f.calls.length, 1);
  quota = { codex: { observedAt: now, windows: [{ name: 'Weekly', remainingPercent: 0, resetsAt: now + 3600000 }] } };
  await runner.kick();
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).status, 'blocked');
  assert.equal(runner.status().running.length, 0);
});

for (const failure of ['persistence-failure', 'lost-claim']) test(`unrecordable completion cannot emit a false done event (${failure})`, async t => {
  const f = await fixture(t);
  const task = f.store.createTask({ title: 'Durable completion', provider: 'codex', projectPath: f.project });
  const runner = f.makeRunner(); await runner.start();
  if (failure === 'lost-claim') f.store.stopRunningTask(task.id, 'Existing claim was stopped by its owner.');
  else {
    const finish = f.store.finishTask; let failOnce = true;
    f.store.finishTask = (...args) => { if (failOnce) { failOnce = false; throw new Error('Simulated database commit failure'); } return finish(...args); };
  }
  const child = f.calls[0].child;
  child.event({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'done', summary: 'Completed' }) } });
  child.event({ type: 'turn.completed' }); child.close();
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).status, 'blocked');
  assert.equal(f.logs.some(log => log.type === 'task_done'), false);
  assert.equal(f.logs.filter(log => log.type === 'task_blocked').length, 1);
  assert.equal(runner.status().running.length, 0);
});

test('a user pause during project validation prevents a late task launch', async t => {
  const f = await fixture(t);
  const task = f.store.createTask({ title: 'Pause during validation', provider: 'codex', projectPath: f.project });
  const runner = f.makeRunner({ projectValidator: async projectPath => {
    f.store.updateSettings({ autoPickup: false });
    return { valid: true, projectPath, canonical: projectPath };
  } });
  await runner.start();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).status, 'pending');
});

test('Gemini retains arbitrary source projects without changing its isolated research directory', async t => {
  const f = await fixture(t);
  let card = f.store.createTask({ title: 'Investigate this project', provider: 'gemini', projectPath: f.project });
  assert.equal(card.contextProjectPath, f.project); assert.equal(card.projectPath, f.options.researchDir);
  assert.match(researchPrompt(card, configured), /Read-only source project:/);
  assert.ok(researchPrompt(card, configured).includes(JSON.stringify(f.project)));
  assert.match(researchPrompt(card, configured), /Do not edit this source project/);
  const before = huddleInputHash(card);
  card = f.store.updateTask(card.id, { title: 'Updated question' });
  assert.equal(card.contextProjectPath, f.project);
  card = f.store.updateTask(card.id, { projectPath: f.second });
  assert.equal(card.contextProjectPath, f.second); assert.equal(card.projectPath, f.options.researchDir);
  assert.notEqual(huddleInputHash(card), before);
  assert.deepEqual(await readdir(f.project), []);
  assert.throws(() => f.store.updateTask(card.id, { projectPath: path.join(f.root, 'missing') }), /unavailable/);
});

test('provider changes update Gemini research kind and preserve the selected source project', async t => {
  const f = await fixture(t);
  let card = f.store.createTask({ title: 'Research then implement', provider: 'gemini', projectPath: f.project });
  card = f.store.updateTask(card.id, { provider: 'codex' });
  assert.equal(card.kind, 'task'); assert.equal(card.projectPath, f.project); assert.equal(card.contextProjectPath, undefined);
  assert.deepEqual(routeTask(card, null, configured).eligible, ['codex']);
  card = f.store.updateTask(card.id, { provider: 'gemini' });
  assert.equal(card.kind, 'research'); assert.equal(card.contextProjectPath, f.project); assert.equal(card.projectPath, f.options.researchDir);
});

test('existing research-only tasks do not invent a source project and cannot reassign output notes to a coder', async t => {
  const f = await fixture(t);
  let card = f.store.createTask({ title: 'General research', provider: 'gemini' });
  assert.equal(card.contextProjectPath, undefined);
  card = f.store.updateTask(card.id, { title: 'Renamed research' });
  assert.equal(card.contextProjectPath, undefined);
  card = f.store.updateTask(card.id, { provider: 'codex' });
  assert.equal(card.projectPath, ''); assert.equal(card.kind, 'task');
});

test('a research source removed before pickup is held instead of silently researching the wrong project', async t => {
  const f = await fixture(t);
  const card = f.store.createTask({ title: 'Read this project', provider: 'gemini', projectPath: f.project });
  await rm(f.project, { recursive: true });
  const runner = f.makeRunner({ probeProviders: async () => ({ gemini: { available: true, authenticated: true, path: '/mock/agy', modelIds: ['gemini-4-argon-medium'] } }) });
  await runner.start();
  assert.equal(f.calls.length, 0);
  assert.match(runner.status().pending.find(task => task.taskId === card.id).reason, /Research source project:/);
});

test('story editorial research stays with Gemini while actual independent review remains pinned', () => {
  const editorial = { id: 'story:cycle-example:review', kind: 'research', provider: 'gemini', title: 'Editorial assessment' };
  assert.equal(isReviewLike(editorial), false);
  assert.deepEqual(routeTask(editorial, {}, configured).eligible, ['gemini']);
  assert.deepEqual(routeTask(editorial, {}).eligible, ['gemini']);
  for (const task of [{ ...editorial, kind: 'review' }, { ...editorial, reviewOf: 'author-card' }, { ...editorial, id: 'regular-task:review' }]) {
    assert.equal(isReviewLike(task), true); assert.deepEqual(routeTask(task, {}, configured).eligible, []);
  }
});

test('managed dispatch uses provider quota rather than an unrelated model cap and rejects contradictory data', () => {
  const now = Date.now(), snapshot = windows => ({ claude: { observedAt: now, windows } });
  const overall = { name: 'Weekly · all models', usedPercent: 30, remainingPercent: 70, resetsAt: now + 3600000 };
  const model = { name: 'Weekly · other-model', usedPercent: 100, remainingPercent: 0, resetsAt: now + 3600000 };
  assert.equal(huddleQuota('claude', snapshot([overall, model]), {}, now).allowed, true);
  assert.equal(huddleQuota('claude', snapshot([model]), {}, now).allowed, false);
  assert.equal(huddleQuota('claude', snapshot([{ ...overall, usedPercent: 100, remainingPercent: 0 }, model]), {}, now).allowed, false);
  assert.equal(huddleQuota('claude', snapshot([{ ...overall, usedPercent: 100, remainingPercent: 90 }]), {}, now).allowed, false);
  const usedOnly = { ...overall }; delete usedOnly.remainingPercent;
  assert.equal(huddleQuota('claude', snapshot([usedOnly]), {}, now).remainingPercent, 70);
});
