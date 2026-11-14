import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { readonlyStore } from '../server/portable-runtime.mjs';
import { validateOfficeConfig } from '../server/office-config.mjs';
import { writeGrokQuota, runOfficeBoardCommand } from '../scripts/office-board.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { configureWatchHolds } from '../server/watch-task-policy.mjs';
import { createTaskRunner, trustedOfficeUrl, taskPrompt } from '../server/task-runner.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-review-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function directoryDigest(directory) {
  return readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = statSync(file);
    return { name, size: stat.size, mtime: stat.mtimeMs,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}

for (const includeShm of [false, true]) {
  test(`read-only WAL viewing preserves every original file and directory entry (SHM ${includeShm ? 'present' : 'absent'})`, t => {
    const root = fixture(t), source = path.join(root, 'writer'), viewed = path.join(root, 'viewed');
    mkdirSync(source); mkdirSync(viewed);
    const db = new DatabaseSync(path.join(source, 'board.sqlite'));
    t.after(() => { if (db.isOpen) db.close(); });
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE tasks(id TEXT, record TEXT);');
    db.prepare('INSERT INTO tasks VALUES (?,?)').run('wal-task', JSON.stringify({ id: 'wal-task', status: 'running', title: 'Only in WAL' }));
    for (const name of ['board.sqlite', 'board.sqlite-wal', ...(includeShm ? ['board.sqlite-shm'] : [])]) {
      copyFileSync(path.join(source, name), path.join(viewed, name));
    }
    const before = directoryDigest(viewed), reader = readonlyStore(viewed);
    for (let i = 0; i < 2; i++) {
      const snapshot = reader.snapshot();
      assert.equal(snapshot.tasks[0].title, 'Only in WAL');
      assert.equal(snapshot.tasks[0].status, 'running', 'viewing must not expire leases');
      assert.deepEqual(directoryDigest(viewed), before, 'no SHM creation or database/sidecar changes');
    }
    reader.close();
    assert.deepEqual(directoryDigest(viewed), before);
  });
}

test('viewing an uninitialized data directory does not initialize it', t => {
  const missing = path.join(fixture(t), 'not-created');
  const reader = readonlyStore(missing);
  assert.deepEqual(reader.snapshot().tasks, []);
  reader.close();
  assert.equal(existsSync(missing), false);
});

test('setup rejects reviewer mappings that cannot produce independent code review', () => {
  for (const author of ['claude', 'codex']) {
    for (const reviewer of ['local-qwen', 'gemini', 'grok-bot', author, null, 'unknown']) {
      assert.throws(() => validateOfficeConfig({ reviewerFor: { [author]: reviewer } }), /审查|reviewerFor/);
    }
  }
  assert.deepEqual(validateOfficeConfig({}).reviewerFor, { claude: 'codex', codex: 'claude' });
});

test('configured paused task holds apply to external direct claims and linked reviews', t => {
  const root = fixture(t), store = createTaskStore({ home: path.join(root, 'data') });
  t.after(() => { store.close(); configureWatchHolds([]); });
  const task = store.createTask({ title: 'Held task', projectPath: root, provider: 'claude' });
  const worker = { id: 'fixture-claude', provider: 'claude', projectPath: root };
  configureWatchHolds([task.id]);
  assert.equal(store.claimTask(worker, { taskId: task.id }), null);
  assert.equal(store.snapshot().tasks.find(item => item.id === task.id).status, 'pending');
  configureWatchHolds([]);
  const claim = store.claimTask(worker, { taskId: task.id });
  store.finishTask(task.id, claim.claimToken, { status: 'done', result: 'Fixture implementation complete' });
  configureWatchHolds([task.id]);
  assert.equal(store.claimTask({ id: 'fixture-codex', provider: 'codex', projectPath: root }, { taskId: `${task.id}:review` }), null);
});

test('external claims cannot turn an edited review assignment into author self-review', t => {
  const root = fixture(t), store = createTaskStore({ home: path.join(root, 'data') });
  t.after(() => store.close());
  const task = store.createTask({ title: 'Independent review fixture', projectPath: root, provider: 'claude' });
  const author = { id: 'fixture-author', provider: 'claude', projectPath: root };
  const claim = store.claimTask(author, { taskId: task.id });
  store.finishTask(task.id, claim.claimToken, { status: 'done', result: 'Implemented fixture' });
  const reviewId = `${task.id}:review`;
  store.updateTask(reviewId, { provider: 'claude' });
  assert.equal(store.claimTask(author, { taskId: reviewId }), null);
  store.updateTask(reviewId, { provider: 'codex' });
  assert.equal(store.claimTask({ ...author, providers: ['claude', 'codex'] }, { taskId: reviewId }), null);
  assert.ok(store.claimTask({ id: 'fixture-reviewer', provider: 'codex', projectPath: root }, { taskId: reviewId }));
});

test('configured runner does not rewrite explicit assignments to disabled quota alternatives', async t => {
  const root = fixture(t), store = createTaskStore({ home: path.join(root, 'data'), autoPickup: false });
  const task = store.createTask({ title: 'Pinned implementation', projectPath: root, provider: 'codex' });
  const runner = createTaskRunner({ store,
    providers: { codex: { enabled: true }, claude: { enabled: false } },
    probeProviders: async () => ({}),
    quotaReader: () => ({ codex: { windows: [{ name: 'Weekly', remainingPercent: 0 }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 80 }] } }),
    spawnProcess: () => assert.fail('manual pickup must not spawn an agent'),
  });
  t.after(async () => { await runner.stop(); store.close(); });
  await runner.start();
  const after = store.snapshot().tasks.find(item => item.id === task.id);
  assert.equal(after.provider, 'codex');
  assert.equal(after.version, task.version);
});

test('worker board commands inherit only the actual trusted local office endpoint', async t => {
  const root = fixture(t), store = createTaskStore({ home: path.join(root, 'data') });
  store.createTask({ title: 'Endpoint fixture', projectPath: root, provider: 'codex' });
  let launch, prompt = '';
  const runner = createTaskRunner({ store,
    providers: { codex: { enabled: true }, gemini: { enabled: true } },
    officeUrl: () => 'http://127.0.0.1:4173',
    env: { PATH: '/fixture', AI_OFFICE_URL: 'https://untrusted.example', AI_OFFICE_CONFIG: '/fixture/private-config', GROK_BOT_WEBHOOK_AUTH: 'fixture-private-value' },
    probeProviders: async () => ({ codex: { available: true, authenticated: true, path: '/fixture/codex' } }),
    spawnProcess(binary, args, options) {
      launch = options;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, encoding, done) { prompt += chunk.toString(); done(); } });
      return child;
    },
    terminate(child) { child.emit('close', 143); },
  });
  t.after(async () => { await runner.stop(); store.close(); });
  await runner.start();
  assert.equal(launch.env.AI_OFFICE_URL, 'http://127.0.0.1:4173');
  assert.equal(launch.env.AI_OFFICE_CONFIG, undefined);
  assert.equal(launch.env.GROK_BOT_WEBHOOK_AUTH, undefined);
  assert.match(prompt, /JSON object on standard input/);
  const urls = [];
  await runOfficeBoardCommand({ args: ['add-task'], environment: launch.env,
    readInput: async () => ({ title: 'Research fixture', provider: 'gemini' }),
    fetchImpl: async (url, init) => { urls.push(url); return new Response(JSON.stringify(init.method === 'GET' ? { csrfToken: 'fixture-csrf' } : { task: { id: 'fixture' } })); },
  });
  assert.deepEqual(urls, ['http://127.0.0.1:4173/api/office/board', 'http://127.0.0.1:4173/api/office/tasks']);
});

test('unavailable or unsafe office endpoints never invite board delegation', () => {
  for (const value of [null, undefined, 'https://localhost:4173', 'http://user:pass@127.0.0.1:4173', 'http://127.0.0.1.evil.test:4173', 'http://127.0.0.1:4173/path', 'http://127.0.0.1:4173/?secret=value', 'file:///tmp/office']) {
    assert.equal(trustedOfficeUrl(value), null);
    const prompt = taskPrompt({ provider: 'codex' }, { gemini: { enabled: true } }, { officeUrl: value });
    assert.ok(!prompt.includes('Request a lookup'));
    assert.ok(!prompt.includes('add-task'));
    assert.match(prompt, /do not invoke office-board.mjs or assume a default port/);
  }
  assert.equal(trustedOfficeUrl('http://[::1]:4173/'), 'http://[::1]:4173');
});

test('direct Grok quota command refuses disabled/read-only mode and disabled provider without writes', t => {
  const root = fixture(t), configuration = path.join(root, 'config.json'), dataDir = path.join(root, 'private-data');
  const env = { AI_OFFICE_CONFIG: configuration, AI_OFFICE_HOME: dataDir };
  for (const [mode, enabled] of [['disabled', true], ['read-only', true], ['enabled', false]]) {
    writeFileSync(configuration, JSON.stringify({ mode, providers: { 'grok-bot': { enabled } } }));
    assert.throws(() => writeGrokQuota({ usedPercent: 25 }, env), /尚未启用/);
    assert.equal(existsSync(dataDir), false);
  }
  writeFileSync(configuration, JSON.stringify({ mode: 'enabled', providers: { 'grok-bot': { enabled: true } } }));
  const result = writeGrokQuota({ usedPercent: 25 }, env, 12345);
  const output = path.join(dataDir, 'reports/grok-quota.json');
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).observedAt, 12345);
  assert.equal(result.usedPercent, 25);
  assert.equal(statSync(output).mode & 0o777, 0o600);
});

test('mobile LaunchAgent rendering retains explicit configuration and port without copying secret environment', () => {
  // Execute the installer with every external side effect replaced. This never
  // imports the installer, writes LaunchAgents, or calls the real launchctl.
  const filename = new URL('../scripts/install-mobile-office.mjs', import.meta.url);
  const source = readFileSync(filename, 'utf8').replace(/^import .*;\n/gm, '').replaceAll('import.meta.dirname', '"/fixture/scripts"');
  const writes = new Map(), commands = [];
  runInNewContext(source, {
    path, loadOfficeConfig: () => ({ configPath: '/fixture/config & space.json', dataDir: '/fixture/private data' }),
    homedir: () => '/fixture/user', existsSync: () => true, mkdirSync() {}, chmodSync() {},
    writeFileSync(file, content) { writes.set(file, content); },
    spawnSync(command, args) { commands.push({ command, args }); return { status: 0 }; },
    console: { log() {} }, process: { platform: 'darwin', execPath: '/fixture/node', getuid: () => 501,
      env: { AI_OFFICE_URL: 'http://127.0.0.1:4321', AI_OFFICE_MOBILE_PORT: '4322', GROK_BOT_WEBHOOK_AUTH: 'fixture-private-value' } },
  });
  const plist = writes.get('/fixture/user/Library/LaunchAgents/local.ai-office.mobile.plist');
  assert.ok(plist.includes('<key>EnvironmentVariables</key>'));
  for (const value of ['/fixture/config &amp; space.json', '/fixture/private data', 'http://127.0.0.1:4321', '4322']) assert.ok(plist.includes(value), value);
  assert.equal(plist.includes('fixture-private-value'), false);
  assert.equal(plist.includes('GROK_BOT_WEBHOOK_AUTH'), false);
  assert.deepEqual(commands.map(item => item.command), ['launchctl', 'launchctl']);
});
