import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, copyFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { taskBoardBridge } from './task-board-bridge.mjs';
import { publicOfficeConfig } from './office-config.mjs';

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

// A stale lock fails closed: verify the old process exited before removing it.
export function acquireOfficeLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'office-runner.lock'), token = randomUUID();
  let fd;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('此数据目录已有运行锁。请先停止原办公室；异常退出后确认旧进程已结束，再移除 office-runner.lock。'); throw error; }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    process.removeListener('exit', release);
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch {}
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
      getRuntimeStatus: () => ({ started: false, running: [], agents: [], providers }),
    }).configureServer(server);
    server.httpServer?.once('close', () => store?.close());
  };
  return { name: 'ai-office-paused', configureServer: install, configurePreviewServer: install, closeBundle() { store?.close(); store = null; } };
}

export const stoppedService = (status = {}) => ({ start() {}, stop() {}, kick() {}, status: () => ({ phase: 'stopped', connected: false, agents: [], skills: [], ...status }) });
