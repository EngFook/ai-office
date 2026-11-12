import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createQwenDuty, QWEN_DUTY_INTERVAL_MS } from '../server/qwen-duty.mjs';
const base = Date.parse('2026-11-12T12:00:00Z');
const flush = () => delay(0);
function fixture(t, options = {}) {
  let clock = base, broken = false;
  const board = { tasks: [], settings: { autoPickup: true } };
  const runtime = { started: true, running: [], providers: { 'local-qwen': { available: true, authenticated: true } } };
  const calls = { watch: 0, huddle: 0, reports: 0 };
  const services = Object.fromEntries(Object.keys(calls).map(name => [name, { phase: name === 'reports' ? 'ready' : 'waiting', status() { return { started: true, phase: this.phase, error: this.error || null }; }, tick() { calls[name]++; } }]));
  const duty = createQwenDuty({ store: { snapshot(input) { assert.deepEqual(input, { recoverLeases: false }); if (broken) throw new Error('PRIVATE'); return board; } }, runtimeReader: () => runtime,
    watch: services.watch, huddle: services.huddle, workReports: services.reports, now: () => clock, ...options });
  t.after(() => duty.stop());
  return { duty, calls, board, runtime, services, advance(ms) { clock += ms; }, fail(value) { broken = value; } };
}

test('continuous duty reads real state without inventing a working task or running inference for unchanged cards', async t => {
  const { duty, calls, board, advance } = fixture(t);
  assert.equal(QWEN_DUTY_INTERVAL_MS, 15000);
  duty.start(); await flush();
  assert.deepEqual(calls, { watch: 1, huddle: 1, reports: 1 });
  for (let i = 0; i < 3; i++) { advance(15000); duty.tick(); await flush(); }
  assert.deepEqual(calls, { watch: 4, huddle: 1, reports: 1 });
  assert.equal(duty.status().phase, 'monitoring'); assert.equal(duty.status().runningTasks, 0);
  assert.equal(duty.status().checks, 4); assert.deepEqual(board.tasks, []);
  assert.equal(duty.status().heartbeatAt, new Date(base + 45000).toISOString());
  assert.equal(duty.status().nextCheckAt, new Date(base + 60000).toISOString());
  advance(15000); duty.tick(); await flush();
  assert.equal(calls.reports, 2, 'native log collection still checks once per minute without board changes');
});

test('semantic task, reply and runtime changes wake follow-up while heartbeat timestamps do not', async t => {
  const { duty, calls, board, runtime, advance } = fixture(t);
  board.tasks = [{ id: 'blocked', status: 'blocked', provider: 'codex', error: 'need info', version: 1, resolution: { state: 'needs_user', nextCheckAt: 'old' }, humanGate: { state: 'pending' } }];
  duty.start(); await flush();
  advance(15000); board.tasks[0].version++; board.tasks[0].resolution.nextCheckAt = 'new'; duty.tick(); await flush();
  assert.equal(calls.huddle, 1);
  advance(15000); board.tasks[0].humanGate.state = 'answered'; duty.tick(); await flush(); assert.equal(calls.huddle, 2);
  advance(15000); runtime.running.push({ taskId: 'other', workerId: 'worker', provider: 'codex' }); duty.tick(); await flush(); assert.equal(calls.huddle, 3);
  advance(15000); runtime.running[0].lastProgressAt = 'now'; duty.tick(); await flush(); assert.equal(calls.huddle, 3);
  advance(15000); runtime.running = []; duty.tick(); await flush(); assert.equal(calls.huddle, 4);
});

test('new completion wakes reports; unchanged backfill is bounded and model calls never overlap', async t => {
  let resolve, calls = 0;
  const reports = { status: () => ({ started: true, phase: 'backfill' }), tick() { calls++; return new Promise(done => { resolve = done; }); } };
  const { duty, board, advance } = fixture(t, { workReports: reports });
  duty.start(); await flush(); assert.equal(calls, 1);
  advance(60000); duty.tick(); await flush(); assert.equal(calls, 1);
  resolve(); await flush(); duty.tick(); await flush(); assert.equal(calls, 2);
  resolve(); await flush(); advance(15000); duty.tick(); await flush(); assert.equal(calls, 2);
  board.tasks.push({ id: 'result', status: 'done', result: 'Actual result' }); duty.tick(); await flush(); assert.equal(calls, 3);
  resolve(); await flush();
});

test('source failure preserves last real heartbeat and recovers on the next scan without leaking errors', async t => {
  const { duty, fail, advance, runtime, calls } = fixture(t);
  duty.start(); await flush();
  const checked = duty.status().lastCheckedAt;
  advance(15000); fail(true); duty.tick(); await flush();
  assert.equal(duty.status().phase, 'degraded'); assert.equal(duty.status().lastCheckedAt, checked);
  assert.equal(calls.watch, 1); assert.doesNotMatch(duty.status().error, /PRIVATE/);
  fail(false); advance(15000); duty.tick(); await flush();
  assert.equal(duty.status().phase, 'monitoring'); assert.equal(duty.status().error, null);
  runtime.providers['local-qwen'].available = false; duty.tick(); await flush();
  assert.equal(duty.status().phase, 'degraded'); assert.match(duty.status().error, /连接不可用/);
});

test('service failures stay visible and successful retries clear them', async t => {
  let failed = true;
  const watch = { status: () => ({ started: true, phase: 'healthy' }), tick: async () => { if (failed) throw new Error('PRIVATE'); } };
  const { duty, advance } = fixture(t, { watch });
  duty.start(); await flush(); assert.equal(duty.status().phase, 'degraded');
  failed = false; advance(15000); duty.tick(); await flush(); assert.equal(duty.status().phase, 'monitoring');
});

test('disabled duty does not start; stopped duty cancels pending notifications', async t => {
  const disabled = fixture(t, { enabled: false });
  disabled.duty.start(); disabled.duty.notify(); disabled.duty.tick(); await flush();
  assert.equal(disabled.duty.status().started, false); assert.deepEqual(disabled.calls, { watch: 0, huddle: 0, reports: 0 });
  const enabled = fixture(t, { intervalMs: 15, eventDelayMs: 5 });
  enabled.duty.start(); await flush(); enabled.duty.notify(); await enabled.duty.stop();
  const checks = enabled.duty.status().checks; await delay(30);
  assert.equal(enabled.duty.status().checks, checks); assert.equal(enabled.duty.status().nextCheckAt, null);
  assert.equal(enabled.duty.status().phase, 'stopped');
});

test('polling runs without a browser; duplicate runner notifications do not reset the periodic timer', async t => {
  const { duty, runtime } = fixture(t, { now: Date.now, intervalMs: 30, eventDelayMs: 5 });
  duty.start(); duty.notify(runtime); await delay(15);
  const checks = duty.status().checks, next = duty.status().nextCheckAt;
  duty.notify(runtime); duty.notify(runtime);
  assert.equal(duty.status().nextCheckAt, next);
  await delay(35); assert.ok(duty.status().checks > checks);
});


test('model-not-ready and unavailable native records cannot report a healthy duty', async t => {
  const { duty, runtime, services } = fixture(t);
  duty.start(); await flush();
  runtime.providers['local-qwen'].authenticated = false; duty.tick(); await flush();
  assert.equal(duty.status().phase, 'degraded');
  runtime.providers['local-qwen'].authenticated = true;
  services.reports.status = () => ({ started: true, phase: 'ready', logSummary: { phase: 'unavailable', sourceErrors: ['codex'] } });
  duty.tick(); await flush();
  assert.equal(duty.status().phase, 'degraded');
  services.reports.status = () => ({ started: true, phase: 'ready', logSummary: { phase: 'summarizing', sourceErrors: [] } });
  duty.tick(); await flush();
  assert.equal(duty.status().phase, 'working');
});


test('only live local jobs count as work, excluding completed or stale runner records', async t => {
  const { duty, runtime } = fixture(t);
  runtime.running = [
    { provider: 'local-qwen', taskId: 'live' },
    { provider: 'local-qwen', taskId: 'done', finished: true },
    { provider: 'local-qwen', taskId: 'pending', status: 'pending' },
    { provider: 'local-qwen' },
    { provider: 'codex', taskId: 'other' },
  ];
  duty.start(); await flush(); assert.equal(duty.status().runningTasks, 1);
  assert.equal(duty.status().phase, 'working');
  runtime.started = false; duty.tick(); await flush(); assert.equal(duty.status().runningTasks, 0);
  assert.equal(duty.status().phase, 'degraded');
  runtime.started = true; runtime.unavailable = true; duty.tick(); await flush(); assert.equal(duty.status().runningTasks, 0);
});
