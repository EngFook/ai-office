import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createGrokBlockedPatrol } from '../server/grok-blocked-patrol.mjs';

const AT = Date.parse('2026-11-13T00:00:00Z'), INTERVAL = 600000;
const runtime = () => ({ started: true, running: [], providers: Object.fromEntries(['codex', 'claude', 'gemini', 'local-qwen'].map(provider => [provider, { available: true, authenticated: true }])) });
const quota = now => Object.fromEntries(['codex', 'claude', 'gemini'].map(provider => [provider, { observedAt: now, windows: [{ name: 'Weekly', remainingPercent: 80, resetsAt: now + 86400000 }, { name: 'Session', remainingPercent: 80, resetsAt: now + 3600000 }] }]));
const worker = (dir, provider = 'codex') => ({ id: `fixture-${provider}`, provider, roles: ['any'], projectPath: dir });
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'grok-blocked-'));
  const f = { home, clock: AT, notifications: [], dispatched: 0, services: [], count: 0 };
  f.store = createTaskStore({ home, now: () => f.clock, crossReview: false, ...options });
  f.block = async (error = 'HTTP 429 rate limited', input = {}) => {
    const project = path.join(home, `project-${f.count++}`); await mkdir(project);
    const task = f.store.createTask({ title: 'Repair fixture', description: 'Change only the authorized fixture.', provider: 'codex', projectPath: project, ...input });
    const claim = f.store.claimTask(worker(project, task.provider === 'any' ? 'codex' : task.provider), { taskId: task.id });
    return f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error });
  };
  f.make = (extra = {}) => {
    const service = createGrokBlockedPatrol({ store: f.store, home, enabled: true, now: () => f.clock, runtimeReader: runtime,
      quotaReader: () => quota(f.clock), notify: async items => { f.notifications.push(items); return { configured: true, sent: true }; }, onDispatch: async () => { f.dispatched++; }, ...extra });
    f.services.push(service); return service;
  };
  f.input = (service, id, action = 'wait', more = {}) => {
    const page = service.pending(), task = page.tasks.find(task => task.id === id);
    assert.ok(task);
    return { source: 'grok-bot', cycleId: page.cycleId, version: task.version, fingerprint: task.fingerprint, action,
      provider: task.candidates[0]?.provider, reason: 'Verified the current failure and selected the bounded next step.', evidence: 'Checked original task, current runtime and quota facts.', ...more };
  };
  t.after(async () => { for (const service of f.services) await service.stop(); f.store.close(); await rm(home, { recursive: true, force: true }); });
  return f;
}

test('empty patrol is silent and preserves its ten-minute schedule across restart', async t => {
  const f = await fixture(t), service = f.make();
  await service.start();
  assert.equal(f.notifications.length, 0); assert.equal(service.status().phase, 'watching');
  assert.equal(service.status().nextCheckAt, new Date(AT + INTERVAL).toISOString());
  await service.stop(); f.clock += 60000;
  const resumed = f.make(); await resumed.start();
  assert.equal(resumed.status().nextCheckAt, new Date(AT + INTERVAL).toISOString());
  await f.block(); await resumed.tick(); assert.equal(f.notifications.length, 0);
  f.clock = AT + INTERVAL; await resumed.tick(); assert.equal(f.notifications.length, 1);
});

test('one wake per current cycle, overlapping ticks coalesce, accepted wake is not a real check', async t => {
  const f = await fixture(t); await f.block();
  let release, calls = 0;
  const service = f.make({ notify: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { sent: true }; } });
  const starting = service.start(); await Promise.resolve();
  const ticking = service.tick(); release(); await Promise.all([starting, ticking]);
  assert.equal(calls, 1); assert.equal(service.status().phase, 'awaiting_bot');
  assert.equal(service.status().lastReadAt, null); assert.equal(service.status().lastHandledAt, null);
  const page = service.pending(); assert.ok(page.cycleId); assert.equal(page.tasks.length, 1);
  assert.equal(service.status().lastReadAt, new Date(AT).toISOString()); assert.equal(service.status().lastHandledAt, null);
  await service.tick(); assert.equal(calls, 1);
});

test('real retry resumes original task, keeps scope, wakes runner and rejects duplicate handling', async t => {
  const f = await fixture(t), original = await f.block(), service = f.make(); await service.start();
  const input = f.input(service, original.id, 'retry');
  const result = await service.handle(original.id, input);
  assert.equal(result.applied, true); assert.equal(f.dispatched, 1);
  const current = f.store.snapshot().tasks.find(task => task.id === original.id);
  assert.equal(current.status, 'pending'); assert.equal(current.projectPath, original.projectPath);
  assert.equal(current.description, original.description); assert.equal(current.huddleRetry.attempts, 1);
  assert.equal(service.status().lastHandledAt, new Date(AT).toISOString());
  await assert.rejects(service.handle(original.id, input), /不重复派单/);
  assert.equal(f.dispatched, 1);
});

test('wait records actual findings without altering original task or fabricating a human request', async t => {
  const f = await fixture(t), task = await f.block(), service = f.make(); await service.start();
  const input = f.input(service, task.id);
  const before = f.store.snapshot();
  const result = await service.handle(task.id, input);
  assert.equal(result.applied, false); assert.equal(f.dispatched, 0);
  assert.deepEqual(f.store.snapshot().tasks, before.tasks); assert.deepEqual(f.store.snapshot().humanRequests, before.humanRequests);
  assert.equal(service.status().lastResult.action, 'wait');
  await service.stop();
  const resumed = f.make(); await resumed.start();
  await assert.rejects(resumed.handle(task.id, input), /不重复派单/);
  assert.equal(f.notifications.length, 1);
});

test('changed versions, wrong fingerprints, expired cycles and unrequested task actions are rejected', async t => {
  const f = await fixture(t), task = await f.block(), service = f.make(); await service.start();
  const input = f.input(service, task.id, 'retry');
  await assert.rejects(service.handle(task.id, { ...input, fingerprint: '0'.repeat(64) }), /当前版本和指纹/);
  await assert.rejects(service.handle(task.id, { ...input, action: 'done' }), /Invalid/);
  await assert.rejects(service.handle(task.id, { ...input, decision: 'approve' }), /cannot approve/);
  await assert.rejects(service.handle(task.id, { ...input, source: 'office-ui' }), /Only Grok Bot/);
  f.store.updateTask(task.id, { description: 'User changed authorized work.' });
  await assert.rejects(service.handle(task.id, input), /已经改变/);
  const fresh = f.input(service, task.id);
  f.clock += INTERVAL;
  await assert.rejects(service.handle(task.id, fresh), /轮次已改变/);
  await service.tick(); assert.notEqual(service.pending().cycleId, fresh.cycleId);
});

test('human approval, explicit pause and an in-progress maintenance window cannot resume', async t => {
  const f = await fixture(t);
  const approval = await f.block('Awaiting approval from the user before deployment.');
  const paused = await f.block(); f.store.updateTask(paused.id, { parked: true });
  const ordinary = await f.block();
  const service = f.make(); await service.start();
  const page = service.pending();
  assert.ok(page.tasks.find(task => task.id === approval.id).humanRequestId);
  for (const id of [approval.id, paused.id]) {
    const row = page.tasks.find(task => task.id === id);
    assert.deepEqual(row.allowedActions, ['wait']);
    await assert.rejects(service.handle(id, f.input(service, id, 'retry', { provider: 'codex' })), /门禁/);
  }
  const ordinaryInput = f.input(service, ordinary.id, 'retry');
  const owner = '4d068f41-617f-44ee-9df0-e5e91284d164'; f.store.acquireMaintenance(owner);
  await assert.rejects(service.handle(ordinary.id, ordinaryInput), /门禁/);
  f.store.releaseMaintenance(owner);
  assert.equal(f.store.snapshot().tasks.find(task => task.id === ordinary.id).status, 'blocked');
});

test('independent review hold and reviewer identity cannot be replaced by Grok', async t => {
  const f = await fixture(t, { crossReview: true });
  const project = path.join(f.home, 'review-project'); await mkdir(project);
  const task = f.store.createTask({ title: 'Implement fixture', description: 'Change the fixture only.', provider: 'codex', projectPath: project });
  let claim = f.store.claimTask(worker(project), { taskId: task.id });
  f.store.finishTask(task.id, claim.claimToken, { status: 'done', result: 'Implemented and verified fixture.' });
  const review = f.store.snapshot().tasks.find(item => item.reviewOf === task.id);
  claim = f.store.claimTask(worker(project, 'claude'), { taskId: review.id });
  f.store.finishTask(review.id, claim.claimToken, { status: 'blocked', error: 'HTTP 429 rate limited' });
  const service = f.make(); await service.start();
  const page = service.pending();
  assert.deepEqual(page.tasks.find(item => item.id === task.id).allowedActions, ['wait']);
  await assert.rejects(service.handle(task.id, f.input(service, task.id, 'retry', { provider: 'codex' })), /门禁/);
  const reviewRow = page.tasks.find(item => item.id === review.id);
  assert.ok(reviewRow.candidates.every(candidate => candidate.provider === 'claude'));
  await assert.rejects(service.handle(review.id, f.input(service, review.id, 'retry', { provider: 'codex' })), /分派条件/);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === task.id).reviewState, 'blocked');
});

test('hard blocker gets one bounded investigation; parent remains blocked', async t => {
  const f = await fixture(t), task = await f.block('Dependency fixture was not found.'), service = f.make(); await service.start();
  const row = service.pending().tasks.find(item => item.id === task.id);
  assert.equal(row.mode, 'investigate'); assert.ok(row.allowedActions.includes('investigate'));
  const input = f.input(service, task.id, 'investigate');
  const result = await service.handle(task.id, input);
  assert.equal(result.applied, true); assert.ok(result.investigationTaskId.startsWith('unblock:'));
  const tasks = f.store.snapshot().tasks;
  assert.equal(tasks.filter(item => item.resolutionOf === task.id).length, 1);
  assert.equal(tasks.find(item => item.id === task.id).status, 'blocked');
  f.clock += INTERVAL; await service.tick();
  const fresh = service.pending().tasks.find(item => item.id === task.id);
  assert.deepEqual(fresh.allowedActions, ['wait']);
  await assert.rejects(service.handle(task.id, f.input(service, task.id, 'investigate', { provider: 'codex' })), /分派条件/);
  assert.equal(f.store.snapshot().tasks.length, 2);
});

test('two-dispatch cycle budget survives restart and does not assign a third task', async t => {
  const f = await fixture(t), tasks = await Promise.all([f.block(), f.block(), f.block()]);
  const service = f.make(); await service.start();
  for (const task of tasks.slice(0, 2)) await service.handle(task.id, f.input(service, task.id, 'retry'));
  await service.stop(); const resumed = f.make(); await resumed.start();
  await assert.rejects(resumed.handle(tasks[2].id, f.input(resumed, tasks[2].id, 'retry')), /两项恢复/);
  assert.equal(f.dispatched, 2); assert.equal(f.notifications.length, 1);
});

test('fresh runtime and quota are checked again immediately before action', async t => {
  const f = await fixture(t), task = await f.block(); let authenticated = true, quotaValue = quota(f.clock);
  const service = f.make({ runtimeReader: () => { const value = runtime(); value.providers.codex.authenticated = authenticated; value.providers.claude.authenticated = authenticated; return value; }, quotaReader: () => quotaValue });
  await service.start(); const input = f.input(service, task.id, 'retry');
  authenticated = false; await assert.rejects(service.handle(task.id, input), /分派条件/);
  authenticated = true; quotaValue = null; await assert.rejects(service.handle(task.id, input), /分派条件/);
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked'); assert.equal(f.dispatched, 0);
});

test('auto-pickup pause permits checking but blocks an already-read recovery action', async t => {
  const f = await fixture(t), task = await f.block(), service = f.make(); await service.start();
  const input = f.input(service, task.id, 'retry'); f.store.updateSettings({ autoPickup: false });
  await assert.rejects(service.handle(task.id, input), /门禁/);
  f.clock += INTERVAL; await service.tick();
  assert.equal(service.status().phase, 'awaiting_bot'); assert.equal(f.notifications.length, 2); assert.ok(service.pending().cycleId);
  assert.deepEqual(service.pending().tasks[0].allowedActions, ['wait']);
});

test('notification failure leaves task unchanged, never reports a handled check, and retries on the next cycle', async t => {
  const f = await fixture(t), task = await f.block(); let calls = 0;
  const service = f.make({ notify: async () => { calls++; return { configured: false }; } });
  await service.start(); assert.equal(service.status().phase, 'unavailable'); assert.ok(service.status().error);
  assert.equal(service.status().lastHandledAt, null); assert.equal(f.store.snapshot().tasks[0].id, task.id);
  await service.tick(); assert.equal(calls, 1);
  await service.stop(); const resumed = f.make({ notify: async () => { calls++; return { configured: false }; } }); await resumed.start();
  assert.equal(resumed.status().phase, 'unavailable'); assert.ok(resumed.status().error); assert.equal(calls, 1);
  f.clock += INTERVAL; await resumed.tick(); assert.equal(calls, 2);
});

test('a second live instance fails closed and malformed state is preserved', async t => {
  const f = await fixture(t); await f.block(); const service = f.make(); await service.start();
  const duplicate = f.make(); await duplicate.start();
  assert.equal(duplicate.status().started, false); assert.equal(duplicate.status().phase, 'unavailable');
  assert.throws(() => duplicate.pending(), /未启用或不持有/);
  assert.equal(f.notifications.length, 1); await duplicate.stop(); await service.stop();
  const file = path.join(f.home, 'grok-blocked-patrol.json'); await writeFile(file, '{invalid');
  const broken = f.make(); await broken.start();
  assert.equal(broken.status().phase, 'unavailable'); assert.equal(await readFile(file, 'utf8'), '{invalid');
});

test('disabled service does not inspect or notify and unsafe state symlinks fail closed', async t => {
  const f = await fixture(t); await f.block(); const service = f.make({ enabled: false });
  await service.start(); assert.equal(service.status().started, false); assert.equal(f.notifications.length, 0);
  assert.throws(() => service.pending(), /未启用或不持有/);
  const target = path.join(f.home, 'unrelated-file'); await writeFile(target, 'original');
  await symlink(target, path.join(f.home, 'grok-blocked-patrol.json'));
  const unsafe = f.make(); await unsafe.start(); assert.equal(unsafe.status().phase, 'unavailable');
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('pending content and actual handling journal redact complete secrets before truncation', async t => {
  const f = await fixture(t), secret = ["crsr_", "notarealcredential01234567890123456789"].join('');
  const task = await f.block('HTTP 429 rate limited', { description: `Authorized fix. Bearer ${secret}\npassword="private fixture pass"\nhttps://api2.cursor.sh/automations/webhook/private-fixture\n${'x'.repeat(7000)}` });
  const service = f.make(); await service.start(); const page = service.pending();
  assert.ok(!JSON.stringify(page).includes(secret)); assert.ok(!JSON.stringify(page).includes('private fixture pass'));
  assert.ok(!JSON.stringify(page).includes('/webhook/private-fixture')); assert.ok(page.tasks[0].description.length <= 6000);
  await service.handle(task.id, f.input(service, task.id, 'wait', { reason: `Observed token=${secret}`, evidence: `Bearer ${secret}` }));
  assert.ok(!JSON.stringify(service.status()).includes(secret));
  assert.ok(!(await readFile(path.join(f.home, 'grok-blocked-patrol.json'), 'utf8')).includes(secret));
});

test('runner wake failure leaves safely queued work and prevents duplicate dispatch', async t => {
  const f = await fixture(t), task = await f.block(), service = f.make({ onDispatch: async () => { throw new Error('runner offline'); } });
  await service.start(); const input = f.input(service, task.id, 'retry');
  const result = await service.handle(task.id, input);
  assert.equal(result.applied, true); assert.equal(service.status().phase, 'unavailable'); assert.match(service.status().error, /执行器唤醒失败/);
  assert.equal(f.store.snapshot().tasks[0].status, 'pending'); await assert.rejects(service.handle(task.id, input), /不重复派单/);
});


test('legacy custom provider concurrency is checked before a Grok recovery assignment', async t => {
  const f = await fixture(t), task = await f.block();
  const service = f.make({ providerConcurrency: { codex: 1, claude: 1 }, runtimeReader: () => {
    const value = runtime(); value.running = [{ taskId: 'another-project', provider: 'codex' }]; value.providers.claude.authenticated = false; return value;
  } });
  await service.start();
  const input = f.input(service, task.id, 'retry', { provider: 'codex' });
  assert.deepEqual(service.pending().tasks[0].allowedActions, ['wait']);
  await assert.rejects(service.handle(task.id, input), /分派条件/);
  assert.equal(f.dispatched, 0);
});

test('an unconfirmed transport result never becomes awaiting_bot', async t => {
  const f = await fixture(t); await f.block();
  const service = f.make({ notify: async () => undefined }); await service.start();
  assert.equal(service.status().phase, 'unavailable'); assert.equal(service.status().lastHandledAt, null);
});

test('real handling during a slow webhook response is not overwritten with awaiting_bot', async t => {
  const f = await fixture(t), task = await f.block(); let release;
  const service = f.make({ notify: async () => { await new Promise(resolve => { release = resolve; }); return { sent: true }; } });
  const starting = service.start(); await Promise.resolve();
  await service.handle(task.id, f.input(service, task.id)); release(); await starting;
  assert.equal(service.status().phase, 'watching'); assert.equal(service.status().lastHandledAt, new Date(AT).toISOString());
});


test('late successful wake does not hide a real runner dispatch failure', async t => {
  const f = await fixture(t), task = await f.block(); let release;
  const service = f.make({ notify: async () => { await new Promise(resolve => { release = resolve; }); return { sent: true }; }, onDispatch: async () => { throw new Error('Runner unavailable'); } });
  const starting = service.start(); await Promise.resolve();
  await service.handle(task.id, f.input(service, task.id, 'retry')); release(); await starting;
  assert.equal(service.status().phase, 'unavailable'); assert.match(service.status().error, /执行器唤醒失败/);
  assert.equal(f.store.snapshot().tasks[0].status, 'pending');
});
