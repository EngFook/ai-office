import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createQwenHuddle, huddleCandidates } from '../server/qwen-huddle.mjs';
import { huddleQuota, huddleRetryHold } from '../server/huddle-policy.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';

const AT = Date.parse('2026-11-04T08:00:00Z');
const quotas = (now = AT, left = 80) => Object.fromEntries(['codex', 'claude', 'gemini'].map(p => [p, { observedAt: now, windows: [{ name: 'Weekly', remainingPercent: left, resetsAt: now + 86400000 }, { name: 'Session', remainingPercent: left, resetsAt: now + 3600000 }] }]));
const runtime = () => ({ running: [], providers: Object.fromEntries(['codex', 'claude', 'gemini', 'local-qwen'].map(p => [p, { available: true, authenticated: true }])) });
const worker = (dir, provider = 'codex') => ({ id: `fixture-${provider}`, provider, roles: ['Helper', 'Tester', 'Facilitator'], projectPath: dir });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-huddle-'));
  const ref = { clock: AT, dir };
  ref.store = createTaskStore({ home: dir, crossReview: false, now: () => ref.clock });
  t.after(async () => { ref.store.close(); await rm(dir, { recursive: true, force: true }); });
  ref.block = (error = 'HTTP 429 rate limited', input = {}) => {
    const task = ref.store.createTask({ title: 'Small fixture fix', description: 'Fix the fixture only.', projectPath: dir, provider: 'codex', ...input });
    const claim = ref.store.claimTask(worker(dir, task.provider === 'any' ? 'codex' : task.provider), { taskId: task.id });
    return ref.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
  };
  return ref;
}
async function runHuddle(t, f, extra = {}) {
  const huddle = createQwenHuddle({ store: f.store, runtimeReader: runtime, quotaReader: () => quotas(f.clock), now: () => f.clock,
    qwenClient: { discussBlocked: async () => ({ summary: '本轮核对了分工与额度。', suggestions: [] }) }, ...extra });
  huddle.start(); t.after(() => huddle.stop());
  const result = await huddle.tick(); await huddle.stop(); return result;
}

test('chair retries same transient-blocked card, preserves role/source and records durable evidence', async t => {
  const f = await fixture(t), blocked = f.block(); let kicked = 0;
  const state = await runHuddle(t, f, { onDispatch: async () => { kicked++; } });
  const tasks = f.store.snapshot().tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, blocked.id); assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[0].kind, 'task'); assert.equal(tasks[0].source, 'user'); assert.equal(tasks[0].huddleRetry.attempts, 1);
  assert.equal(tasks[0].huddleRetry.previousError, 'HTTP 429 rate limited');
  assert.equal(state.decisions[0].action, 'dispatch'); assert.equal(state.decisions[0].remainingPercent, 80); assert.equal(kicked, 1);
  assert.equal(f.store.readHuddle().lastCheckedAt, new Date(AT).toISOString());
});

test('hard or ambiguous blockers get an accountable read-only investigator without restarting original work', async t => {
  const f = await fixture(t);
  const errors = ['HTTP 403 quota access denied', 'HTTP 429; waiting for approval', 'quota exceeded; dependency unfinished', 'missing branch; not a quota error', 'Worker lease expired', 'The office runner stopped; retry explicitly', 'Agent ended without a successful completion', 'quota', 'manual action required after 503'];
  for (const error of errors) assert.ok(huddleRetryHold(f.block(error)), error);
  const state = await runHuddle(t, f);
  assert.ok(state.decisions.some(item => item.action === 'investigate'));
  assert.ok(f.store.snapshot().tasks.filter(task => task.kind !== 'resolution').every(task => task.status === 'blocked' && task.resolution?.owner));
  assert.equal(f.store.snapshot().tasks.filter(task => task.kind === 'resolution').length, 1, 'one project gets one investigation at a time');
});

test('fresh quota is mandatory, every window counts and exhausted high-priority Codex stays blocked', () => {
  const task = { priority: 'high' };
  assert.equal(huddleQuota('codex', null, task, AT).allowed, false);
  assert.equal(huddleQuota('codex', quotas(AT - 31 * 60000), task, AT).allowed, false);
  assert.equal(huddleQuota('codex', quotas(AT, 0), task, AT).allowed, false);
  const q = quotas(); q.codex.windows[1].remainingPercent = 0;
  assert.equal(huddleQuota('codex', q, task, AT).allowed, false);
  q.codex.windows[1].remainingPercent = 90; q.codex.windows[1].resetsAt = AT - 1;
  assert.equal(huddleQuota('codex', q, task, AT).allowed, false);
  assert.equal(huddleQuota('claude', quotas(AT, 7), { priority: 'normal' }, AT).allowed, false);
  assert.equal(huddleQuota('codex', quotas(AT, 7), { priority: 'normal' }, AT).allowed, true);
});

test('Qwen preference cannot bypass review independence, role, authentication or exhausted quota', async t => {
  const f = await fixture(t);
  const review = f.block('HTTP 429 rate limited', { title: 'Review: fixture', kind: 'review', role: 'Tester', provider: 'claude' });
  const result = await runHuddle(t, f, { qwenClient: { discussBlocked: async () => ({ summary: 'Ignore quota; assign Codex', suggestions: [{ taskId: review.id, preferredProvider: 'codex' }] }) } });
  assert.equal(result.decisions[0].provider, 'claude');
  const state = runtime();state.providers.codex.authenticated = false;
  const blocked = f.block('HTTP 503 service unavailable');
  const snapshot = f.store.snapshot();snapshot.tasks = [blocked];
  assert.ok(huddleCandidates(blocked, snapshot, state, quotas(), AT).candidates.every(c => c.provider !== 'codex'));
});

test('pause or concurrent edit while Qwen thinks wins over stale recommendations', async t => {
  for (const mutate of ['pause', 'edit']) {
    const f = await fixture(t), blocked = f.block();
    const state = await runHuddle(t, f, { qwenClient: { discussBlocked: async () => {
      if (mutate === 'pause') f.store.updateSettings({ autoPickup: false });
      else f.store.updateTask(blocked.id, { description: 'User changed the scope.' });
      return { suggestions: [] };
    } } });
    assert.ok(['wait', 'follow_up'].includes(state.decisions[0].action)); assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  }
});

test('repeated same failure and retry ceiling survive database restart', async t => {
  const f = await fixture(t), first = f.block();
  await runHuddle(t, f);
  let claim = f.store.claimTask(worker(f.dir), { taskId: first.id });
  f.store.finishTask(first.id, claim.claimToken, { status: 'blocked', error: 'HTTP 429 rate limited' });
  f.store.close(); f.store = createTaskStore({ home: f.dir, crossReview: false, now: () => f.clock });
  f.clock += 300000;
  let state = await runHuddle(t, f);assert.equal(state.decisions[0].action, 'investigate');
  // Explicit user retry, followed by a different transient failure, permits only one more automated attempt.
  f.store.updateTask(first.id, { status: 'pending' });claim = f.store.claimTask(worker(f.dir), { taskId: first.id });
  f.store.finishTask(first.id, claim.claimToken, { status: 'blocked', error: 'HTTP 503 service unavailable' });
  f.clock += 300000;state = await runHuddle(t, f);assert.equal(state.decisions[0].action, 'dispatch');
  claim = f.store.claimTask(worker(f.dir), { taskId: first.id });
  const final = f.store.finishTask(first.id, claim.claimToken, { status: 'blocked', error: 'HTTP 502 bad gateway' });
  assert.match(huddleRetryHold(final), /两次/);
});

test('empty board avoids model calls; busy/offline Qwen reports factual fallback without fake discussion', async t => {
  const f = await fixture(t);let calls = 0;
  let state = await runHuddle(t, f, { qwenClient: { discussBlocked: async () => { calls++; throw new Error('busy'); } } });
  assert.equal(calls, 0);assert.equal(state.meeting.active, false);
  f.block(); f.clock += 300000;
  state = await runHuddle(t, f, { qwenClient: { discussBlocked: async () => { calls++; throw new Error('busy'); } } });
  assert.equal(calls, 1);assert.equal(state.phase, 'unavailable');assert.ok(state.discussion.every(item => item.source === 'structured-facts'));
});

test('local chair uses real Ollama response, rejects injected provider and shares single local slot', async t => {
  const f = await fixture(t);let body, release;
  const client = createLocalQwen({ usageFile: path.join(f.dir, 'usage.json'), fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ summary: '核对额度。', suggestions: [{ taskId: 'known', preferredProvider: 'grok', reason: 'suggestion' }, { taskId: 'injected', preferredProvider: 'codex' }] }) } }));
  } });
  const pending = client.discussBlocked({ tasks: [{ taskId: 'known', candidates: [{ provider: 'codex' }] }] });
  await assert.rejects(client.discussBlocked({ tasks: [] }), /concurrency/);release();
  const advice = await pending;
  assert.equal(body.tools, undefined);assert.equal(body.model, 'qwen3:8b');assert.equal(body.keep_alive, '2m');
  assert.equal(advice.suggestions.length, 1);assert.equal(advice.suggestions[0].preferredProvider, null);
});

test('session quota exhaustion can move ordinary Claude work to Codex, but balance/review lanes stay pinned', async t => {
  const f = await fixture(t), task = f.block('HTTP 429 rate limited', { provider: 'claude' });
  const q = quotas();q.claude.windows[1].remainingPercent = 0;
  const candidates = huddleCandidates(task, f.store.snapshot(), runtime(), q, AT).candidates;
  assert.deepEqual(candidates.map(c => c.provider), ['codex']);
  const balance = { ...task, title: 'Game balance tuning', provider: 'codex' };
  q.codex.windows[0].remainingPercent = 0;
  assert.deepEqual(huddleCandidates(balance, { ...f.store.snapshot(), tasks: [balance] }, runtime(), q, AT).candidates, []);
});

test('runner rechecks quota at claim time and manual reassignment releases only automatic pin', async t => {
  const { createTaskRunner } = await import('../server/task-runner.mjs');
  const f = await fixture(t), task = f.block();await runHuddle(t, f);
  let spawned = 0;
  const runner = createTaskRunner({ store: f.store, now: () => f.clock, quotaReader: () => null,
    pollIntervalMs: 100000, probeProviders: async () => ({ codex: { available: true, authenticated: true, path: '/fixture/codex' } }),
    spawnProcess: () => { spawned++;throw new Error('fixture only'); } });
  t.after(() => runner.stop());await runner.start();
  assert.equal(spawned, 0);assert.equal(f.store.snapshot().tasks[0].status, 'pending');
  const edited = f.store.updateTask(task.id, { provider: 'any' });
  assert.equal(edited.huddleRetry.active, false);assert.equal(edited.huddleRetry.attempts, 1);
  await runner.kick();assert.equal(spawned, 1);await runner.stop();
});

test('huddle dispatch preserves automatic independent review generation', async t => {
  const f = await fixture(t);f.store.close();f.store = createTaskStore({ home: f.dir, now: () => f.clock });
  const blocked = f.block();await runHuddle(t, f);
  const claim = f.store.claimTask(worker(f.dir), { taskId: blocked.id });
  f.store.finishTask(blocked.id, claim.claimToken, { status: 'done', result: 'Fixture completed and checked.' });
  const review = f.store.snapshot().tasks.find(task => task.reviewOf === blocked.id);
  assert.equal(review.kind, 'review');assert.equal(review.provider, 'claude');
});

test('background cadence runs without board requests and stops without dispatching late model output', async t => {
  const f = await fixture(t);f.block('Permission required');let count = 0, reached;
  const second = new Promise(resolve => { reached = resolve; });
  const h = createQwenHuddle({ store: f.store, intervalMs: 25, now: Date.now, runtimeReader: () => { if (++count === 8) reached(); return runtime(); }, quotaReader: () => quotas(Date.now()),
    qwenClient: { discussBlocked: async () => ({ suggestions: [] }) } });
  h.start();t.after(() => h.stop());
  await Promise.race([second, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('timer never ran')), 500);timer.unref(); })]);
  await h.stop();const stoppedAt = count;await new Promise(resolve => setTimeout(resolve, 40));assert.equal(count, stoppedAt);
  const blocked = f.store.snapshot().tasks.find(task => task.kind !== 'resolution');assert.equal(blocked.status, 'blocked');assert.ok(blocked.resolution?.owner);
});

test('quota loss during asynchronous project validation prevents automatic retry launch', async t => {
  const { createTaskRunner } = await import('../server/task-runner.mjs');
  const f = await fixture(t);f.block();await runHuddle(t, f);
  let q = quotas(), spawned = 0;
  const runner = createTaskRunner({ store: f.store, now: () => f.clock, quotaReader: () => q, pollIntervalMs: 100000,
    probeProviders: async () => ({ codex: { available: true, authenticated: true, path: '/fixture/codex' } }),
    projectValidator: async projectPath => { q = quotas(AT, 0);return { valid: true, canonical: projectPath, projectPath }; },
    spawnProcess: () => { spawned++;throw new Error('must not execute'); } });
  t.after(() => runner.stop());await runner.start();
  assert.equal(spawned, 0);assert.equal(f.store.snapshot().tasks[0].status, 'pending');await runner.stop();
});

test('known stopped/format failures resume original scope with prior evidence and keep cross-review lane', async t => {
  const { taskPrompt } = await import('../server/task-runner.mjs');
  const f = await fixture(t);
  const task = f.block('The office runner stopped. This task will not restart automatically; retry it explicitly if needed.');
  const state = await runHuddle(t, f);
  assert.equal(state.decisions[0].action, 'dispatch');
  const queued = f.store.snapshot().tasks.find(item => item.id === task.id);
  assert.equal(queued.status, 'pending');assert.equal(queued.resolution.owner, 'codex');
  assert.match(taskPrompt(queued), /inspect the previous attempt/);assert.match(taskPrompt(queued), /Preserve completed work/);
});

test('explicit user permission creates one relay request, holds original work and does not spawn investigators', async t => {
  const f = await fixture(t), original = f.block('Permission required to deploy.');
  await runHuddle(t, f); f.clock += 300000; await runHuddle(t, f);
  let board = f.store.snapshot();
  assert.equal(board.tasks.filter(item => item.resolutionOf === original.id).length, 0);
  assert.equal(board.humanRequests.length, 1);
  const request = board.humanRequests[0];
  assert.equal(request.kind, 'approval'); assert.equal(request.state, 'pending');
  assert.equal(board.tasks[0].status, 'blocked'); assert.equal(board.tasks[0].resolution.owner, 'local-qwen');
  f.store.acknowledgeHumanRequest(request.id, { source: 'grok-bot', messageId: 'grok-question-fixture', questionHash: request.questionHash });
  f.store.answerHumanRequest(request.id, { source: 'grok-bot', replyAuthor: 'user', userMessageId: 'user-denial-fixture', userReply: '不同意', decision: 'deny', questionHash: request.questionHash });
  f.clock += 300000; const state = await runHuddle(t, f);
  board = f.store.snapshot();
  assert.equal(board.humanRequests.length, 1); assert.equal(board.humanRequests[0].state, 'denied');
  assert.equal(board.tasks[0].status, 'blocked'); assert.equal(board.tasks[0].resolution.state, 'user_denied');
  assert.match(state.decisions[0].reason, /不重复催问/);
});

test('a bound user reply reaches the execution prompt with its exact conditions', async t => {
  const { taskPrompt } = await import('../server/task-runner.mjs');
  const f = await fixture(t), original = f.block('Permission required to prepare a sanitized snapshot.');
  f.store.updateTask(original.id, { approvalAction: 'prepare_sanitized_snapshot' });
  await runHuddle(t, f);
  const request = f.store.snapshot().humanRequests[0];
  f.store.acknowledgeHumanRequest(request.id, { source: 'grok-bot', messageId: 'grok-question-fixture', questionHash: request.questionHash });
  const reply = '同意净化准备方案，保留旧本地历史和未提交改动，不批准最终合并。';
  const result = f.store.answerHumanRequest(request.id, { source: 'grok-bot', replyAuthor: 'user', userMessageId: 'user-approval-fixture', userReply: reply, decision: 'approve', questionHash: request.questionHash });
  assert.equal(result.task.id, original.id); assert.equal(result.task.status, 'pending');
  assert.deepEqual(result.task.humanReply.authorization.allowedActions, ['prepare_sanitized_snapshot']);
  assert.deepEqual(result.task.humanReply.authorization.deniedActions, ['merge']);
  const prompt = taskPrompt(result.task);
  assert.ok(prompt.includes(reply)); assert.ok(prompt.includes(request.question.replaceAll('\n', '\\n')));
  assert.match(prompt, /including every condition or limit/); assert.match(prompt, /Information is not additional authorization/);
});

test('verified technical diagnosis returns original card to its owner rather than marking it complete', async t => {
  const f = await fixture(t), original = f.block('The agent reported a blocker. See its result for details.');
  await runHuddle(t, f);
  const child = f.store.snapshot().tasks.find(item => item.resolutionOf === original.id);
  const claimed = f.store.claimTask(worker(f.dir, child.provider), { taskId: child.id });
  f.store.finishTask(child.id, claimed.claimToken, { status: 'done', result: 'Relevant files show the technical dependency is now present.', unblock: { action: 'resume', nextAction: 'Inspect existing changes and rerun the original checks.' } });
  assert.equal(f.store.snapshot().tasks.find(item => item.id === original.id).status, 'blocked');
  f.clock += 300000;const state = await runHuddle(t, f);
  assert.equal(state.decisions[0].action, 'dispatch');
  const parent = f.store.snapshot().tasks.find(item => item.id === original.id);
  assert.equal(parent.status, 'pending');assert.equal(parent.kind, 'task');assert.equal(parent.id, original.id);
});

test('a user edit invalidates investigation output and cancels stale queued investigation', async t => {
  const f = await fixture(t), original = f.block('Missing input.');await runHuddle(t, f);
  const child = f.store.snapshot().tasks.find(item => item.resolutionOf === original.id);
  f.store.updateTask(original.id, { description: 'New scope selected by the user.' });
  assert.equal(f.store.claimTask(worker(f.dir, child.provider), { taskId: child.id }), null);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === child.id).paused, true);
  f.clock += 300000;await runHuddle(t, f);
  const next = f.store.snapshot().tasks.find(item => item.resolutionOf === original.id && item.id !== child.id);
  assert.ok(next, 'new scope may have its own investigation');
  const claim = f.store.claimTask(worker(f.dir, next.provider), { taskId: next.id });
  f.store.updateTask(original.id, { description: 'User changed scope again.' });
  f.store.finishTask(next.id, claim.claimToken, { status: 'done', result: 'Stale finding', unblock: { action: 'resume', nextAction: 'Stale proposal' } });
  assert.notEqual(f.store.snapshot().tasks.find(item => item.id === original.id).resolution?.finding, 'Stale finding');
});

test('paused, superseded and configured paused cards are excluded; unrelated references do not pause work', async t => {
  const { resolutionPaused } = await import('../server/resolution-policy.mjs');
  const f = await fixture(t), original = f.block('HTTP 429 rate limited');
  const paused = f.store.updateTask(original.id, { title: '[Superseded] Old feature' });
  assert.equal(f.store.claimTask(worker(f.dir), { taskId: paused.id }), null);
  const { configureWatchHolds } = await import('../server/watch-task-policy.mjs');
  configureWatchHolds(['fixture-held']); t.after(() => configureWatchHolds([]));
  assert.equal(resolutionPaused({id:'fixture-held'}),true);
  assert.equal(resolutionPaused({id:'different',title:'Fix office scheduling',description:'Do not touch fixture-held or other parked cards.'}),false);
  let calls=0;await runHuddle(t,f,{qwenClient:{discussBlocked:async()=>{calls++;return {suggestions:[]}}}});
  assert.equal(calls,0);const parent=f.store.snapshot().tasks.find(item=>item.id===paused.id);
  assert.equal(parent.status,'blocked');assert.equal(parent.resolution.state,'paused');assert.equal(parent.version,paused.version);
});

test('read-only investigations retain real quota checks and sandboxed provider arguments', async t => {
  const { createTaskRunner } = await import('../server/task-runner.mjs');
  const { EventEmitter } = await import('node:events');const { PassThrough } = await import('node:stream');
  for(const provider of ['codex','claude']) {
    const f=await fixture(t), original=f.block('Missing context.');
    const child=f.store.investigateBlockedTask(original.id,{version:original.version,provider,reason:'Investigate only.'}).task;
    let launchedArgs,prompt='';let childProcess;
    const runner=createTaskRunner({store:f.store,now:()=>f.clock,quotaReader:()=>quotas(f.clock),pollIntervalMs:100000,
      probeProviders:async()=>({[provider]:{available:true,authenticated:true,path:`/fixture/${provider}`}}),
      spawnProcess:(_bin,args)=>{launchedArgs=args;childProcess=new EventEmitter();childProcess.stdout=new PassThrough();childProcess.stderr=new PassThrough();childProcess.stdin=new PassThrough();childProcess.stdin.on('data',v=>{prompt+=v});return childProcess;},
      terminate:(child)=>child.emit('close',143)});
    t.after(()=>runner.stop());await runner.start();assert.ok(launchedArgs);
    assert.ok(!launchedArgs.some(arg=>arg.includes('dangerously')));
    if(provider==='codex'){assert.ok(launchedArgs.includes('read-only'));assert.ok(launchedArgs.includes('--skip-git-repo-check'));}
    else {assert.ok(launchedArgs.includes('Read,Glob,Grep'));assert.ok(launchedArgs.includes('plan'));}
    assert.match(prompt,/READ-ONLY investigation/);
    assert.equal(f.store.snapshot().tasks.find(item=>item.id===child.id).status,'running');
    await runner.stop();
  }
});

test('missing project is assigned an investigator in a bounded fallback folder', async t => {
  const f=await fixture(t), task=f.block('Missing folder.');
  const edited=f.store.updateTask(task.id,{projectPath:path.join(f.dir,'does-not-exist')});
  await runHuddle(t,f);
  const child=f.store.snapshot().tasks.find(item=>item.resolutionOf===task.id);
  assert.ok(child.projectPath.endsWith(path.basename(f.dir)+'/unblock-investigations'));
  assert.equal(child.kind,'resolution');assert.ok(child.description.includes(edited.projectPath));
});

test('two independent Gemini recovery tasks can share the read-only research folder', async t => {
  const f = await fixture(t);
  const task = { id: 'research-b', provider: 'gemini', kind: 'research', role: 'Helper', priority: 'normal', projectPath: f.dir, status: 'blocked', error: 'HTTP 503 service unavailable' };
  const first = { ...task, id: 'research-a', status: 'pending' };
  const board = { settings: { autoPickup: true }, tasks: [task, first] };
  const candidates = huddleCandidates(task, board, runtime(), quotas(), AT).candidates;
  assert.deepEqual(candidates.map(item => item.provider), ['gemini']);
  board.tasks.push({ ...first, id: 'research-c' });
  assert.equal(huddleCandidates(task, board, runtime(), quotas(), AT).candidates.length, 0);
});

test('repair diagnosis preserves changed approach through dispatch, including incidental approval caveats', async t => {
  const f = await fixture(t), original = f.block('The agent reported a blocker. See its result for details.');
  await runHuddle(t, f); const child = f.store.snapshot().tasks.find(x => x.resolutionOf === original.id);
  const claim = f.store.claimTask(worker(f.dir, child.provider), { taskId: child.id });
  const plan = 'Use the current parser input, fix the completion extraction, and rerun the malformed-output regression.';
  f.store.finishTask(child.id, claim.claimToken, { status: 'done', result: 'Diagnosis complete; this does not approve deployment.', unblock: { action: 'repair', nextAction: plan } });
  f.clock += 300000; await runHuddle(t, f);
  const current = f.store.snapshot().tasks.find(x => x.id === original.id);
  assert.equal(current.status, 'pending'); assert.equal(current.huddleRetry.recoveryPlan, plan);
  const { taskPrompt } = await import('../server/task-runner.mjs'); assert.ok(taskPrompt(current).includes(plan));
  assert.match(taskPrompt(current), /change the approach/);
});

test('legacy stopped diagnosis receives one reassessment, not endless duplicate cards', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = await fixture(t), original = f.block('The agent reported a blocker. See its result for details.');
  await runHuddle(t, f); let child = f.store.snapshot().tasks.find(x => x.resolutionOf === original.id);
  let claim = f.store.claimTask(worker(f.dir, child.provider), { taskId: child.id });
  f.store.finishTask(child.id, claim.claimToken, { status: 'blocked', result: 'Read-only diagnosis found an executable code fix.', unblock: { action: 'needs_user', nextAction: 'Fix the existing parser and test it.' } });
  child = f.store.snapshot().tasks.find(x => x.id === child.id); delete child.investigationPolicy;
  const db = new DatabaseSync(f.store.dbPath); db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(child), child.id); db.close();
  f.clock += 300000; await runHuddle(t, f);
  let current = f.store.snapshot().tasks.find(x => x.id === child.id);
  assert.equal(current.status, 'pending'); assert.equal(current.investigationPolicy, 2);
  claim = f.store.claimTask(worker(f.dir, current.provider), { taskId: current.id });
  f.store.finishTask(current.id, claim.claimToken, { status: 'blocked', result: 'Still unable to inspect the environment.' });
  f.clock += 300000; await runHuddle(t, f);
  current = f.store.snapshot().tasks.find(x => x.id === child.id);
  assert.equal(current.status, 'blocked'); assert.equal(f.store.snapshot().tasks.filter(x => x.kind === 'resolution').length, 1);
});

test('same failure can retry a newly verified repair plan but never exceed its automatic budget', async t => {
  const f = await fixture(t), original = f.block('HTTP 503 service unavailable');
  await runHuddle(t, f);
  let claim = f.store.claimTask(worker(f.dir), { taskId: original.id });
  f.store.finishTask(original.id, claim.claimToken, { status: 'blocked', error: 'HTTP 503 service unavailable' });
  f.clock += 300000; await runHuddle(t, f);
  const child = f.store.snapshot().tasks.find(x => x.resolutionOf === original.id);
  claim = f.store.claimTask(worker(f.dir, child.provider), { taskId: child.id });
  f.store.finishTask(child.id, claim.claimToken, { status: 'done', result: 'Found incorrect upstream port.', unblock: { action: 'repair', nextAction: 'Correct the upstream port in original configuration, then rerun connectivity test.' } });
  f.clock += 300000; await runHuddle(t, f);
  const current = f.store.snapshot().tasks.find(x => x.id === original.id);
  assert.equal(current.status, 'pending'); assert.equal(current.huddleRetry.attempts, 2);
  claim = f.store.claimTask(worker(f.dir, current.provider), { taskId: original.id });
  const final = f.store.finishTask(original.id, claim.claimToken, { status: 'blocked', error: 'HTTP 503 service unavailable' });
  assert.match(huddleRetryHold(final), /两次/);
});

test('a stopped runner cannot receive new huddle assignments, even with authenticated providers', async t => {
  const f = await fixture(t), task = f.block(); let dispatches = 0;
  const result = await runHuddle(t, f, { runtimeReader: () => ({ ...runtime(), started: false }), onDispatch: async () => { dispatches++; } });
  assert.equal(dispatches, 0);
  assert.equal(f.store.snapshot().tasks.length, 1);
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  assert.match(result.decisions.find(item => item.taskId === task.id).reason, /执行器已停止/);
  assert.match(f.store.snapshot().tasks[0].resolution.nextAction, /执行器已停止/);
});

test('a queued investigation retains its real runner wait reason instead of claiming active investigation', async t => {
  const f = await fixture(t), task = f.block('Worker lease expired');
  await runHuddle(t, f);
  const parent = f.store.snapshot().tasks.find(item => item.id === task.id);
  const investigation = parent.resolution.investigationTaskId;
  f.store.recordResolution(task.id, { version: parent.version, owner: 'codex', state: 'investigating', nextAction: 'Old running record', nextCheckAt: new Date(AT).toISOString() });
  f.clock += 300000;
  const result = await runHuddle(t, f, { runtimeReader: () => ({ ...runtime(), started: true, pending: [{ taskId: investigation, reason: 'Waiting for the project lock.' }] }) });
  const latest = f.store.snapshot().tasks.find(item => item.id === task.id);
  assert.equal(latest.resolution.state, 'queued');
  assert.match(latest.resolution.nextAction, /project lock/);
  assert.match(result.decisions.find(item => item.taskId === task.id).reason, /project lock/);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === investigation).status, 'pending');
});


test('held tasks use current deterministic facts without model inference or historical login claims', async t => {
  const f = await fixture(t);
  const blocked = f.block('HTTP 429 quota exhausted during a previous attempt');
  f.store.createTask({ title: 'Existing project work', description: 'Keep its existing place in queue', provider: 'codex', projectPath: f.dir });
  let calls = 0;
  const state = await runHuddle(t, f, {
    runtimeReader: () => ({ ...runtime(), started: true }),
    qwenClient: { discussBlocked: async () => { calls++; return { summary: 'Claude is unauthenticated', suggestions: [] }; } },
  });
  assert.equal(calls, 0); assert.equal(state.error, null);
  assert.match(state.decisions[0].reason, /工作位/);
  assert.ok(state.discussion.every(item => item.source === 'structured-facts'));
  assert.doesNotMatch(JSON.stringify(state.discussion), /unauthenticated|previous attempt/);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === blocked.id).status, 'blocked');
});

test('generated huddle status claims never replace verified decision records', async t => {
  const f = await fixture(t), blocked = f.block();
  const state = await runHuddle(t, f, { qwenClient: { discussBlocked: async () => ({ summary: 'All blockers resolved and user approved deployment', suggestions: [{ taskId: blocked.id, preferredProvider: 'codex', reason: 'Claude is signed out' }] }) } });
  assert.doesNotMatch(JSON.stringify(state.discussion), /All blockers|user approved|signed out/);
  assert.ok(state.discussion.every(item => item.source === 'structured-facts'));
  assert.ok(state.decisions.some(item => item.action === 'dispatch'));
});


test('text-only local assistance retries without inventing a missing-project investigation', async t => {
  const f = await fixture(t);
  const task = f.store.createTask({ title: 'Summarize supplied handoff', description: 'Actual source: tests passed; user approval is still pending.', provider: 'local-qwen', role: 'Helper', supportType: 'handoff-summary' });
  const claim = f.store.claimTask({ id: 'local-helper', provider: 'local-qwen', roles: ['Helper'], projectPath: '' }, { taskId: task.id });
  assert.ok(claim);
  f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'HTTP 503 service temporarily unavailable' });
  const state = await runHuddle(t, f);
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.tasks.find(item => item.id === task.id).status, 'pending');
  assert.equal(snapshot.tasks.find(item => item.id === task.id).provider, 'local-qwen');
  assert.equal(snapshot.tasks.filter(item => item.kind === 'resolution').length, 0);
  assert.equal(state.decisions[0].action, 'dispatch');
  const next = f.store.claimTask({ id: 'local-helper-2', provider: 'local-qwen', roles: ['Helper'], projectPath: '' }, { taskId: task.id });
  assert.ok(next); assert.equal(next.task.projectPath, '');
});
