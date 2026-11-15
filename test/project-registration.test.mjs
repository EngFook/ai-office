import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegisteredProject, readProjectCatalog } from '../server/project-catalog.mjs';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-register-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'private office'), folder = path.join(root, '其他项目 无需 Git');
  mkdirSync(home); mkdirSync(folder);
  return { root, home, folder, file: path.join(home, 'project-catalog.json') };
}
test('registers arbitrary existing non-Git folders without changing project contents', t => {
  const f = fixture(t), result = createRegisteredProject({ path: f.folder }, f);
  assert.equal(result.created, true); assert.equal(result.project.name, '其他项目 无需 Git');
  assert.equal(result.project.path, realpathSync(f.folder)); assert.deepEqual(readdirSync(f.folder), []);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(readProjectCatalog(f.home).map(item => item.id), [result.project.id]);
});
test('equivalent paths and worktree aliases are idempotent and retain story configuration', t => {
  const f = fixture(t), alias = path.join(f.root, 'alias'); symlinkSync(f.folder, alias);
  const original = [{ id: 'original', name: 'Original', path: path.join(f.root, 'primary'), folders: [f.folder], storyStudio: { sourceFiles: ['story.md'], custom: true }, extra: 'preserve' }];
  writeFileSync(f.file, JSON.stringify(original)); const bytes = readFileSync(f.file, 'utf8');
  const result = createRegisteredProject({ path: alias, name: 'Do not rename' }, f);
  assert.equal(result.created, false); assert.equal(result.project.id, 'original');
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  const another = path.join(f.root, 'another'); mkdirSync(another);
  createRegisteredProject({ path: another, name: 'Another' }, f);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8'))[0], original[0]);
});
test('bad JSON, unsafe files and concurrent lock fail closed without data loss', t => {
  const f = fixture(t); writeFileSync(f.file, '{broken');
  assert.throws(() => createRegisteredProject({ path: f.folder }, f), error => error.status === 409);
  assert.equal(readFileSync(f.file, 'utf8'), '{broken');
  rmSync(f.file); const target = path.join(f.root, 'target'); writeFileSync(target, '[]'); symlinkSync(target, f.file);
  assert.throws(() => createRegisteredProject({ path: f.folder }, f), error => error.status === 409);
  assert.equal(readFileSync(target, 'utf8'), '[]');
  rmSync(f.file); writeFileSync(path.join(f.home, 'project-catalog.write.lock'), 'busy');
  assert.throws(() => createRegisteredProject({ path: f.folder }, f), error => error.status === 409);
});
test('rejects missing, relative or file paths before making office state', t => {
  const f = fixture(t); writeFileSync(path.join(f.root, 'file'), 'file');
  for (const folder of ['relative', path.join(f.root, 'missing'), path.join(f.root, 'file')]) {
    assert.throws(() => createRegisteredProject({ path: folder }, f), error => error.status === 400);
  }
  assert.throws(() => createRegisteredProject({ path: f.folder, name: 'bad\nname' }, f), /名称/);
  assert.deepEqual(readdirSync(f.home), []);
});


test('registration write gate survives a killed owner and never steals a live transaction', async t => {
  const f = fixture(t), database = path.join(f.home, 'project-catalog-lock.sqlite');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.send('locked');setInterval(()=>{},1000);`, database], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.equal((await once(child, 'message'))[0], 'locked');
  assert.throws(() => createRegisteredProject({ path: f.folder }, f), error => error.status === 409);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(createRegisteredProject({ path: f.folder }, f).created, true);
  const legacy = path.join(f.home, 'project-catalog.write.lock');
  writeFileSync(legacy, JSON.stringify({ pid: child.pid, token: randomUUID() }));
  assert.equal(createRegisteredProject({ path: f.folder }, f).created, false);
  assert.equal(readdirSync(f.home).includes('project-catalog.write.lock'), false);
});

test('malformed legacy owner and live owner locks remain untouched even when old', t => {
  const f = fixture(t), lock = path.join(f.home, 'project-catalog.write.lock');
  for (const contents of ['', '{bad', JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: '2000-01-01' })]) {
    writeFileSync(lock, contents);
    assert.throws(() => createRegisteredProject({ path: f.folder }, f), error => error.status === 409);
    assert.equal(readFileSync(lock, 'utf8'), contents);
  }
});
