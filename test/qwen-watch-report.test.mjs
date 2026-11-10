import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, mkdir, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createQwenWatchReport } from '../server/qwen-watch-report.mjs';

const now = () => Date.parse('2026-11-03T02:00:00+08:00');
const iso = ms => new Date(ms).toISOString();
const event = (key, extra = {}) => ({ key, type: 'blocked', taskId: 'task-1', provider: 'claude', severity: 'warning', detail: '源头简述', occurredAt: iso(now()), ...extra });
const report = extra => ({ checkedAt: iso(now()), phase: 'attention', issues: [event('issue')], events: [], progress: { claude: { total: 2, running: 1, blocked: 1 } }, observation: '初筛文字', error: null, ...extra });
async function fixture(t) {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'qwen-watch-report-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  return { projectPath, filename: path.join(projectPath, 'reports', 'qwen-watch.json'), client: createQwenWatchReport({ projectPath, now }) };
}

test('fixed report stores bounded structured facts without model prose, tokens, titles, paths or raw errors', async t => {
  const { client, projectPath, filename } = await fixture(t);
  assert.equal(await client.read(), null);
  const secret = 'PRIVATE_SENTINEL_TOKEN_AND_LOG';
  const value = await client.publish(report({
    events: [event(`quota:claude:Private Window ${secret}`, { type: 'quota', detail: secret, claimToken: secret, result: secret, projectPath: secret, label: secret })],
    issues: [event('issue', { detail: secret, claimToken: secret, label: secret, projectPath: secret })],
    observation: secret, error: new Error(secret), claimToken: secret, rawLogs: secret,
    projectPath: '/must/not/write', filename: '/must/not/write',
    progress: { claude: { total: 2, running: 1, claimToken: secret }, [secret]: { total: 4 } },
  }));
  const source = await readFile(filename, 'utf8');
  assert.ok(!source.includes(secret));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.generatedAt, iso(now()));
  assert.deepEqual(value.current.observation, { available: true, verified: false });
  assert.equal(value.current.error, '本地初筛暂不可用；请查看办公室状态。');
  assert.deepEqual(value.current.progress, { claude: { total: 2, running: 1 } });
  assert.deepEqual(Object.keys(value.events[0]).sort(), ['key', 'type', 'taskId', 'provider', 'severity', 'detail', 'occurredAt'].sort());
  assert.match(value.events[0].key, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(projectPath), ['reports']);
  assert.deepEqual(await readdir(path.dirname(filename)), ['qwen-watch.json']);
  assert.deepEqual(await client.read(), value);
});

test('event deduplication survives restart; repeated alerts do not displace recent history', async t => {
  const { projectPath, client } = await fixture(t);
  await client.publish(report({ events: [event('first'), event('first')] }));
  const restarted = createQwenWatchReport({ projectPath, now });
  const value = await restarted.publish(report({ events: [event('first'), event('second')] }));
  assert.equal(value.events.length, 2);
  const retained = value.events[0].key;
  const bounded = await restarted.publish(report({ events: Array.from({ length: 200 }, (_, i) => event(`new-${i}`)) }));
  assert.equal(bounded.events.length, 200);
  assert.ok(!bounded.events.some(item => item.key === retained));
  const again = await restarted.publish(report({ events: [event('new-199')] }));
  assert.equal(again.events.length, 200);
  assert.deepEqual(again.events, bounded.events);
});

test('concurrent publishers serialize updates across instances; readers see complete snapshots and old scans do not replace new ones', async t => {
  const { projectPath, client } = await fixture(t);
  const other = createQwenWatchReport({ projectPath, now });
  await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? other : client).publish(report({ events: [event(`event-${i}`)] }))));
  assert.equal((await client.read()).events.length, 25);
  await Promise.all([
    client.publish(report({ checkedAt: iso(now() + 1000), events: [event('new')] })),
    other.publish(report({ checkedAt: iso(now() - 1000), events: [event('late-old')], phase: 'healthy' })),
  ]);
  const saved = await client.read();
  assert.equal(saved.current.checkedAt, iso(now() + 1000));
  assert.equal(saved.current.phase, 'attention');
  assert.equal(saved.events.length, 26);
});

test('invalid JSON or schema is reported without replacing existing evidence, and a failed queue can recover', async t => {
  const { client, filename } = await fixture(t);
  const original = await client.publish(report({ events: [event('retained')] }));
  for (const damaged of ['{broken', JSON.stringify({ ...original, events: {} }), JSON.stringify({ ...original, events: [null] })]) {
    await writeFile(filename, damaged);
    await assert.rejects(client.publish(report()), /invalid/);
    assert.equal(await readFile(filename, 'utf8'), damaged);
    await assert.rejects(client.read(), /invalid/);
  }
  await writeFile(filename, JSON.stringify(original));
  assert.equal((await client.publish(report({ events: [event('next')] }))).events.length, 2);
  assert.deepEqual(await readdir(path.dirname(filename)), ['qwen-watch.json']);
});

test('rejects relative destinations and symlink directories or files without touching their targets', async t => {
  assert.throws(() => createQwenWatchReport({ projectPath: 'relative' }), /absolute/);
  const { projectPath, client } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), 'qwen-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, path.join(projectPath, 'reports'));
  await assert.rejects(client.publish(report()), /regular/);
  assert.deepEqual(await readdir(external), []);
  await rm(path.join(projectPath, 'reports'));
  await mkdir(path.join(projectPath, 'reports'));
  const target = path.join(external, 'keep.json'); await writeFile(target, 'keep');
  await symlink(target, path.join(projectPath, 'reports', 'qwen-watch.json'));
  await assert.rejects(client.publish(report()), /regular/);
  assert.equal(await readFile(target, 'utf8'), 'keep');
});

test('preserves total issue count, quota-source failures and unfamiliar warnings without unbounded details', async t => {
  const { client } = await fixture(t);
  const issues = Array.from({ length: 250 }, (_, i) => event(`alert-${i}`));
  issues[0] = event('quota-source', { type: 'quota-unavailable' });
  issues[1] = event('new-warning', { type: 'future-type', detail: 'RAW_ERROR_MUST_NOT_SURVIVE' });
  const published = await client.publish(report({ issues, events: issues.slice(0, 2) }));
  assert.equal(published.current.issueCount, 250);
  assert.equal(published.current.issuesTruncated, true);
  assert.equal(published.current.issues.length, 200);
  assert.equal(published.events[0].type, 'quota-unavailable');
  assert.equal(published.events[1].type, 'unknown');
  assert.ok(!JSON.stringify(published).includes('RAW_ERROR_MUST_NOT_SURVIVE'));
  assert.deepEqual(await client.read(), published);
});

test('a failed atomic replacement leaves the previous report complete and the next write can recover', { skip: process.getuid?.() === 0 }, async t => {
  const { client, filename } = await fixture(t);
  await client.publish(report({ events: [event('before-failure')] }));
  const before = await readFile(filename, 'utf8'), directory = path.dirname(filename);
  await chmod(directory, 0o500);
  try { await assert.rejects(client.publish(report({ events: [event('must-not-appear')] })), /EACCES|EPERM/); }
  finally { await chmod(directory, 0o700); }
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.deepEqual(await readdir(directory), ['qwen-watch.json']);
  assert.equal((await client.publish(report({ events: [event('after-recovery')] }))).events.length, 2);
});
