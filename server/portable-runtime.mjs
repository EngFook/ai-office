import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, copyFileSync, statSync, lstatSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { taskBoardBridge } from './task-board-bridge.mjs';
import { publicOfficeConfig } from './office-config.mjs';
import { readProjectCatalog } from './project-catalog.mjs';

export function readonlyStore(dataDir) {
  const filename = path.join(dataDir, 'board.sqlite');
  return { close() {}, snapshot() {
    // SQLite readOnly may still create a WAL shared-memory file. Read a private
    // staging copy instead, never open the user's database with SQLite here.
    const temporary = mkdtempSync(path.join(tmpdir(), 'office-view-'));
    let db;
    try {
      if (existsSync(filename)) {
        const files = [filename, `${filename}-wal`].filter(existsSync);
        const before = files.map(file => statSync(file));
        for (const file of files) copyFileSync(file, path.join(temporary, path.basename(file)));
        for (let i = 0; i < files.length; i++) {
          const after = statSync(files[i]);
          if (after.size !== before[i].size || after.mtimeMs !== before[i].mtimeMs || after.ino !== before[i].ino) throw new Error('数据库正在更新，请稍后刷新。');
        }
        if (!files.includes(`${filename}-wal`) && existsSync(`${filename}-wal`)) throw new Error('数据库正在更新，请稍后刷新。');
        db = new DatabaseSync(path.join(temporary, 'board.sqlite'), { readOnly: true });
      }
      const rows = (table, order = 'rowid DESC') => {
        if (!db || !db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)) return [];
        return db.prepare(`SELECT record FROM ${table} ORDER BY ${order}`).all().map(row => JSON.parse(row.record));
      };
      const tasks = rows('tasks');
      return { tasks: tasks.filter(t => t.status !== 'deleted'), deletedTasks: tasks.filter(t => t.status === 'deleted'),
        roles: rows('roles', 'id'), instructions: rows('instructions'),
        humanRequests: rows('human_requests').filter(q => !tasks.some(t => t.id === q.taskId && t.status === 'deleted')),
        settings: rows('settings')[0] || { autoPickup: false }, updatedAt: new Date().toISOString() };
    } finally { db?.close(); rmSync(temporary, { recursive: true, force: true }); }
  } };
}

const lockError = () => new Error('此数据目录已有运行锁，或旧锁无法安全验证。请先停止原办公室；损坏的锁须人工检查。');

// The gate is held only while changing ownership. SQLite releases it on crash,
// so two new processes cannot both replace the same verified-dead owner.
function withOfficeLockGate(dataDir, action) {
  const filename = path.join(dataDir, 'office-runner-gate.sqlite');
  let db, transaction = false;
  try {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const stat = lstatSync(filename + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw lockError();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(filename); chmodSync(filename, 0o600);
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE'); transaction = true;
    const result = action();
    db.exec('COMMIT'); transaction = false;
    return result;
  } catch {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    throw lockError();
  } finally { db?.close(); }
}

function readOfficeLock(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw lockError();
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.token)) throw lockError();
    return owner;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Recovery requires a well-formed owner whose PID is proven absent. Age, an
// inaccessible process and PID reuse never authorize replacing a live owner.
export function acquireOfficeLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'office-runner.lock'), token = randomUUID();
  withOfficeLockGate(dataDir, () => {
    const owner = readOfficeLock(file);
    if (owner) {
      let exited = false;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') exited = true; }
      if (!exited) throw lockError();
      unlinkSync(file);
    }
    // Exclusive creation also respects older office/migration processes that
    // use this owner file but do not yet participate in the SQLite gate.
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
    finally { closeSync(fd); }
  });
  let released = false;
  const release = () => {
    if (released) return;
    try {
      withOfficeLockGate(dataDir, () => {
        const owner = readOfficeLock(file);
        if (owner?.pid === process.pid && owner.token === token) unlinkSync(file);
      });
    } catch { return; } // Keep the exit retry; never remove an uncertain owner.
    released = true;
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

export function pausedOfficeServices(configuration) {
  let store;
  const install = server => {
    store = readonlyStore(configuration.dataDir);
    const providers = Object.fromEntries(Object.entries(configuration.providers).map(([id, item]) => [id, {
      available: false, authenticated: false, enabled: item.enabled, reason: '办公室处于只查看模式。',
    }]));
    taskBoardBridge({ store, readOnly: true, configuration: publicOfficeConfig(configuration),
      meetingFile: path.join(configuration.dataDir, 'reports/meetings/live.json'),
      getProjectCatalog: () => readProjectCatalog(configuration.dataDir),
      getRuntimeStatus: () => ({ started: false, running: [], agents: [], providers }),
    }).configureServer(server);
    server.httpServer?.once('close', () => store?.close());
  };
  return { name: 'ai-office-paused', configureServer: install, configurePreviewServer: install, closeBundle() { store?.close(); store = null; } };
}

export const stoppedService = (status = {}) => ({ start() {}, stop() {}, kick() {}, status: () => ({ phase: 'stopped', connected: false, agents: [], skills: [], ...status }) });
