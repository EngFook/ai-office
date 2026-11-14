import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, truncateSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { planOfficeMigration, migrateOffice, runMigrationCLI } from '../scripts/migrate-office.mjs';

function fixture(t, { wal = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-migration-test-'));
  const from = path.join(root, 'old'), to = path.join(root, 'new'), legacyProject = path.join(root, 'project');
  mkdirSync(from); mkdirSync(legacyProject);
  const database = path.join(from, 'board.sqlite');
  const db = new DatabaseSync(database);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,record TEXT,lease_until INTEGER); CREATE TABLE settings(id TEXT PRIMARY KEY,record TEXT); CREATE TABLE human_requests(id TEXT PRIMARY KEY,record TEXT);');
  const task = { id: 'legacy-task', status: 'running', title: '旧任务', projectPath: '/custom/project', version: 9, assignee: { provider: 'claude' } };
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, JSON.stringify(task), 1);
  db.prepare('INSERT INTO settings VALUES(?,?)').run('office', JSON.stringify({ autoPickup: true, theme: 'bright' }));
  db.prepare('INSERT INTO human_requests VALUES(?,?)').run('question', JSON.stringify({ state: 'denied', answer: '不批准' }));
  if (!wal) db.close();
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, from, to, legacyProject, task, database, db };
}
function fingerprint(directory) { return Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(path.join(directory, name)).toString('base64')])); }

test('default plan writes nothing and excludes identity/credentials/config', async t => {
  const f = fixture(t);
  for (const name of ['config.json', '.env', 'mobile-access.json', 'grok-webhook.json', 'session.json']) writeFileSync(path.join(f.from, name), 'private-content');
  const before = fingerprint(f.from);
  const result = await migrateOffice(f);
  assert.equal(result.applied, false);
  assert.equal(existsSync(f.to), false);
  assert.deepEqual(fingerprint(f.from), before);
  assert.deepEqual(result.files, []);
});

test('explicit apply preserves every task/settings/question record without recovery or source writes', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.from, 'local-qwen-usage.json'), JSON.stringify({ count: 7 }));
  writeFileSync(path.join(f.from, 'config.json'), '{"mode":"enabled"}');
  const before = fingerprint(f.from);
  const result = await migrateOffice({ ...f, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual(fingerprint(f.from), before);
  const copied = new DatabaseSync(path.join(f.to, 'board.sqlite'), { readOnly: true });
  try {
    const row = copied.prepare('SELECT * FROM tasks').get();
    assert.deepEqual(JSON.parse(row.record), f.task);
    assert.equal(row.lease_until, 1);
    assert.deepEqual(JSON.parse(copied.prepare('SELECT record FROM settings').get().record), { autoPickup: true, theme: 'bright' });
    assert.deepEqual(JSON.parse(copied.prepare('SELECT record FROM human_requests').get().record), { state: 'denied', answer: '不批准' });
  } finally { copied.close(); }
  assert.equal(existsSync(path.join(f.to, 'config.json')), false);
  assert.equal(existsSync(path.join(f.to, 'office-runner.lock')), false);
  assert.equal(statSync(path.join(f.to, 'board.sqlite')).mode & 0o777, 0o600);
});

test('WAL contents are consistently backed up and even source SHM bytes stay unchanged', async t => {
  const f = fixture(t, { wal: true });
  assert.ok(existsSync(`${f.database}-wal`));
  const before = fingerprint(f.from);
  await migrateOffice({ ...f, apply: true });
  assert.deepEqual(fingerprint(f.from), before);
  const copied = new DatabaseSync(path.join(f.to, 'board.sqlite'), { readOnly: true });
  try { assert.equal(copied.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1); }
  finally { copied.close(); }
});

test('reports are copied only with explicit legacy-project option and exact whitelist', async t => {
  const f = fixture(t);
  mkdirSync(path.join(f.legacyProject, 'reports', 'meetings'), { recursive: true });
  const names = ['qwen-watch.json', 'qwen-work-reports.json', 'grok-quota.json', 'meetings/live.json'];
  for (const name of names) writeFileSync(path.join(f.legacyProject, 'reports', name), '{"state":"kept"}');
  writeFileSync(path.join(f.legacyProject, 'reports', 'credentials.json'), 'not copied');
  const withoutProject = await migrateOffice({ from: f.from, to: f.to });
  assert.equal(withoutProject.files.length, 0);
  const result = await migrateOffice({ ...f, apply: true });
  assert.equal(result.files.length, 4);
  assert.equal(readFileSync(path.join(f.to, 'reports', 'meetings', 'live.json'), 'utf8'), '{"state":"kept"}');
  assert.equal(existsSync(path.join(f.to, 'reports', 'credentials.json')), false);
});

test('refuses source or target runner locks, including stale locks, without deleting them', async t => {
  const f = fixture(t);
  const lock = path.join(f.from, 'office-runner.lock');
  writeFileSync(lock, '{"pid":9999999}');
  await assert.rejects(migrateOffice({ ...f, apply: true }), /运行锁/);
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":9999999}');
  rmSync(lock); mkdirSync(f.to); writeFileSync(path.join(f.to, 'office-runner.lock'), 'keep');
  await assert.rejects(migrateOffice({ ...f, apply: true }), /运行锁/);
  assert.equal(readFileSync(path.join(f.to, 'office-runner.lock'), 'utf8'), 'keep');
});

test('refuses overlap, nonempty destinations and symlinked source/destination', t => {
  const f = fixture(t);
  assert.throws(() => planOfficeMigration({ from: f.from, to: f.from }), /分离/);
  assert.throws(() => planOfficeMigration({ from: f.from, to: path.join(f.from, 'nested') }), /分离/);
  mkdirSync(f.to); writeFileSync(path.join(f.to, 'existing'), 'keep');
  assert.throws(() => planOfficeMigration(f), /必须为空/);
  const link = path.join(f.root, 'linked'); symlinkSync(f.from, link);
  assert.throws(() => planOfficeMigration({ from: link, to: path.join(f.root, 'another') }), /符号链接/);
  assert.throws(() => planOfficeMigration({ from: f.from, to: link }), /符号链接/);
});

test('refuses symlinked reports and database sidecars', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.legacyProject, 'reports'));
  const other = path.join(f.root, 'private.json'); writeFileSync(other, 'private');
  symlinkSync(other, path.join(f.legacyProject, 'reports', 'qwen-watch.json'));
  assert.throws(() => planOfficeMigration(f), /符号链接/);
  symlinkSync(other, `${f.database}-wal`);
  assert.throws(() => planOfficeMigration({ from: f.from, to: f.to }), /符号链接/);
});

test('refuses oversized files before creating destination and rejects hot rollback journal', async t => {
  const f = fixture(t);
  const usage = path.join(f.from, 'local-qwen-usage.json');
  writeFileSync(usage, ''); truncateSync(usage, 17 * 1024 * 1024);
  await assert.rejects(migrateOffice({ ...f, apply: true }), /大小限制/);
  assert.equal(existsSync(f.to), false);
  rmSync(usage); writeFileSync(`${f.database}-journal`, 'hot journal');
  await assert.rejects(migrateOffice({ ...f, apply: true }), /事务日志/);
});

test('invalid SQLite aborts without any destination or source changes', async t => {
  const f = fixture(t);
  writeFileSync(f.database, 'invalid database');
  const before = fingerprint(f.from);
  await assert.rejects(migrateOffice({ ...f, apply: true }));
  assert.equal(existsSync(f.to), false);
  assert.deepEqual(fingerprint(f.from), before);
});

test('CLI plan does not print credential contents or mutate anything', async t => {
  const f = fixture(t), output = { value: '', write(value) { this.value += value; } };
  writeFileSync(path.join(f.from, '.env'), 'SECRET=value-that-must-not-print');
  await runMigrationCLI(['--from', f.from, '--to', f.to], output);
  assert.match(output.value, /仅预览/);
  assert.equal(output.value.includes('value-that-must-not-print'), false);
  assert.equal(existsSync(f.to), false);
});
