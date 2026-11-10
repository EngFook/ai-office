import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalQwen } from '../server/local-qwen.mjs';
import { localQwenTaskError, LOCAL_QWEN_TYPES } from '../server/local-qwen-policy.mjs';
import { routeTask, createTaskRunner } from '../server/task-runner.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { buildSharedRoster } from '../src/unified-office.js';
import { createSharedLayout } from '../src/shared-layout.js';
import { tightestQuota } from '../src/usage-utils.js';

const task = (extra = {}) => ({ title: '日志初筛', provider: 'local-qwen', supportType: 'log-triage', description: 'Test output: 1 failed, 2 passed. EACCES writing cache.', ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const response = (output = 10, duration = 1e9) => ({ done: true, message: { content: 'Potential cache permission issue; verify the environment.' }, prompt_eval_count: 20, eval_count: output, eval_duration: duration });
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'office-local-qwen-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, usageFile: path.join(directory, 'usage.json') };
}

test('explicit support allowlist applies in store, router and client, never wildcard/coder fallback', async t => {
  const { directory } = await fixture(t);
  const store = createTaskStore({ home: directory }); t.after(() => store.close());
  for (const supportType of Object.keys(LOCAL_QWEN_TYPES)) {
    const value = task({ supportType });
    assert.equal(localQwenTaskError(value), null);
    assert.deepEqual(routeTask(value, {}), { eligible: ['local-qwen'] });
    const saved = store.createTask(value); assert.equal(saved.supportType, supportType);
    assert.equal(store.updateTask(saved.id, { supportType: 'copy-consistency' }).supportType, 'copy-consistency');
  }
  for (const extra of [{ supportType: 'code' }, { kind: 'review' }, { kind: 'research' }, { title: 'Review: logs' }, { title: '修改代码' }, { title: 'Final deliverable' }, { role: 'Tester' }, { description: '' }]) {
    assert.ok(localQwenTaskError(task(extra)));
    assert.deepEqual(routeTask(task(extra), {}).eligible, []);
    assert.throws(() => store.createTask(task(extra)));
  }
  assert.ok(!routeTask({ provider: 'any' }, {}).eligible.includes('local-qwen'));
  assert.ok(!routeTask({ provider: 'codex' }, {}).eligible.includes('local-qwen'));
  const client = createLocalQwen({ fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.run(task({ kind: 'review' })));
});

test('loopback request pins model, disables thinking, grants no tools, records only counters with SGT daily rollover', async t => {
  const { usageFile } = await fixture(t); const calls = []; let ms = Date.parse('2026-11-02T23:59:00+08:00'); let count = 0;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return url.endsWith('/api/chat') ? json(response(++count * 10, count * 1e9)) : json({ models: [{ name: 'hermes-daily:9b' }] }); };
  const client = createLocalQwen({ usageFile, fetchImpl, now: () => ms });
  const result = await client.run(task()); await client.run(task());
  assert.match(result, /human verification required/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'http://localhost:11434/api/chat'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(body.model, 'hermes-daily:9b'); assert.equal(body.think, false); assert.equal(body.stream, false);
  assert.equal(body.keep_alive, '2m'); assert.equal(body.options.num_ctx, 65536);
  assert.equal(body.tools, undefined); assert.equal(body.messages[1].images, undefined);
  assert.ok(body.messages[0].content.includes('cannot see images'));
  const state = await client.snapshot();
  assert.equal(state.online, true); assert.equal(state.loaded, true); assert.equal(state.noQuota, true);
  assert.equal(state.todayTokens, 70); assert.equal(state.averageTokPerSecond, 10);
  const ledger = await readFile(usageFile, 'utf8');
  assert.ok(!ledger.includes(task().description)); assert.ok(!ledger.includes('permission'));
  assert.equal((await createLocalQwen({ usageFile, fetchImpl, now: () => ms }).snapshot()).todayTokens, 70);
  ms += 120000;
  assert.equal((await client.snapshot()).todayTokens, 0); assert.equal((await client.snapshot()).averageTokPerSecond, null);
  assert.equal(tightestQuota({ quota: { 'local-qwen': { windows: [{ remainingPercent: 0 }] } } }, 'Local Qwen'), null);
});

test('online, installed and loaded are independent; offline and unknown never report loaded', async t => {
  const { usageFile } = await fixture(t);
  const client = createLocalQwen({ usageFile, fetchImpl: async url => url.endsWith('/api/tags') ? json({ models: [{ name: 'hermes-daily:9b' }] }) : json({ models: [] }) });
  assert.deepEqual(await client.probe(), { online: true, installed: true, loaded: false });
  const missing = createLocalQwen({ usageFile, fetchImpl: async () => json({ models: [] }) });
  assert.deepEqual(await missing.probe(), { online: true, installed: false, loaded: false });
  const offline = createLocalQwen({ usageFile, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await offline.probe(), { online: false, installed: false, loaded: null });
});

test('client serializes generation, abort releases slot, incomplete and oversized outputs fail closed', async t => {
  const { usageFile } = await fixture(t); let started;
  const gate = new Promise(resolve => { started = resolve; });
  const client = createLocalQwen({ usageFile, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    started(); if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const controller = new AbortController(); const run = client.run(task(), { signal: controller.signal });
  await gate; await assert.rejects(client.run(task()), /concurrency/); controller.abort(); await assert.rejects(run);
  const broken = createLocalQwen({ usageFile, fetchImpl: async () => json({ ...response(), done: false }) });
  await assert.rejects(broken.run(task()), /completed/);
  const oversized = createLocalQwen({ usageFile, fetchImpl: async () => json({ ...response(), message: { content: 'x'.repeat(300000) } }) });
  await assert.rejects(oversized.run(task()), /too large/);
  await assert.rejects(readFile(usageFile));
});

test('runner executes one local task, exposes real support presence, heartbeats and blocks interruption without spawning', async t => {
  const { directory, usageFile } = await fixture(t);
  const project1 = path.join(directory, 'one'), project2 = path.join(directory, 'two'); await mkdir(project1); await mkdir(project2);
  const store = createTaskStore({ home: path.join(directory, 'board') }); t.after(() => store.close());
  store.createTask(task({ projectPath: project1 })); store.createTask(task({ projectPath: project2 }));
  const calls = []; let release;
  const qwenClient = { run: (value, { signal }) => new Promise((resolve, reject) => { calls.push(value); release = resolve; signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); }) };
  const runner = createTaskRunner({ store, qwenClient, spawnProcess: () => { throw new Error('no spawn allowed'); }, probeProviders: async () => ({ 'local-qwen': { available: true, authenticated: true } }), pollIntervalMs: 10000, heartbeatMs: 10 });
  t.after(() => runner.stop());
  await runner.start(); assert.equal(calls.length, 1);
  assert.equal(runner.status().active.coding, 0); assert.equal(runner.status().active.support, 1);
  assert.equal(runner.status().agents[0].provider, 'Local Qwen');
  release('Preliminary observation'); await delay(20); await runner.kick();
  assert.equal(calls.length, 2); assert.equal(store.snapshot().tasks.filter(t => t.kind === 'review').length, 0);
  await runner.stop(); assert.equal(store.snapshot().tasks.filter(t => t.status === 'blocked').length, 1);
  assert.equal(store.snapshot().tasks.filter(t => t.status === 'done').length, 1);
  assert.equal(runner.status().agents.length, 0);
});

test('local actor uses existing Studio figures and reserved desk without changing geometry, bounds or original actor indices', () => {
  const worker = { id: 'worker', status: 'working', observed: true, agentRole: 'Helper' };
  const states = { claude: { agents: [worker] }, gemini: { agents: [{ ...worker, id: 'research' }] } };
  const seats = new Map(); const original = buildSharedRoster(states, seats);
  const roster = buildSharedRoster({ ...states, 'local-qwen': { agents: [{ ...worker, id: 'local-qwen:job' }] } }, seats);
  assert.deepEqual(roster.filter(a => a.provider !== 'Local Qwen').map(a => [a.id, a.index]), original.map(a => [a.id, a.index]));
  const before = createSharedLayout(original), after = createSharedLayout(roster);
  assert.deepEqual(after.desks.map(d => [d.id, d.x, d.z, d.angle]), before.desks.map(d => [d.id, d.x, d.z, d.angle]));
  assert.deepEqual(after.bounds, before.bounds); assert.deepEqual(after.commons, before.commons); assert.deepEqual(after.lounge, before.lounge);
  const local = roster.find(a => a.provider === 'Local Qwen');
  assert.equal(after.placements.get(local.id).id, 'local-qwen:workstation:0');
  assert.equal(after.placements.get(local.id).provider, 'local-qwen');
  assert.equal(after.agents.length, original.length + 1);
  assert.equal(buildSharedRoster({ 'local-qwen': { agents: [] } }).length, 0);
});

test('corrupt or unwritable telemetry keeps completed answers and displays unavailable usage', async t => {
  const { directory, usageFile } = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(usageFile, '{broken');
  const fetchImpl = async url => url.endsWith('/api/chat') ? json(response()) : json({ models: [] });
  const corrupt = createLocalQwen({ usageFile, fetchImpl });
  assert.match(await corrupt.run(task()), /human verification required/);
  assert.match(await corrupt.run(task()), /human verification required/);
  const snapshot = await corrupt.snapshot();
  assert.equal(snapshot.todayTokens, null); assert.equal(snapshot.averageTokPerSecond, null);
  assert.ok(snapshot.usageError); assert.equal(await readFile(usageFile, 'utf8'), '{broken');
  await writeFile(usageFile, '{"version":99}');
  const incompatible = createLocalQwen({ usageFile, fetchImpl });
  assert.match(await incompatible.run(task()), /human verification required/);
  assert.equal((await incompatible.snapshot()).todayTokens, null);
  assert.equal(await readFile(usageFile, 'utf8'), '{"version":99}');
  const ledgerDirectory = path.join(directory, 'not-a-file'); await mkdir(ledgerDirectory);
  const unwritable = createLocalQwen({ usageFile: ledgerDirectory, fetchImpl });
  assert.match(await unwritable.run(task()), /human verification required/);
  assert.equal((await unwritable.snapshot()).todayTokens, null);
});

test('store gives local assistance its own lock in either claim order and retains project context', async t => {
  const { directory } = await fixture(t);
  for (const localFirst of [true, false]) {
    const store = createTaskStore({ home: path.join(directory, String(localFirst)) });
    try {
      const local = store.createTask(task({ projectPath: directory }));
      const coding = store.createTask({ title: 'Coding task', provider: 'codex', projectPath: directory });
      const secondLocal = store.createTask(task({ projectPath: directory }));
      const claim = (id, provider, workerId) => store.claimTask({ id: workerId, provider, projectPath: directory }, { taskId: id });
      if (localFirst) {
        assert.ok(claim(local.id, 'local-qwen', 'local'));
        assert.ok(claim(coding.id, 'codex', 'coding'));
      } else {
        assert.ok(claim(coding.id, 'codex', 'coding'));
        assert.ok(claim(local.id, 'local-qwen', 'local'));
      }
      assert.equal(claim(secondLocal.id, 'local-qwen', 'second-local'), null);
      assert.equal(store.snapshot().tasks.find(t => t.id === local.id).projectPath, directory);
    } finally { store.close(); }
  }
});

test('runner lets local text assistance and coders overlap in the same project in either launch order', async t => {
  const { directory } = await fixture(t);
  for (const localFirst of [true, false]) {
    const store = createTaskStore({ home: path.join(directory, String(localFirst)) });
    let runs = 0;
    const inputs = [task({ projectPath: directory }), { title: 'Code work', provider: 'codex', projectPath: directory }];
    if (!localFirst) inputs.reverse();
    inputs.forEach(value => store.createTask(value));
    // Minimal controlled CLI process; this test exercises actual store and runner locks.
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    let child;
    const runner = createTaskRunner({ store,
      qwenClient: { run: (_, { signal }) => { runs++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })); } },
      probeProviders: async () => ({ 'local-qwen': { available: true, authenticated: true }, codex: { available: true, authenticated: true, path: '/mock/codex' } }),
      spawnProcess: () => { child = new EventEmitter(); child.pid = 999999; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child; },
      terminate: () => { child.exitCode = 143; child.emit('close', 143); }, pollIntervalMs: 10000,
    });
    try {
      await runner.start(); assert.equal(runs, 1);
      assert.equal(store.snapshot().tasks.filter(t => t.status === 'running').length, 2);
      assert.equal(runner.status().active.support, 1); assert.equal(runner.status().active.coding, 1);
    } finally { await runner.stop(); store.close(); }
  }
});

test('user reserves the slot, aborts background reports and waits for cleanup without overlapping requests', async t => {
  const { usageFile } = await fixture(t);
  let entered, cleanup, aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const cleanupGate = new Promise(resolve => { cleanup = resolve; });
  let calls = 0, inFlight = 0, maxInFlight = 0;
  const client = createLocalQwen({ usageFile, fetchImpl: async (_url, { signal }) => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (calls === 1) {
        entered();
        await new Promise((_, reject) => signal.addEventListener('abort', () => {
          aborted(); void cleanupGate.then(() => reject(signal.reason));
        }, { once: true }));
      }
      return json(response());
    } finally { inFlight--; }
  } });
  const background = client.extractWorkReport('[]');
  const rejected = assert.rejects(background, /yielded/);
  await started;
  const foreground = client.run(task()); await cancelled;
  assert.equal(calls, 1, 'foreground waits for aborted request cleanup');
  await assert.rejects(client.extractWorkReport('[]'), /concurrency/);
  await assert.rejects(client.run(task(), { background: true }), /concurrency/);
  await assert.rejects(client.run(task()), /concurrency/);
  cleanup();
  assert.match(await foreground, /human verification/); await rejected;
  assert.equal(calls, 2); assert.equal(maxInFlight, 1);
});

test('a cancelled foreground waiter never starts later or releases the still-active background slot', async t => {
  const { usageFile } = await fixture(t);
  let entered, cleanup, aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const gate = new Promise(resolve => { cleanup = resolve; });
  let calls = 0;
  const client = createLocalQwen({ usageFile, fetchImpl: async (_url, { signal }) => {
    if (++calls === 1) {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => {
        aborted(); void gate.then(() => reject(signal.reason));
      }, { once: true }));
    }
    return json(response());
  } });
  const background = client.extractWorkReport('[]'); const rejected = assert.rejects(background, /yielded/);
  await started;
  const controller = new AbortController(); const foreground = client.run(task(), { signal: controller.signal });
  const foregroundRejected = assert.rejects(foreground, /cancelled user/);
  await cancelled; controller.abort(new Error('cancelled user')); await foregroundRejected;
  await assert.rejects(client.extractWorkReport('[]'), /concurrency/);
  assert.equal(calls, 1);
  cleanup(); await rejected;
  assert.match(await client.run(task()), /human verification/);
  assert.equal(calls, 2);
});

test('background watch also yields to users; background work never interrupts a user request', async t => {
  const { usageFile } = await fixture(t);
  let entered; let calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const client = createLocalQwen({ usageFile, fetchImpl: async (_url, { signal }) => {
    if (++calls === 1) {
      entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return json(response());
  } });
  const watch = client.run(task(), { background: true }); const rejected = assert.rejects(watch, /yielded/);
  await started; assert.match(await client.run(task()), /human verification/); await rejected;
  const controller = new AbortController();
  let release;
  const userClient = createLocalQwen({ usageFile, fetchImpl: async () => new Promise(resolve => { release = () => resolve(json(response())); }) });
  const user = userClient.run(task(), { signal: controller.signal });
  await assert.rejects(userClient.extractWorkReport('[]'), /concurrency/);
  await assert.rejects(userClient.run(task(), { background: true }), /concurrency/);
  assert.equal(controller.signal.aborted, false); release(); await user;
});

test('real board runner completes a user card during report backfill and report resumes without stale publication', async t => {
  const { createQwenWorkReports, WORK_REPORT_PREREQUISITES } = await import('../server/qwen-work-reports.mjs');
  const { directory, usageFile } = await fixture(t);
  const store = createTaskStore({ home: path.join(directory, 'board') });
  t.after(() => store.close());
  store.updateSettings({ autoPickup: true, crossReview: false });
  for (const id of WORK_REPORT_PREREQUISITES) {
    const prerequisite = store.createTask({ title: 'Report prerequisite', provider: 'grok-bot', projectPath: directory }, { id });
    store.updateTask(prerequisite.id, { status: 'done' });
  }
  const completed = store.createTask({ title: 'Completed work', provider: 'codex', projectPath: directory });
  const claim = store.claimTask({ id: 'fixture-coder', provider: 'codex', projectPath: directory }, { taskId: completed.id });
  store.finishTask(completed.id, claim.claimToken, { status: 'done', result: '新增 server/example.mjs，通过测试。' });
  let entered, calls = 0; const started = new Promise(resolve => { entered = resolve; });
  const client = createLocalQwen({ usageFile, fetchImpl: async (_url, init) => {
    if (++calls === 1) {
      entered(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    const body = JSON.parse(init.body);
    return body.format === 'json'
      ? json({ ...response(), message: { content: JSON.stringify({ entries: JSON.parse(body.messages[1].content).map(value => ({ id: value.id, quoteIndex: 0, fileIndices: [] })) }) } })
      : json(response());
  } });
  const writes = [];
  const reports = createQwenWorkReports({ store, projectPath: directory, qwenClient: client,
    file: { read: async () => null, write: async value => { writes.push(value); } } });
  t.after(() => reports.stop());
  const backfill = reports.start(); await started;
  const user = store.createTask(task({ projectPath: directory }));
  const runner = createTaskRunner({ store, qwenClient: client, pollIntervalMs: 10000,
    probeProviders: async () => ({ 'local-qwen': { available: true, authenticated: true } }),
    spawnProcess: () => { throw new Error('No CLI or paid model allowed.'); } });
  t.after(() => runner.stop());
  await runner.start();
  assert.equal((await backfill).phase, 'unavailable');
  assert.equal(writes.length, 0, 'cancelled report is never published');
  let result;
  for (let attempt = 0; attempt < 80; attempt++) {
    result = store.snapshot({ recoverLeases: false }).tasks.find(value => value.id === user.id);
    if (result.status !== 'running' && result.status !== 'pending') break;
    await delay(5);
  }
  assert.equal(result.status, 'done'); assert.equal(result.error, '');
  assert.match(result.result, /human verification/);
  assert.equal((await reports.tick()).phase, 'ready');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].entries.some(entry => entry.id === user.id));
  assert.ok(writes[0].entries.some(entry => entry.id === completed.id));
  assert.equal(calls, 3);
});
