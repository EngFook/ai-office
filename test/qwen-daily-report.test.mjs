import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQwenDailyReport } from '../server/qwen-daily-report.mjs';

const START = Date.parse('2026-11-12T22:00:00+08:00');
const DUE = Date.parse('2026-11-13T08:00:00+08:00');
const config = { enabled: true, timeZone: 'Asia/Singapore', hour: 8 };
const task = extra => ({ id: 'task:1', title: '修复办公室', provider: 'codex', status: 'done', projectPath: '/projects/office', result: '已修复，测试通过。', createdAt: '2026-11-12T04:00:00Z', updatedAt: '2026-11-12T06:00:00Z', completionSource: 'agent', ...extra });
async function fixture(t, extra = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-daily-report-'));
  const f = { home, at: START, board: { tasks: [task()], humanRequests: [] }, calls: [], notices: [], busy: false, scope: ['/projects/office'] };
  f.client = { model: 'test-local:9b', runtimeState: () => ({ busy: f.busy }), summarizeDailyReport: async (source, options) => { f.calls.push({ source: JSON.parse(source), options }); return { summary: '已完成办公室修复。', highlights: ['任务板记录一项完成。'] }; } };
  f.options = { home, store: { snapshot: () => structuredClone(f.board) }, qwenClient: f.client, now: () => f.at, allowedProjects: () => f.scope, notify: async reports => { f.notices.push(reports); }, config, intervalMs: 3600000, retryMs: 1000, ...extra };
  f.service = createQwenDailyReport(f.options);
  f.services = [f.service];
  f.replace = overrides => { f.service = createQwenDailyReport({ ...f.options, ...overrides }); f.services.push(f.service); return f.service; };
  t.after(async () => { await Promise.all(f.services.map(service => service.stop())); await rm(home, { recursive: true, force: true }); });
  return f;
}

test('disabled by default; explicitly persisted configuration survives a new instance', async t => {
  const f = await fixture(t, { config: undefined });
  assert.equal((await f.service.start()).enabled, false);
  assert.equal(f.service.status().nextDueAt, null); assert.equal(f.calls.length, 0);
  await f.service.stop();
  await writeFile(path.join(f.home, 'qwen-daily-report-config.json'), JSON.stringify(config), { mode: 0o600 });
  f.replace({ config: undefined });
  const status = await f.service.start();
  assert.equal(status.enabled, true); assert.equal(status.nextDueAt, new Date(DUE).toISOString());
  assert.equal(status.timeZone, 'Asia/Singapore');
});

test('first enable schedules tomorrow, persists the exact 08:00 boundary, and catches up once after restart', async t => {
  const f = await fixture(t);
  await f.service.start(); assert.equal(f.calls.length, 0);
  const next = f.service.status().nextDueAt;
  await f.service.stop(); f.at = DUE + 600000; f.replace({ config: undefined });
  await f.service.start();
  assert.equal(f.calls.length, 1);
  const [report] = f.service.pending();
  assert.equal(report.id, 'qwen-daily:2026-11-13'); assert.equal(report.source, 'local-qwen');
  assert.deepEqual(report.period, { startAt: '2026-11-12T00:00:00.000Z', endAt: next, timeZone: 'Asia/Singapore' });
  assert.equal(report.counts.completed, 1); assert.equal(report.status, 'pending');
  assert.equal(f.notices.length, 1); assert.equal(f.service.status().nextDueAt, '2026-11-14T00:00:00.000Z');
  assert.equal(report.delivery, undefined, 'webhook acceptance is never an actual delivery receipt');
  await f.service.tick(); assert.equal(f.calls.length, 1);
  await f.service.stop(); f.replace({ config: undefined }); await f.service.start();
  assert.equal(f.calls.length, 1); assert.equal(f.service.pending()[0].reportHash, report.reportHash);
  assert.equal((await stat(path.join(f.home, 'qwen-daily-report.json'))).mode & 0o777, 0o600);
});

test('08:00 window is start-inclusive and end-exclusive; current blockers and user questions are distinct', async t => {
  const f = await fixture(t);
  f.board.tasks = [task({ id: 'at-start', updatedAt: '2026-11-12T00:00:00Z' }), task({ id: 'at-end', updatedAt: '2026-11-13T00:00:00Z' }), task({ id: 'before', updatedAt: '2026-11-11T23:59:59Z' }), task({ id: 'blocked', status: 'blocked', updatedAt: '2026-11-10T00:00:00Z', error: '等待用户资料。' })];
  f.board.humanRequests = [{ id: 'question:1', taskId: 'blocked', state: 'pending', kind: 'info', question: '请给版本号。' }];
  await f.service.start(); f.at = DUE; await f.service.tick();
  const source = f.calls[0].source;
  assert.equal(source.counts.completed, 1); assert.equal(source.counts.changed, 1);
  assert.equal(source.counts.blocked, 1); assert.equal(source.counts.needsUser, 1);
  assert.deepEqual(source.tasks.map(row => row.id).sort(), ['at-start', 'blocked']);
  assert.match(source.coverage, /不声称覆盖所有/);
});

test('only allowed project aliases are included; private data is redacted before clipping', async t => {
  const f = await fixture(t);
  f.scope = [{ name: 'Office', path: '/projects/office', folders: ['/worktrees/office-2'] }];
  const secret = ["crsr_", "abcdefghijklmnopqrstuv"].join('');
  f.board.tasks = [task({ title: `API ${secret}`, result: `Authorization: Bearer ${secret}\nhttps://user:password@example.test/x?token=privatevalue\napi_key='privatekeyvalue'` }), task({ id: 'alias', projectPath: '/worktrees/office-2' }), task({ id: 'outside', projectPath: '/projects/office-other', title: 'PRIVATE OUTSIDE TITLE' })];
  f.client.summarizeDailyReport = async (source, options) => { f.calls.push({ source: JSON.parse(source), options }); return { summary: `总结 ${secret}`, highlights: ['password=anothersecret'] }; };
  await f.service.start(); f.at = DUE; await f.service.tick();
  const source = JSON.stringify(f.calls[0].source), published = JSON.stringify(f.service.pending());
  for (const text of [source, published]) {
    assert.ok(!text.includes(secret)); assert.ok(!text.includes('privatevalue')); assert.ok(!text.includes('privatekeyvalue')); assert.ok(!text.includes('PRIVATE OUTSIDE TITLE')); assert.ok(!text.includes('anothersecret'));
  }
  assert.equal(f.calls[0].source.counts.completed, 2); assert.equal(f.calls[0].source.counts.outOfScope, 1);
  f.scope = ['/projects/office'];
  assert.equal(f.service.pending().length, 0); assert.equal(f.service.status().withheldCount, 1);
  const previous = f.notices.length; await f.service.tick(); assert.equal(f.notices.length, previous);
});

test('empty project scope never sends task content or falsely reports completed work', async t => {
  const f = await fixture(t); f.scope = [];
  await f.service.start(); f.at = DUE; await f.service.tick();
  assert.equal(f.calls[0].source.counts.completed, 0); assert.equal(f.calls[0].source.counts.outOfScope, 1);
  assert.deepEqual(f.calls[0].source.tasks, []);
});

test('source byte budget is bounded and omission counts remain visible', async t => {
  const f = await fixture(t);
  f.board.tasks = Array.from({ length: 120 }, (_, i) => task({ id: `task:${i}`, title: '中文标题'.repeat(40), result: '中文结果'.repeat(300) }));
  await f.service.start(); f.at = DUE; await f.service.tick();
  const source = f.calls[0].source;
  assert.ok(Buffer.byteLength(JSON.stringify(source)) <= 18000); assert.equal(source.counts.completed, 120);
  assert.ok(source.counts.omitted > 0); assert.ok(source.tasks.length < 120);
});

test('busy model waits; model failures retry the same immutable source without fake fallback', async t => {
  const f = await fixture(t); await f.service.start(); f.at = DUE; f.busy = true;
  await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.service.status().phase, 'waiting-model');
  f.busy = false; let attempts = 0;
  f.client.summarizeDailyReport = async source => { f.calls.push({ source: JSON.parse(source) }); if (++attempts === 1) throw new Error('offline'); return { summary: '恢复后生成。', highlights: [] }; };
  await f.service.tick(); assert.equal(f.service.pending().length, 0); assert.equal(f.notices.length, 0);
  f.board.tasks = []; f.at += 500; await f.service.tick(); assert.equal(f.calls.length, 1);
  f.at += 501; await f.service.tick(); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].source, f.calls[1].source); assert.equal(f.service.pending()[0].counts.completed, 1);
});

test('transient snapshot failure recovers on the next tick', async t => {
  let failing = true;
  const f = await fixture(t, { store: { snapshot: () => { if (failing) throw new Error('temporary'); return { tasks: [], humanRequests: [] }; } } });
  await f.service.start(); f.at = DUE; await f.service.tick(); assert.equal(f.service.status().phase, 'unavailable');
  failing = false; await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.service.pending().length, 1);
});

test('real delivery ACK binds source, exact report hash and one message; duplicate ACK is idempotent across restart', async t => {
  const f = await fixture(t); await f.service.start(); f.at = DUE; await f.service.tick();
  const [report] = f.service.pending(); const input = { source: 'grok-bot', reportHash: report.reportHash, messageId: 'bot-message:actual-1' };
  for (const [change, status] of [[{ source: 'office-ui' }, 400], [{ reportHash: '0'.repeat(64) }, 409], [{ messageId: '' }, 400]]) {
    assert.throws(() => f.service.acknowledge(report.id, { ...input, ...change }), error => error instanceof Error && error.status === status);
  }
  const delivered = f.service.acknowledge(report.id, input);
  assert.equal(delivered.status, 'delivered'); assert.equal(f.service.pending().length, 0);
  assert.deepEqual(f.service.acknowledge(report.id, input), delivered);
  assert.throws(() => f.service.acknowledge(report.id, { ...input, messageId: 'different' }), error => error.status === 409);
  await f.service.stop();
  assert.throws(() => f.service.acknowledge(report.id, input), error => error.status === 503);
  f.replace({ config: undefined }); await f.service.start();
  assert.deepEqual(f.service.acknowledge(report.id, input), delivered); assert.equal(f.calls.length, 1);
});

test('a second instance cannot own the schedule, notify or acknowledge; ownership reloads the latest state', async t => {
  const f = await fixture(t); const second = createQwenDailyReport(f.options); f.services.push(second);
  await f.service.start(); f.at = DUE; await f.service.tick();
  await second.start(); await second.tick(); assert.equal(f.calls.length, 1); assert.equal(second.status().started, false);
  const [report] = f.service.pending(); const ack = { source: 'grok-bot', reportHash: report.reportHash, messageId: 'actual:one' };
  assert.throws(() => second.acknowledge(report.id, ack), error => error.status === 503);
  await second.stop(); await access(path.join(f.home, 'qwen-daily-report.lock'));
  f.service.acknowledge(report.id, ack); await f.service.stop();
  await second.start(); assert.equal(second.pending().length, 0); assert.equal(f.calls.length, 1);
});

test('a dead PID lock is reclaimed but malformed locks and corrupted state fail closed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, 'qwen-daily-report.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }), { mode: 0o600 });
  await f.service.start(); assert.equal(f.service.status().started, true); await f.service.stop();
  await writeFile(path.join(f.home, 'qwen-daily-report.json'), 'corrupted', { mode: 0o600 });
  f.replace({ config: undefined }); await f.service.start(); f.at = DUE; await f.service.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.service.status().phase, 'unavailable');
  assert.equal(await readFile(path.join(f.home, 'qwen-daily-report.json'), 'utf8'), 'corrupted');
});

test('stop aborts a generation and never publishes or notifies its late result', async t => {
  const f = await fixture(t); await f.service.start(); f.at = DUE;
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  f.client.summarizeDailyReport = async (_source, { signal }) => { began(); return new Promise(resolve => { release = () => resolve({ summary: 'late result', highlights: [] }); signal.addEventListener('abort', release, { once: true }); }); };
  const scan = f.service.tick(); await started; await f.service.stop(); await scan;
  assert.equal(f.notices.length, 0); assert.equal(f.service.pending().length, 0); assert.equal(f.service.status().phase, 'stopped');
  await assert.rejects(access(path.join(f.home, 'qwen-daily-report.lock')));
});


test('scope withdrawal during a failed generation does not stop later daily windows', async t => {
  const f = await fixture(t); await f.service.start(); f.at = DUE;
  f.client.summarizeDailyReport = async () => { throw new Error('offline'); };
  await f.service.tick(); f.scope = ['/projects/new']; f.at += 1001; await f.service.tick();
  assert.equal(f.service.status().withheldCount, 1);
  assert.equal(f.service.status().nextDueAt, '2026-11-14T00:00:00.000Z');
  f.board.tasks = [task({ id: 'new', projectPath: '/projects/new', updatedAt: '2026-11-13T01:00:00Z' })];
  f.client.summarizeDailyReport = async source => { f.calls.push({ source: JSON.parse(source) }); return { summary: '新范围日报。', highlights: [] }; };
  f.at = DUE + 86400000; await f.service.tick();
  assert.equal(f.service.pending().length, 1); assert.equal(f.service.pending()[0].id, 'qwen-daily:2026-11-14');
  assert.equal(f.calls[0].source.tasks[0].id, 'new');
});
