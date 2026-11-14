import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireDeploymentLock, createDeployer, validateReportReadiness } from '../scripts/merge-when-idle.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { createQwenWorkReports } from '../server/qwen-work-reports.mjs';
const WORK_REPORT_PREREQUISITES = ['report-ready-a', 'report-ready-b'];

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'idle-merge-test-'));
  const root = path.join(directory, 'live');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Idle merge test');
  git('config', 'user.email', 'idle-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(root, 'server'));
  writeFileSync(path.join(root, 'server/task-store.mjs'), 'export const MAINTENANCE_PROTOCOL = 1;\n');
  writeFileSync(path.join(root, 'server/task-board-bridge.mjs'), "const route = '/api/office/maintenance';\n");
  writeFileSync(path.join(root, 'version'), 'before\n');
  git('add', '.'); git('commit', '-m', 'before');
  const before = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'reviewed');
  writeFileSync(path.join(root, 'version'), 'after\n');
  git('commit', '-am', 'after');
  const target = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  const home = path.join(directory, 'state');
  const store = createTaskStore({ home, crossReview: false });
  const pending = store.createTask({ title: 'pending user task', provider: 'codex', projectPath: root });
  const worker = { id: 'test-worker', provider: 'codex', projectPath: root };
  const routes = [];
  let lostAcquire = false;
  let released = 0;
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    routes.push(route);
    let value;
    if (route === '/api/office/board') {
      if (options.failBoardOnce) { options.failBoardOnce = false; throw new Error('transient rollback board failure'); }
      value = { ...store.snapshot(), runtime: { running: [] }, csrfToken: 'test-token' };
    }
    else if (route === '/api/office/maintenance') {
      value = { maintenance: store.acquireMaintenance(JSON.parse(init.body).ownerToken) };
      if (options.loseAcquireResponse && !lostAcquire) { lostAcquire = true; throw new Error('response lost after commit'); }
    } else if (route === '/api/office/maintenance/release') {
      if (options.failRelease) throw new Error('office unreachable');
      value = { maintenance: store.releaseMaintenance(JSON.parse(init.body).ownerToken) }; released++;
    } else if (route === '/api/office/work-reports') value = options.report || { phase: 'unavailable', error: 'cache-save failure', providers: [] };
    else throw new Error(`unexpected request: ${route}`);
    return { ok: true, json: async () => value };
  };
  const timing = { gateEvery: 0, drainEvery: 0, restartDelay: 0, checkEvery: 0, checkLimit: 0, restartLimit: 0, cleanupEvery: 0, cleanupLimit: 0 };
  const logs = [];
  const deploy = overrides => createDeployer({ root, branch: 'reviewed', fetchImpl, backupRoot: path.join(directory, 'backups'), env: { ...process.env, AI_OFFICE_HOME: home }, timing, sleep: async () => {}, verifyLive: async () => {}, log: value => logs.push(value), ...overrides });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, home, store, pending, worker, git, before, target, routes, deploy, logs, get released() { return released; } };
}

test('exclusive deployment lock canonicalizes live symlinks and rejects other processes', t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'alias'); symlinkSync(f.root, alias);
  const lock = acquireDeploymentLock(f.root);
  assert.throws(() => acquireDeploymentLock(alias), /another deployment/);
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import {acquireDeploymentLock} from ${JSON.stringify(new URL('../scripts/merge-when-idle.mjs', import.meta.url).href)}; try { acquireDeploymentLock(process.argv[1]); process.exit(2); } catch (e) { if (!e.message.includes('another deployment')) throw e; }`, alias]);
  assert.equal(child.length, 0);
  lock.release();
  acquireDeploymentLock(alias).release();
});

test('maintenance blocks explicit claims during backups and verification; settings are preserved', async t => {
  const f = fixture(t);
  f.store.updateSettings({ autoPickup: false });
  let checkedBackup = false;
  await f.deploy({ log: message => {
    if (message.startsWith('backup written')) {
      checkedBackup = true;
      assert.equal(f.store.claimTask(f.worker, { taskId: f.pending.id }), null);
      assert.equal(f.store.claimTask(f.worker), null);
    }
  }, verifyLive: async () => {
    assert.equal(f.store.snapshot().maintenance.active, true);
    assert.equal(f.store.claimTask(f.worker, { taskId: f.pending.id }), null);
    await assert.rejects(f.deploy()(), /another deployment/);
  } })();
  assert.ok(checkedBackup);
  assert.equal(f.git('rev-parse', 'HEAD'), f.target);
  assert.equal(f.store.snapshot().settings.autoPickup, false);
  assert.equal(f.store.snapshot().maintenance.active, false);
  assert.ok(f.store.claimTask(f.worker, { taskId: f.pending.id }));
  assert.equal(f.routes.some(route => route.endsWith('/settings')), false);
});

test('a committed maintenance acquisition with a lost response is cleaned up', async t => {
  const f = fixture(t, { loseAcquireResponse: true });
  await assert.rejects(f.deploy()(), /response lost/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.before);
  assert.equal(f.store.snapshot().maintenance.active, false);
  assert.equal(f.store.snapshot().settings.autoPickup, true);
  assert.equal(f.released, 1);
  acquireDeploymentLock(f.root).release();
});

test('failed verification rolls back only its own deployed HEAD under the maintenance gate', async t => {
  const f = fixture(t);
  await assert.rejects(f.deploy({ verifyLive: async () => { throw new Error('test failure'); } })(), /test failure/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.before);
  assert.equal(f.store.snapshot().maintenance.active, false);
  assert.ok(f.logs.some(line => line.startsWith('rolling back')));
});

for (const change of ['commit', 'branch', 'dirty']) test(`rollback refuses concurrent ${change} changes`, async t => {
  const f = fixture(t);
  let expected;
  await assert.rejects(f.deploy({ verifyLive: async () => {
    if (change === 'branch') f.git('checkout', '-b', 'unrelated');
    else { writeFileSync(path.join(f.root, 'version'), 'concurrent user work\n'); if (change === 'commit') f.git('commit', '-am', 'concurrent'); }
    expected = f.git('rev-parse', 'HEAD');
    throw new Error('checks failed');
  } })(), /refusing to overwrite concurrent work/);
  assert.equal(f.git('rev-parse', 'HEAD'), expected);
  assert.equal(f.store.snapshot().maintenance.active, true);
  assert.equal(f.released, 0);
  assert.throws(() => acquireDeploymentLock(f.root), /interrupted deployment/);
  if (change !== 'branch') assert.equal(readFileSync(path.join(f.root, 'version'), 'utf8'), 'concurrent user work\n');
});

test('the merge target is pinned even if its branch moves during backup', async t => {
  const f = fixture(t);
  await f.deploy({ log: message => { if (message.startsWith('backup written')) f.git('branch', '-f', 'reviewed', f.before); } })();
  assert.equal(f.git('rev-parse', 'HEAD'), f.target);
});

test('branch and tracked-file checks are repeated after backups', async t => {
  const f = fixture(t);
  await assert.rejects(f.deploy({ log: message => { if (message.startsWith('backup written')) writeFileSync(path.join(f.root, 'version'), 'user edit\n'); } })(), /refusing to overwrite concurrent work/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.before);
  assert.equal(readFileSync(path.join(f.root, 'version'), 'utf8'), 'user edit\n');
});

test('non-fast-forward integration keeps the gate and uses the preflight merge tree', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'main-only'), 'local main advance\n');
  f.git('add', 'main-only'); f.git('commit', '-m', 'main advanced');
  const parent = f.git('rev-parse', 'HEAD');
  await f.deploy()();
  assert.equal(f.git('rev-parse', 'HEAD^1'), parent);
  assert.equal(f.git('rev-parse', 'HEAD^2'), f.target);
});

test('legacy candidate without the claim gate is rejected before backups or writes', async t => {
  const f = fixture(t);
  f.git('checkout', 'reviewed');
  writeFileSync(path.join(f.root, 'server/task-store.mjs'), '// legacy store\n');
  f.git('commit', '-am', 'legacy candidate'); f.git('checkout', 'main');
  await assert.rejects(f.deploy()(), /both support maintenance protocol/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.before);
  assert.equal(existsSync(path.join(f.directory, 'backups')), false);
});

test('legacy live fails before requesting maintenance or changing settings', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'server/task-store.mjs'), '// legacy live\n');
  f.git('commit', '-am', 'legacy live');
  await assert.rejects(f.deploy()({ gateHours: 0 }), /both support maintenance protocol/);
  assert.equal(f.routes.length, 0);
});

test('HTTP 200 with unavailable reports rolls back instead of passing deployment', async t => {
  const f = fixture(t);
  await assert.rejects(f.deploy({ checks: ['/api/office/work-reports'] })(), /work reports are not ready/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.before);
});

test('failed maintenance cleanup retains both the persistent gate and local lock for recovery', async t => {
  const f = fixture(t, { failRelease: true });
  await assert.rejects(f.deploy()(), /releasing maintenance timed out/);
  assert.equal(f.store.snapshot().maintenance.active, true);
  assert.throws(() => acquireDeploymentLock(f.root), /interrupted deployment/);
  const directory = f.git('rev-parse', '--path-format=absolute', '--git-path', 'idle-merge.lock');
  const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  f.store.releaseMaintenance(owner.ownerToken);
  rmSync(directory, { recursive: true });
});

test('report readiness verifies a real generated batch and rejects cache loss, corruption and mismatch', async t => {
  const f = fixture(t);
  const facts = WORK_REPORT_PREREQUISITES.map(id => ({ id, status: 'done', provider: 'grok-bot' }));
  facts.push({ id: 'completed', status: 'done', provider: 'codex', title: 'done', result: '修改 source.mjs 完成。', updatedAt: '2026-11-03T00:00:00.000Z', completionSource: 'agent' });
  facts.push({ id: 'legacy-completed', status: 'done', provider: 'codex', title: 'legacy done', result: '历史完成记录。', updatedAt: '2026-11-02T00:00:00.000Z' });
  const reports = createQwenWorkReports({ store: { snapshot: () => ({ tasks: facts }) }, prerequisiteIds: WORK_REPORT_PREREQUISITES, projectPath: f.root, qwenClient: { extractWorkReport: async source => ({ entries: JSON.parse(source).map(task => ({ id: task.id, quoteIndex: 0, fileIndices: [] })) }) } });
  t.after(() => reports.stop());
  const status = await reports.start();
  assert.equal(status.providers.find(group => group.provider === 'codex').tasks.find(task => task.id === 'legacy-completed').completionSource, 'unknown');
  await validateReportReadiness(status, f.root, facts);
  const filename = path.join(f.root, 'reports/qwen-work-reports.json');
  const saved = readFileSync(filename, 'utf8');
  rmSync(filename);
  await assert.rejects(validateReportReadiness(status, f.root, facts), /persisted/);
  writeFileSync(filename, '{}');
  await assert.rejects(validateReportReadiness(status, f.root, facts), /Invalid work report cache/);
  writeFileSync(filename, saved);
  const different = structuredClone(status);
  different.providers.find(group => group.provider === 'codex').tasks[0].quote = 'unpersisted';
  await assert.rejects(validateReportReadiness(different, f.root, facts), /differs/);
  await assert.rejects(validateReportReadiness({ ...status, phase: 'unavailable' }, f.root, facts), /not ready/);
  await assert.rejects(validateReportReadiness({ ...status, error: 'save failed' }, f.root, facts), /not ready/);
  const changedSource = structuredClone(facts);
  changedSource.find(task => task.id === 'legacy-completed').completionSource = 'agent';
  await assert.rejects(validateReportReadiness(status, f.root, changedSource), /source is stale/);
  await assert.rejects(validateReportReadiness(status, f.root), /source snapshot is unavailable/);
});


test('a transient rollback status failure never releases an unverified deployment', async t => {
  const options = {};
  const f = fixture(t, options);
  await assert.rejects(f.deploy({ verifyLive: async () => {
    options.failBoardOnce = true;
    throw new Error('verification failed');
  } })(), /transient rollback board failure/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.target);
  assert.equal(f.store.snapshot().maintenance.active, true);
  assert.equal(f.released, 0);
  assert.throws(() => acquireDeploymentLock(f.root), /interrupted deployment/);
});

test('an interrupted Git merge leaves the gate and lock closed for manual recovery', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'main-only'), 'main advance\n');
  f.git('add', 'main-only'); f.git('commit', '-m', 'main advance');
  const before = f.git('rev-parse', 'HEAD');
  const hook = f.git('rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-merge-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(f.deploy()(), /merge command failed before confirming HEAD/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.store.snapshot().maintenance.active, true);
  assert.equal(f.released, 0);
  assert.throws(() => acquireDeploymentLock(f.root), /interrupted deployment/);
});
