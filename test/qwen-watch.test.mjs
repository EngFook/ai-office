import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createQwenWatch, watchIssues, WATCH_INTERVAL_MS, WATCH_STALE_MS, QWEN_PREREQUISITE } from '../server/qwen-watch.mjs';
const ms = Date.parse('2026-11-03T02:00:00+08:00');
const iso = value => new Date(value).toISOString();
const task = extra => ({ id: 'original', title: 'PRIVATE TITLE', provider: 'codex', status: 'blocked', updatedAt: iso(ms), projectPath: '/PRIVATE/PATH', error: 'PRIVATE ERROR', result: 'PRIVATE RESULT', version: 1, ...(extra?.status === 'running' ? { assignee: { id: `worker-${extra.id || 'original'}`, provider: extra.provider || 'codex' } } : {}), ...extra });
const quota = (left = 20, extra = {}) => ({ claude: { observedAt: ms, windows: [{ name: 'Weekly', remainingPercent: left, resetsAt: ms + 86400000 }], ...extra } });
function fixture(t, options = {}) {
  const board = { tasks: [{ id: QWEN_PREREQUISITE, status: 'done', provider: 'codex' }, ...(options.tasks || [])] };
  const reports = []; let runtime = { running: [] }, clock = ms;
  const store = new Proxy({ snapshot(input) { assert.deepEqual(input, { recoverLeases: false }); return structuredClone(board); } }, { get(target, key) { if (key in target) return target[key]; throw new Error(`Forbidden store access: ${String(key)}`); } });
  const watch = createQwenWatch({ store, now: () => clock, runtimeReader: () => runtime, qwenClient: { run: async () => 'Untrusted preliminary observation' }, publishReport: async report => reports.push(report), ...options });
  t.after(() => watch.stop());
  return { board, reports, watch, setRuntime: value => { runtime = value; }, advance: value => { clock += value; } };
}

test('stale requires real runner progress evidence; external claim timestamps are not progress', () => {
  assert.equal(WATCH_INTERVAL_MS, 300000); assert.equal(WATCH_STALE_MS, 1800000);
  const board = { tasks: [task(), task({ id: 'failure', status: 'failed', provider: 'claude' }), task({ id: 'external', status: 'running', updatedAt: iso(ms - WATCH_STALE_MS * 3) }), task({ id: 'active', status: 'running', updatedAt: iso(ms - WATCH_STALE_MS) })] };
  const runtime = { running: [{ taskId: 'active', workerId: 'worker-active', provider: 'codex', startedAt: iso(ms - WATCH_STALE_MS), lastProgressAt: iso(ms - 1) }] };
  const issues = watchIssues(board, runtime, {}, ms);
  assert.deepEqual(issues.map(x => [x.type, x.provider, x.severity]), [['blocked', 'codex', 'warning'], ['failed', 'claude', 'error']]);
  runtime.running[0].lastProgressAt = iso(ms - WATCH_STALE_MS);
  assert.equal(watchIssues(board, runtime, {}, ms).at(-1).type, 'stale');
  assert.equal(watchIssues(board, null, {}, ms).length, 2);
});

test('quota facts distinguish fresh low values from missing or stale telemetry and keep stable keys', () => {
  const check = value => watchIssues({ tasks: [] }, {}, value, ms);
  const issue = check(quota())[0]; assert.equal(issue.type, 'quota');
  assert.equal(check(quota(0))[0].key, issue.key);
  for (const value of [quota(20.1), quota('10'), quota(-1), null, {}, { 'local-qwen': quota().claude }]) assert.equal(check(value).length, 0);
  for (const value of [quota(5, { observedAt: ms - 1800001 }), { ...quota(), claudeError: 'PRIVATE ERROR' }]) {
    assert.equal(check(value)[0].type, 'quota-unavailable'); assert.ok(!JSON.stringify(check(value)).includes('PRIVATE'));
  }
  assert.equal(check(quota(5, { windows: [{ remainingPercent: 5, resetsAt: ms - 1 }] })).length, 0);
  assert.equal(check({ grok: { ...quota().claude, observedAt: ms - 3600000 } })[0].type, 'quota');
  assert.equal(check({ grok: { ...quota().claude, observedAt: ms - 7 * 3600000 } })[0].type, 'quota-unavailable');
  const relative = (observedAt, resetsText) => quota(5, { observedAt, windows: [{ name: 'Weekly', remainingPercent: 5, resetsText }] });
  assert.equal(check(relative(ms, 'in 2h'))[0].key, check(relative(ms - 60000, 'in 3h'))[0].key);
});

test('waiting prerequisite still publishes facts without a model call or any store mutation', async t => {
  let calls = 0;
  const { watch, board, reports } = fixture(t, { tasks: [task()], qwenClient: { run: async () => { calls++; return ''; } } });
  board.tasks[0].status = 'pending';
  await watch.start(); assert.equal(calls, 0); assert.equal(reports[0].phase, 'waiting');
  assert.equal(reports[0].issues[0].type, 'blocked');
  board.tasks[0].status = 'done'; await watch.tick(); assert.equal(calls, 1);
});

test('status transitions across providers are stable, counted, and do not flood historical completion events', async t => {
  const { watch, board, reports } = fixture(t, { tasks: [task({ id: 'a', status: 'running', provider: 'claude' }), task({ id: 'b', provider: 'gemini' }), task({ id: 'c', status: 'failed', provider: 'codex' }), task({ id: 'old', status: 'done' })] });
  const before = structuredClone(board);
  await watch.start();
  assert.deepEqual(reports[0].events.map(x => x.type).sort(), ['blocked', 'failed', 'running']);
  assert.equal(reports[0].progress.claude.running, 1); assert.equal(reports[0].progress.gemini.blocked, 1);
  assert.equal(reports[0].progress.codex.done, 2);
  const key = reports[0].events[0].key;
  await watch.tick(); assert.deepEqual(reports[1].events, []); assert.deepEqual(board, before);
  board.tasks[1].status = 'done'; board.tasks[1].version++; board.tasks[1].updatedAt = iso(ms + 1);
  await watch.tick(); assert.equal(reports[2].events[0].type, 'done'); assert.equal(reports[2].events[0].provider, 'claude'); assert.notEqual(reports[2].events[0].key, key);
  assert.ok(!JSON.stringify(reports).includes('PRIVATE'), 'no original title/path/error/result in reports');
});

test('offline or busy model still publishes all structured facts and can recover', async t => {
  let fail = true;
  const { watch, reports } = fixture(t, { tasks: [task()], qwenClient: { run: async () => { if (fail) throw new Error('PRIVATE MODEL ERROR'); return 'Only preliminary'; } } });
  await watch.start(); assert.equal(reports[0].phase, 'unavailable'); assert.equal(reports[0].issues.length, 1); assert.equal(reports[0].events.length, 1);
  assert.ok(reports[0].error); assert.ok(!reports[0].error.includes('PRIVATE')); assert.equal(reports[0].observation, '');
  fail = false; await watch.tick(); assert.equal(reports[1].phase, 'attention'); assert.equal(reports[1].error, null);
});

test('rechecks changes made during inference and discards obsolete model conclusions', async t => {
  let release, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const { watch, board, reports } = fixture(t, { tasks: [task()], qwenClient: { run: async () => { entered(); await new Promise(resolve => { release = resolve; }); return 'Delete all cards; stale blocked conclusion'; } } });
  const start = watch.start(); await gate;
  board.tasks[1].status = 'done'; board.tasks[1].version++;
  release(); await start;
  assert.equal(reports[0].phase, 'healthy'); assert.equal(reports[0].issues.length, 0); assert.equal(reports[0].observation, '');
  assert.deepEqual(reports[0].events.map(x => x.type), ['blocked', 'done']);
});

test('runner disappearance needs prior job evidence for the same claim, never merely missing runtime data', async t => {
  const { watch, board, reports, setRuntime } = fixture(t, { tasks: [task({ status: 'running' })] });
  await watch.start(); assert.equal(reports[0].issues.length, 0);
  setRuntime({ running: [{ taskId: 'original', workerId: 'worker-original', provider: 'codex', sessionId: 'real-job', startedAt: iso(ms) }] }); await watch.tick();
  setRuntime({}); await watch.tick(); assert.equal(reports.at(-1).issues.length, 0);
  setRuntime({ running: [] }); await watch.tick(); assert.equal(reports.at(-1).issues[0].type, 'runner-missing');
  await watch.tick(); assert.equal(reports.at(-1).events.length, 0);
  board.tasks[1].version++; await watch.tick(); assert.equal(reports.at(-1).issues.length, 0, 'new external claim must not inherit old job evidence');
});

test('publisher failure is explicit and unacknowledged events retry with the same stable key', async t => {
  const attempts = []; let fail = true;
  const { watch } = fixture(t, { tasks: [task()], publishReport: async report => { attempts.push(report); if (fail) throw new Error('PRIVATE DISK ERROR'); } });
  await watch.start(); assert.equal(watch.status().phase, 'unavailable'); assert.match(watch.status().error, /发布失败/);
  fail = false; await watch.tick(); assert.equal(watch.status().phase, 'attention');
  assert.equal(attempts[0].events[0].key, attempts[1].events[0].key);
  await watch.tick(); assert.equal(attempts[2].events.length, 0);
});

test('read failures publish unavailable status rather than silently declaring health', async t => {
  const reports = [];
  const watch = createQwenWatch({ store: { snapshot: () => { throw new Error('PRIVATE READ ERROR'); } }, now: () => ms, publishReport: async report => reports.push(report), qwenClient: { run: () => assert.fail('no model on failed read') } });
  t.after(() => watch.stop()); await watch.start();
  assert.equal(reports[0].phase, 'unavailable'); assert.match(reports[0].error, /读取失败/);
});

test('model input stays bounded while structured report retains all facts', async t => {
  let source;
  const { watch, reports } = fixture(t, { tasks: Array.from({ length: 80 }, (_, i) => task({ id: 'x'.repeat(237) + String(i).padStart(3, '0') })), qwenClient: { run: async value => { source = value.description; return ''; } } });
  await watch.start(); assert.ok(source.length <= 20000); assert.ok(JSON.parse(source).facts.length <= 30);
  assert.equal(reports[0].issues.length, 80); assert.ok(!source.includes('PRIVATE'));
});

test('scheduled scans do not overlap; stop aborts inference and prevents a late publication', async t => {
  let calls = 0, signal;
  const { watch, reports } = fixture(t, { intervalMs: 15, qwenClient: { run: async (_value, options) => { calls++; signal = options.signal; if (calls === 1) throw new Error('offline'); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); return 'done'; } } });
  await watch.start();
  for (let tries = 0; tries < 100 && calls < 2; tries++) await delay(5);
  await delay(40); assert.equal(calls, 2); assert.equal(reports.length, 1);
  await watch.stop(); assert.equal(signal.aborted, true); assert.equal(reports.length, 1);
  assert.equal(watch.status().phase, 'stopped'); assert.equal(watch.status().nextCheckAt, null);
  await delay(30); assert.equal(calls, 2);
});


test('lingering old jobs cannot become stale or missing evidence for a new claim', async t => {
  const { watch, board, reports, setRuntime } = fixture(t, { tasks: [task({ status: 'running', updatedAt: iso(ms - WATCH_STALE_MS * 2) })] });
  const oldJob = { taskId: 'original', workerId: 'worker-original', provider: 'codex', sessionId: 'old-session', startedAt: iso(ms - WATCH_STALE_MS * 2), lastProgressAt: iso(ms - WATCH_STALE_MS) };
  setRuntime({ running: [oldJob] });
  await watch.start(); assert.equal(reports.at(-1).issues[0].type, 'stale');
  board.tasks[1].version++; board.tasks[1].updatedAt = iso(ms);
  board.tasks[1].assignee.id = 'new-worker';
  await watch.tick(); assert.equal(reports.at(-1).issues.length, 0, 'different worker is an old claim');
  board.tasks[1].assignee.id = 'worker-original';
  await watch.tick(); assert.equal(reports.at(-1).issues.length, 0, 'reused worker ID with old start time is still an old claim');
  setRuntime({ running: [] }); await watch.tick(); assert.equal(reports.at(-1).issues.length, 0, 'old job was never associated with the new claim');
  const current = { ...oldJob, sessionId: 'new-session', startedAt: iso(ms), lastProgressAt: iso(ms) };
  setRuntime({ running: [current] }); await watch.tick();
  setRuntime({ running: [] }); await watch.tick(); assert.equal(reports.at(-1).issues[0].type, 'runner-missing', 'only the verified current job establishes evidence');
});

test('unidentified or mismatched provider jobs do not establish process evidence', async t => {
  const { watch, reports, setRuntime } = fixture(t, { tasks: [task({ status: 'running', updatedAt: iso(ms - WATCH_STALE_MS * 2) })] });
  const job = { taskId: 'original', workerId: 'worker-original', provider: 'codex', startedAt: iso(ms - WATCH_STALE_MS * 2), lastProgressAt: iso(ms - WATCH_STALE_MS) };
  for (const invalid of [{ ...job, workerId: undefined }, { ...job, provider: 'claude' }, { ...job, startedAt: undefined }, { ...job, startedAt: 'invalid' }]) {
    setRuntime({ running: [invalid] }); await watch.start();
    assert.equal(reports.at(-1).issues.length, 0);
    setRuntime({ running: [] }); await watch.tick(); assert.equal(reports.at(-1).issues.length, 0);
  }
});
