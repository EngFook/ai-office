#!/usr/bin/env node
import { DatabaseSync, backup } from 'node:sqlite';
import { constants, lstatSync, realpathSync, readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, unlinkSync, rmSync, rmdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_LIMIT = 512 * 1024 * 1024;
const REPORT_LIMIT = 16 * 1024 * 1024;
const REPORTS = ['reports/qwen-watch.json', 'reports/qwen-work-reports.json', 'reports/meetings/live.json', 'reports/grok-quota.json'];
const LOCKS = ['office-runner.lock', 'office-runner.pid', 'runner.lock', 'runner.pid'];
const fail = message => { throw new Error(`办公室迁移：${message}`); };
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const entryExists = file => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function directory(value, label, { missing = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} 必须是有效目录。`);
  const absolute = path.resolve(value);
  if (entryExists(absolute)) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} 必须是普通目录，不能是符号链接。`);
    return realpathSync(absolute);
  }
  if (!missing) fail(`${label} 不存在。`);
  const suffix = [];
  let ancestor = absolute;
  while (!entryExists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  if (!lstatSync(ancestor).isDirectory() || lstatSync(ancestor).isSymbolicLink()) fail(`${label} 的父目录必须是普通目录。`);
  return path.join(realpathSync(ancestor), ...suffix);
}
function noRunner(root) {
  for (const name of LOCKS) if (entryExists(path.join(root, name))) fail('检测到运行锁；请先停止办公室。陈旧锁也需要人工核实，迁移不会清理它。');
}
function safeFile(root, relative, limit, required = false) {
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    if (!entryExists(current)) { if (required) fail(`缺少 ${relative}。`); return null; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`${relative} 含符号链接，拒绝迁移。`);
    if (current !== path.join(root, relative) && !stat.isDirectory()) fail(`${relative} 的父目录无效。`);
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > limit) fail(`${relative} 不是安全的普通文件或超过大小限制。`);
  return { source: current, relative, bytes: stat.size, limit };
}

/** Only examines an explicit legacy data directory; never loads app services or credentials. */
export function planOfficeMigration({ from, to, legacyProject } = {}) {
  const source = directory(from, '源目录');
  const destination = directory(to, '目标目录', { missing: true });
  if (contains(source, destination) || contains(destination, source)) fail('源目录和目标目录必须分离，不能相同或互相嵌套。');
  noRunner(source); noRunner(destination);
  if (existsSync(destination) && readdirSync(destination).length) fail('目标目录必须为空；不会覆盖现有数据。');
  const database = safeFile(source, 'board.sqlite', DB_LIMIT, true);
  const wal = safeFile(source, 'board.sqlite-wal', DB_LIMIT);
  // SHM is inspected for safety but not copied; SQLite regenerates it only in our staging directory.
  safeFile(source, 'board.sqlite-shm', DB_LIMIT);
  const journal = safeFile(source, 'board.sqlite-journal', DB_LIMIT);
  if (journal?.bytes) fail('源库存在事务日志，请先正常关闭旧办公室；迁移不会恢复或修改源库。');
  const files = [];
  const usage = safeFile(source, 'local-qwen-usage.json', REPORT_LIMIT);
  if (usage) files.push(usage);
  const project = legacyProject ? directory(legacyProject, '旧项目目录') : null;
  if (project) {
    noRunner(project);
    for (const relative of REPORTS) { const item = safeFile(project, relative, REPORT_LIMIT); if (item) files.push(item); }
  }
  return { source, destination, legacyProject: project, database, wal, files,
    excluded: '不迁移凭据、环境变量、API key、登录会话、mobile-access、webhook 投递身份或 config.json。配置请另用 setup --from；AI 登录留在原机，换机后自行登录。' };
}

/** Read-only staging of the source, then SQLite backup. No task recovery or schema migration occurs. */
export async function migrateOffice(options = {}) {
  const plan = planOfficeMigration(options);
  if (!options.apply) return { ...plan, applied: false };
  const temporary = mkdtempSync(path.join(tmpdir(), 'office-migration-'));
  chmodSync(temporary, 0o700);
  let db, targetLock, targetCreated = false;
  const written = [], createdDirectories = [];
  try {
    const originals = [plan.database, ...(plan.wal ? [plan.wal] : []), ...plan.files];
    const fingerprints = new Map(originals.map(file => [file.source, digest(file.source)]));
    const stagedDatabase = path.join(temporary, 'source.sqlite');
    copyFileSync(plan.database.source, stagedDatabase, constants.COPYFILE_EXCL);
    if (plan.wal) copyFileSync(plan.wal.source, `${stagedDatabase}-wal`, constants.COPYFILE_EXCL);
    const prepared = path.join(temporary, 'prepared'); mkdirSync(prepared, { mode: 0o700 });
    for (const file of plan.files) {
      const target = path.join(prepared, file.relative);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(file.source, target, constants.COPYFILE_EXCL);
      if (digest(target) !== fingerprints.get(file.source)) fail('源文件在迁移期间改变，已取消。');
    }
    if (digest(stagedDatabase) !== fingerprints.get(plan.database.source) || (plan.wal && digest(`${stagedDatabase}-wal`) !== fingerprints.get(plan.wal.source))) fail('源数据库在迁移期间改变，已取消。');
    db = new DatabaseSync(stagedDatabase, { readOnly: true });
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('数据库完整性检查失败。');
    const backedUp = path.join(prepared, 'board.sqlite');
    await backup(db, backedUp);
    db.close(); db = null;
    // Revalidate safety and content immediately before publishing. No source lock is created.
    const checked = planOfficeMigration(options);
    if (!!checked.wal !== !!plan.wal || checked.files.length !== plan.files.length) fail('源文件集合已改变，已取消。');
    for (const file of originals) if (digest(file.source) !== fingerprints.get(file.source)) fail('源文件在迁移期间改变，已取消。');
    if (!existsSync(plan.destination)) { mkdirSync(plan.destination, { recursive: true, mode: 0o700 }); targetCreated = true; }
    const lockFile = path.join(plan.destination, 'office-runner.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, purpose: 'offline-migration' }), { flag: 'wx', mode: 0o600 });
    targetLock = lockFile;
    for (const relative of ['board.sqlite', ...plan.files.map(file => file.relative)]) {
      const destination = path.join(plan.destination, relative), parent = path.dirname(destination);
      if (!existsSync(parent)) {
        const absent = []; let current = parent;
        while (!existsSync(current)) { absent.push(current); current = path.dirname(current); }
        mkdirSync(parent, { recursive: true, mode: 0o700 }); createdDirectories.push(...absent.reverse());
      }
      copyFileSync(path.join(prepared, relative), destination, constants.COPYFILE_EXCL);
      written.push(destination); chmodSync(destination, 0o600);
    }
    noRunner(plan.source);
    unlinkSync(targetLock); targetLock = null;
    return { ...plan, applied: true, copied: ['board.sqlite', ...plan.files.map(file => file.relative)] };
  } catch (error) {
    for (const file of written.reverse()) { try { unlinkSync(file); } catch {} }
    for (const dir of createdDirectories.reverse()) { try { rmdirSync(dir); } catch {} }
    if (targetLock) { try { unlinkSync(targetLock); } catch {} }
    if (targetCreated) { try { rmdirSync(plan.destination); } catch {} }
    throw error;
  } finally { if (db?.isOpen) db.close(); rmSync(temporary, { recursive: true, force: true }); }
}

export async function runMigrationCLI(argv = process.argv.slice(2), output = process.stdout) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help') { output.write('用法：node scripts/migrate-office.mjs --from 旧数据目录 --to 新空目录 [--legacy-project 旧项目目录] [--apply]\n默认只显示迁移计划；--apply 才复制。先关闭旧办公室。不会复制账号或凭据。\n'); return null; }
    if (flag === '--apply') { options.apply = true; continue; }
    if (!['--from', '--to', '--legacy-project'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('参数无效，请使用 --help。');
    options[flag === '--legacy-project' ? 'legacyProject' : flag.slice(2)] = argv[++index];
  }
  const result = await migrateOffice(options);
  output.write(`${result.applied ? '迁移已完成' : '仅预览，未写入任何文件'}\n源目录：${result.source}\n目标目录：${result.destination}\n`);
  for (const relative of ['board.sqlite', ...result.files.map(file => file.relative)]) output.write(`  ${relative}\n`);
  output.write(`${result.excluded}\n原任务和设置原样保留；新办公室仍需独立设置，建议先用 read-only 检查。\n`);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMigrationCLI().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
