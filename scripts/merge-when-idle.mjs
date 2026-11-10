#!/usr/bin/env node
// Run outside a board task. Live must already support maintenance protocol 1.
// Maintenance blocks every claim through backup, merge, checks and rollback.
// It is persistent across server restarts and never changes autoPickup.
//   node scripts/merge-when-idle.mjs start|run <branch> [--check /api/...]
// Set AI_OFFICE_LIVE when invoking this script from an isolated worktree.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, existsSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkReportFile, validateWorkExtract, WORK_REPORT_PROVIDERS } from '../server/qwen-work-reports.mjs';

const MINUTE = 60000;
const PROTOCOL = 1;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runningCount(board) {
  if (!Array.isArray(board?.tasks) || !Array.isArray(board?.runtime?.running) || board.runtime.available === false) throw new Error('task/runtime status is unavailable');
  const decisions = board.runtime.watchDecisions;
  if (decisions !== undefined && !Array.isArray(decisions)) throw new Error('watch decision status is unavailable');
  return Math.max(board.tasks.filter(task => task?.status === 'running').length, board.runtime.running.length) + (decisions?.length || 0);
}

export function mergePlan({ liveBranch, clean, isAncestor, conflictFree }) {
  if (liveBranch !== 'main') return { ok: false, reason: `live is on ${liveBranch || 'a detached HEAD'}, not main` };
  if (!clean) return { ok: false, reason: 'live has uncommitted tracked changes' };
  if (isAncestor) return { ok: true, mode: 'ff-only' };
  if (conflictFree) return { ok: true, mode: 'merge' };
  return { ok: false, reason: 'main advanced and the merge has conflicts; reintegrate in a worktree first' };
}

export function parseArgs(argv) {
  const [command, branch, ...rest] = argv;
  if (!['start', 'run'].includes(command)) throw new Error('Use: merge-when-idle.mjs start|run <branch> [--check <api-path>]...');
  if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch) || branch.includes('..')) throw new Error('A valid branch name is required.');
  const checks = [];
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] !== '--check' || !/^\/api\/[A-Za-z0-9/_-]+$/.test(rest[index + 1] || '')) throw new Error('Only --check /api/... options are accepted.');
    checks.push(rest[++index]);
  }
  return { command, branch, checks };
}

// Both symlink aliases and separate invocations for the same live checkout use
// this single Git-directory lock. Never steal stale locks automatically.
export function acquireDeploymentLock(root, ownerToken = randomUUID()) {
  root = realpathSync(root);
  const directory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'idle-merge.lock'], { cwd: root, encoding: 'utf8' }).trim();
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`another deployment or interrupted deployment owns ${directory}; inspect it before manual recovery`); throw error; }
  const filename = path.join(directory, 'owner.json');
  try { writeFileSync(filename, JSON.stringify({ ownerToken, pid: process.pid, root, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return { ownerToken, directory, release() {
    if (JSON.parse(readFileSync(filename, 'utf8')).ownerToken !== ownerToken) throw new Error('deployment lock ownership changed; refusing to remove it');
    rmSync(directory, { recursive: true });
  } };
}

// HTTP 200 is insufficient: require a healthy published batch and verify the
// same extracts can actually be read back from the on-disk report cache.
export async function validateReportReadiness(report, root, sourceTasks) {
  if (!Array.isArray(sourceTasks)) throw new Error('work report source snapshot is unavailable');
  if (!['ready', 'backfill'].includes(report?.phase) || report.error || !Number.isFinite(Date.parse(report.generatedAt)) || !Array.isArray(report.providers)) throw new Error('work reports are not ready or persistence failed');
  const providers = report.providers.map(group => group.provider);
  if (providers.length !== WORK_REPORT_PROVIDERS.length || !WORK_REPORT_PROVIDERS.every(provider => providers.includes(provider))) throw new Error('work report provider groups are incomplete');
  const tasks = report.providers.flatMap(group => {
    if (!Array.isArray(group.tasks)) throw new Error('invalid work report tasks');
    return group.tasks.filter(task => task.extracted === true).map(task => {
      const source = sourceTasks.find(source => source.id === task.id && source.status === 'done' && (source.assignee?.provider || source.provider) === group.provider);
      if (!source || source.title !== task.title || (source.result || '') !== task.sourceResult || source.updatedAt !== task.completedAt || (source.completionSource || 'unknown') !== task.completionSource) throw new Error('published work report source is stale');
      return { published: task, source };
    });
  });
  const saved = await createWorkReportFile(root).read();
  if (!tasks.length || !saved || saved.generatedAt !== report.generatedAt) throw new Error('no matching persisted work report batch');
  const entries = tasks.map(({ published }) => {
    const entry = saved.entries.find(entry => entry.id === published.id);
    if (!entry || entry.quote !== published.quote || JSON.stringify(entry.files) !== JSON.stringify(published.files)) throw new Error('published work report differs from persisted cache');
    return entry;
  });
  // Use raw board records: the report API renders absent completionSource as
  // "unknown", which must not alter the original persisted fingerprint.
  const validated = validateWorkExtract({ entries }, tasks.map(task => task.source));
  if (validated.some((entry, index) => entry.fingerprint !== entries[index].fingerprint)) throw new Error('persisted work report source is stale');
}

export function createDeployer({ root, branch, checks = [], base = 'http://127.0.0.1:5173', log = () => {}, env = process.env,
  fetchImpl = fetch, sleep = delay, backupRoot = path.join(homedir(), 'Developer', 'aio-backups'),
  verifyLive, timing = {} }) {
  root = realpathSync(root);
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('office URL must be a loopback HTTP origin');
  base = url.origin;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };
  const request = async (route, init = {}) => {
    const response = await fetchImpl(`${base}${route}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    return body;
  };
  const board = () => request('/api/office/board');
  const maintenance = async (ownerToken, release = false) => {
    const { csrfToken } = await board();
    const result = await request(`/api/office/maintenance${release ? '/release' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Office-Token': csrfToken }, body: JSON.stringify({ ownerToken }) });
    if (result?.maintenance?.protocol !== PROTOCOL || result.maintenance.active !== !release) throw new Error('maintenance protocol acknowledgement is missing');
  };
  const assertMaintenance = value => {
    if (value?.maintenance?.protocol !== PROTOCOL || value.maintenance.active !== true) throw new Error('live maintenance gate is not active');
    return value;
  };
  const gate = target => mergePlan({
    liveBranch: gitOk('symbolic-ref', '-q', 'HEAD') ? git('rev-parse', '--abbrev-ref', 'HEAD') : null,
    clean: gitOk('diff', '--quiet', 'HEAD', '--'),
    isAncestor: gitOk('merge-base', '--is-ancestor', 'HEAD', target),
    conflictFree: gitOk('merge-tree', '--write-tree', 'HEAD', target),
  });
  const waitFor = async (label, test, { every, limit }) => {
    const until = Date.now() + limit;
    for (;;) {
      let result;
      try { result = await test(); } catch (error) { result = { done: false, note: error.message }; }
      if (result.done) return result;
      if (Date.now() >= until) throw new Error(`${label} timed out (${result.note || 'not ready'})`);
      await sleep(every);
    }
  };
  const runInLive = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * MINUTE });
  const supportsMaintenance = tree => {
    // Protocol marker is a compatibility promise: neither deployment nor
    // rollback may load a task store which ignores the persistent claim gate.
    if (!/export const MAINTENANCE_PROTOCOL = 1;/.test(git('show', `${tree}:server/task-store.mjs`)) || !git('show', `${tree}:server/task-board-bridge.mjs`).includes("'/api/office/maintenance'")) throw new Error('live and candidate must both support maintenance protocol 1; install the gate in a separately approved idle window first');
  };
  const assertHead = expected => {
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main' || git('rev-parse', 'HEAD') !== expected || !gitOk('diff', '--quiet', 'HEAD', '--')) throw new Error('live branch, HEAD or tracked files changed; refusing to overwrite concurrent work');
  };

  return async function deploy({ gateHours = 24, drainHours = 8 } = {}) {
    const lock = acquireDeploymentLock(root);
    let requested = false, released = false, merged = null;
    try {
      const target = git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
      log(`waiting for live to be mergeable for ${branch} (${target.slice(0, 7)})`);
      await waitFor('waiting for live main', () => { const plan = gate(target); return { done: plan.ok, note: plan.reason }; }, { every: timing.gateEvery ?? MINUTE, limit: gateHours * 60 * MINUTE });
      supportsMaintenance('HEAD');
      // Set before the request: a committed acquisition may lose its response.
      requested = true;
      await maintenance(lock.ownerToken);
      log('maintenance acquired; waiting for running tasks to finish (autoPickup unchanged)');
      await waitFor('waiting for zero running tasks', async () => { const count = runningCount(assertMaintenance(await board())); return { done: count === 0, note: `${count} running` }; }, { every: timing.drainEvery ?? 30000, limit: drainHours * 60 * MINUTE });
      const before = git('rev-parse', 'HEAD');
      const plan = gate(target);
      if (!plan.ok) throw new Error(`not merging: ${plan.reason}`);
      const candidate = plan.mode === 'ff-only' ? target : git('merge-tree', '--write-tree', before, target).split('\n')[0];
      supportsMaintenance(candidate);

      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backup = mkdtempSync(path.join(backupRoot, 'idle-merge-'));
      git('bundle', 'create', path.join(backup, 'before.bundle'), '--all');
      runInLive('tar', ['-czf', path.join(backup, 'live-source.tgz'), '--exclude', './node_modules', '--exclude', './dist', '--exclude', './.worktrees', '.']);
      const db = path.join(env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), 'board.sqlite');
      if (existsSync(db)) execFileSync('sqlite3', [db, `.backup '${path.join(backup, 'board.sqlite').replace(/'/g, "''")}'`]);
      log(`backup written to ${backup}`);

      // Backups can take minutes. The persistent gate is still held; repeat all
      // mutable checks immediately before Git writes, using the pinned target.
      if (runningCount(assertMaintenance(await board())) !== 0) throw new Error('a task is running; not merging');
      assertHead(before);
      // A failed Git hook can leave an in-progress merge or even an updated
      // HEAD. Mark the unsafe interval before Git writes; retain maintenance
      // for manual recovery if the command cannot confirm its resulting HEAD.
      merged = { before, after: null };
      if (plan.mode === 'ff-only') git('merge', '--ff-only', target);
      else git('merge', '--no-ff', '--no-edit', target);
      merged.after = git('rev-parse', 'HEAD');
      log(`merged ${branch} (${plan.mode}) ${before.slice(0, 7)} -> ${merged.after.slice(0, 7)}`);
      if (git('rev-parse', 'HEAD^{tree}') !== git('rev-parse', `${candidate}^{tree}`)) throw new Error('merged tree differs from the checked candidate');
      await sleep(timing.restartDelay ?? 5000);
      await waitFor('waiting for the office to come back', async () => { assertMaintenance(await board()); return { done: true }; }, { every: timing.checkEvery ?? 5000, limit: timing.restartLimit ?? 5 * MINUTE });
      for (const route of checks) await waitFor(`checking ${route}`, async () => {
        const result = await request(route);
        if (route === '/api/office/work-reports') {
          const current = assertMaintenance(await board());
          if (runningCount(current) !== 0) throw new Error('task/runtime became active during report verification');
          await validateReportReadiness(result, root, current.tasks);
        }
        return { done: true };
      }, { every: timing.checkEvery ?? 10000, limit: timing.checkLimit ?? 3 * MINUTE });
      if (verifyLive) await verifyLive();
      else { runInLive('npm', ['test']); runInLive('npm', ['run', 'build']); }
      assertHead(merged.after);
      if (runningCount(assertMaintenance(await board())) !== 0) throw new Error('task/runtime became active during maintenance');
      log('live checks, npm test and npm run build passed');
      merged = null;
    } catch (error) {
      if (merged) {
        if (!merged.after) throw new Error(`merge command failed before confirming HEAD; maintenance retained for manual recovery: ${error.message}`);
        // Never reset a different deployment, branch switch or local edits.
        assertHead(merged.after);
        if (runningCount(assertMaintenance(await board())) !== 0) throw new Error(`rollback refused: task/runtime is active; original failure: ${error.message}`);
        log(`rolling back to ${merged.before.slice(0, 7)}: ${error.message}`);
        git('reset', '--hard', merged.before);
        await waitFor('waiting for rollback office', async () => { assertMaintenance(await board()); return { done: true }; }, { every: timing.checkEvery ?? 5000, limit: timing.restartLimit ?? 5 * MINUTE });
        assertHead(merged.before);
        merged = null;
      }
      throw error;
    } finally {
      if (merged) {
        log('deployment/rollback is unverified; maintenance and deployment lock retained for manual recovery');
      } else if (requested) {
        // Releasing an acquisition with a lost response is idempotent. If the
        // office cannot acknowledge cleanup, retain the local lock for recovery.
        await waitFor('releasing maintenance', async () => { await maintenance(lock.ownerToken, true); return { done: true }; }, { every: timing.cleanupEvery ?? 10000, limit: timing.cleanupLimit ?? 10 * MINUTE });
        released = true;
        log('maintenance released; autoPickup was not modified');
      }
      if (!requested || released) lock.release();
    }
  };
}

async function main() {
  const { command, branch, checks } = parseArgs(process.argv.slice(2));
  const root = realpathSync(process.env.AI_OFFICE_LIVE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const logDir = path.join(homedir(), 'Developer', 'aio-backups');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, `idle-merge-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  if (command === 'start') {
    const out = openSync(logFile, 'a');
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', branch, ...checks.flatMap(route => ['--check', route])], { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, AI_OFFICE_LIVE: root } });
      child.on('error', error => process.stderr.write(`idle merge failed to start: ${error.message}\n`));
      child.unref();
      console.log(`Started idle merge for ${branch} (pid ${child.pid}); log: ${logFile}`);
    } finally { closeSync(out); }
    return;
  }
  const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  try { await createDeployer({ root, branch, checks, log, ...(process.env.AI_OFFICE_URL ? { base: process.env.AI_OFFICE_URL } : {}) })(); }
  catch (error) { log(`FAILED: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
