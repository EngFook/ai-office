import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

// Optional owner-maintained project list. Worktree aliases affect presentation
// and filtering only, never execution paths, project locks or task history.
export function readProjectCatalog(home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), { includeStoryStudio = false } = {}) {
  try {
    const input = JSON.parse(readFileSync(path.join(home, 'project-catalog.json'), 'utf8'));
    if (!Array.isArray(input) || input.length > 100) return [];
    const ids = new Set();
    return input.map(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) throw new Error('Invalid project');
      ids.add(item.id);
      const folders = [item.path, ...(item.folders || [])];
      if (folders.length > 1000 || folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder))) throw new Error('Invalid folder');
      const storyStudio = includeStoryStudio && item.storyStudio && typeof item.storyStudio === 'object' && !Array.isArray(item.storyStudio) ? { storyStudio: item.storyStudio } : {};
      return { id:item.id, name:item.name.trim(), path:path.normalize(item.path), folders:[...new Set(folders.map(folder=>path.normalize(folder)))], ...storyStudio };
    });
  } catch { return []; }
}

const catalogError = (message, status = 400) => Object.assign(new Error(message), { status, statusCode: status });
const directoryPath = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw catalogError('项目路径必须是绝对目录 / Choose an absolute project folder.');
  try { const resolved = realpathSync(value); if (!lstatSync(resolved).isDirectory()) throw new Error(); return resolved; }
  catch { throw catalogError('项目目录不存在或无法访问 / Project folder does not exist or cannot be accessed.'); }
};

// SQLite holds the write gate for the entire update and releases it even if the
// process is killed. No PID-only lock is left behind by a new registration.
function withCatalogWrite(home, action) {
  const filename = path.join(home, 'project-catalog-lock.sqlite');
  let db, transaction = false;
  try {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { const stat = lstatSync(filename + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe lock'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(filename); chmodSync(filename, 0o600);
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE'); transaction = true;
    // Compatibility with a previously written owner lock: recover only a
    // verified dead PID, under the same transactional gate. Never guess by age.
    const legacy = path.join(home, 'project-catalog.write.lock');
    try {
      const stat = lstatSync(legacy);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Unsafe legacy lock');
      const owner = JSON.parse(readFileSync(legacy, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.token)) throw new Error('Invalid legacy lock');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
      if (!dead) throw new Error('Active or uncertain owner');
      unlinkSync(legacy);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    db?.close();
    throw catalogError('项目目录正在更新或写入锁无法安全验证，请稍后重试 / Project catalog is busy or its lock cannot be verified safely.', 409);
  }
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

/** Register an existing folder; does not create files in the project or start any worker. */
export function createRegisteredProject(input, { home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office') } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'path'].includes(key))) throw catalogError('项目参数无效 / Invalid project input.');
  const folder = directoryPath(input.path);
  const name = input.name === undefined || input.name === '' ? path.basename(folder) || folder : input.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw catalogError('项目名称无效 / Enter a valid project name.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'project-catalog.json');
  return withCatalogWrite(home, () => {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    let entries = [];
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe catalog');
      entries = JSON.parse(readFileSync(file, 'utf8'));
      // A malformed existing catalog must never be replaced by an empty one.
      if (!Array.isArray(entries) || entries.length > 100 || readProjectCatalog(home, { includeStoryStudio: true }).length !== entries.length) throw new Error('Invalid catalog');
    } catch (error) {
      if (error.code !== 'ENOENT') throw catalogError('现有项目目录无法安全读取，未覆盖 / Existing project catalog cannot be read safely; nothing was replaced.', 409);
    }
    const sameFolder = value => { try { return realpathSync(value) === folder; } catch { return path.normalize(value) === folder; } };
    const existing = entries.find(entry => [entry.path, ...(entry.folders || [])].some(sameFolder));
    if (existing) return { project: readProjectCatalog(home, { includeStoryStudio: true }).find(item => item.id === existing.id), created: false };
    if (entries.length >= 100) throw catalogError('已达到 100 个注册项目上限 / The project catalog supports up to 100 registered projects.', 409);
    const project = { id: `project-${randomUUID()}`, name: name.trim(), path: folder, folders: [folder] };
    writeFileSync(temporary, JSON.stringify([...entries, project], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return { project, created: true };
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  });
}
