import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOfficeConfig, validateOfficeConfig, writeOfficeConfig, publicOfficeConfig } from '../server/office-config.mjs';
import { setupOffice } from '../scripts/setup-office.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user');
  const cwd = path.join(root, 'project');
  mkdirSync(home); mkdirSync(cwd);
  return { root, home, cwd, env: {} };
}
function output() { return { text: '', write(value) { this.text += value; } }; }

test('local model selection reaches runtime on fresh setup and when replacing an existing model', async t => {
  const options=fixture(t);
  await setupOffice(['--yes','--model','local-qwen=chosen:9b'],{...options,output:output()});
  assert.equal(loadOfficeConfig(options).ollama.model,'chosen:9b');
  await setupOffice(['--yes','--overwrite','--model','local-qwen=chosen:27b'],{...options,output:output()});
  assert.equal(loadOfficeConfig(options).ollama.model,'chosen:27b');
  assert.equal(validateOfficeConfig({providers:{'local-qwen':{model:'chosen:9b'}},ollama:{model:''}}).ollama.model,'chosen:9b');
});

test('English setup has English completion and does not silently accept unsupported languages', async t => {
  const options=fixture(t),log=output();
  await setupOffice(['--yes','--lang','en'],{...options,output:log});
  assert.match(log.text,/Configuration saved/);
  assert.match(log.text,/npm run doctor/);
  await assert.rejects(setupOffice(['--yes','--lang','invalid'],{...options,output:output()}),/--lang/);
});

test('fresh installation has no external execution or enabled providers and does not create files', t => {
  const options = fixture(t);
  const config = loadOfficeConfig(options);
  assert.equal(config.mode, 'disabled');
  assert.equal(config.configured, false);
  assert.equal(config.dataDir, path.join(options.home, '.ai-office'));
  assert.equal(config.workspace, options.cwd);
  assert.equal(Object.values(config.providers).some(provider => provider.enabled), false);
  assert.equal(existsSync(config.dataDir), false);
});

test('legacy data is preserved, AI_OFFICE_HOME wins, legacy board never enables execution', t => {
  const options = fixture(t);
  const legacy = path.join(options.root, 'existing-data');
  mkdirSync(legacy);
  const board = Buffer.from('untouched legacy database');
  writeFileSync(path.join(legacy, 'board.sqlite'), board);
  const configPath = path.join(options.root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ dataDir: './elsewhere' }));
  const config = loadOfficeConfig({ ...options, env: { AI_OFFICE_HOME: legacy, AI_OFFICE_CONFIG: configPath } });
  assert.equal(config.dataDir, legacy);
  assert.equal(config.mode, 'disabled');
  assert.deepEqual(readFileSync(path.join(legacy, 'board.sqlite')), board);
  assert.equal(existsSync(path.join(options.root, 'elsewhere')), false);
});

test('custom paths, environment overrides and home expansion are portable', t => {
  const options = fixture(t);
  const configPath = path.join(options.root, 'settings', 'office.json');
  const saved = writeOfficeConfig({ dataDir: '../data', workspace: '~/work', mode: 'read-only', title: '我的办公室', timeZone: 'UTC' }, { ...options, configPath });
  assert.equal(saved.dataDir, path.join(options.root, 'data'));
  assert.equal(saved.workspace, path.join(options.home, 'work'));
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const config = loadOfficeConfig({ ...options, env: { AI_OFFICE_CONFIG: configPath, AI_OFFICE_WORKSPACE: 'other', AI_OFFICE_MODE: 'enabled' } });
  assert.equal(config.workspace, path.join(options.cwd, 'other'));
  assert.equal(config.mode, 'enabled');
  assert.equal(config.title, '我的办公室');
});

test('overwrite requires explicit flag, backs up old configuration, never replaces data', t => {
  const options = fixture(t);
  const first = writeOfficeConfig({ title: '原办公室' }, options);
  const original = readFileSync(first.configPath, 'utf8');
  assert.throws(() => writeOfficeConfig({ title: '新办公室' }, options), /已存在/);
  assert.equal(readFileSync(first.configPath, 'utf8'), original);
  const replacement = writeOfficeConfig({ title: '新办公室' }, { ...options, overwrite: true });
  assert.equal(readFileSync(replacement.backupPath, 'utf8'), original);
  assert.equal(loadOfficeConfig(options).title, '新办公室');
});

test('reject symlink replacement without touching its target', t => {
  const options = fixture(t);
  const target = path.join(options.root, 'important.json');
  const configPath = path.join(options.root, 'linked.json');
  writeFileSync(target, '{"title":"Original"}'); symlinkSync(target, configPath);
  assert.throws(() => writeOfficeConfig({}, { ...options, configPath, overwrite: true }), /非普通配置文件/);
  assert.equal(readFileSync(target, 'utf8'), '{"title":"Original"}');
});

test('schema rejects unsafe settings and does not echo secrets', () => {
  const invalid = [
    { mode: 'automatic' }, { providers: { unknown: {} } },
    { providers: { claude: { enabled: 'yes' } } },
    { providers: { claude: { enabled: true, command: null } } },
    { providers: { codex: { concurrency: 0 } } },
    { providers: { codex: { concurrency: 9 } } },
    { providers: { 'local-qwen': { concurrency: 2 } } },
    { providers: { codex: { concurrency: 1.5 } } },
    { reviewerFor: { codex: 'codex' } }, { reviewerFor: { codex: 'unrecognized' } },
    { timeZone: 'Not/AZone' }, { workspace: '\u0000broken' },
    { ollama: { url: 'file:///tmp/model' } },
    { ollama: { url: 'http://user:password@localhost:11434' } },
    { ollama: { url: 'http://localhost:11434?token=secret' } },
    { apiKey: 'not-for-output' }, { providers: { claude: { token: 'not-for-output' } } },
  ];
  for (const config of invalid) assert.throws(() => validateOfficeConfig(config), error => {
    assert.equal(error.message.includes('not-for-output'), false); return true;
  });
});

test('reviewer mapping remains independent; disabled or missing reviewer never substitutes author', () => {
  const config = validateOfficeConfig({ providers: { claude: { enabled: true } }, reviewerFor: { claude: 'codex' } });
  assert.equal(config.reviewerFor.claude, 'codex');
  assert.equal(config.providers.codex.enabled, false);
  assert.deepEqual(validateOfficeConfig({ reviewerFor: {} }).reviewerFor, { claude: 'codex', codex: 'claude' });
});

test('malformed config fails closed and error does not expose contents', t => {
  const options = fixture(t);
  const configPath = path.join(options.root, 'bad.json');
  writeFileSync(configPath, '{"secret": "sensitive-content"');
  assert.throws(() => loadOfficeConfig({ ...options, configPath }), error => /无法读取配置/.test(error.message) && !error.message.includes('sensitive-content'));
  assert.throws(() => loadOfficeConfig({ ...options, env: { AI_OFFICE_MODE: 'sometimes' } }), /AI_OFFICE_MODE/);
});

test('public setup state omits commands, data paths and model/server settings', t => {
  const config = loadOfficeConfig(fixture(t));
  const visible = publicOfficeConfig(config);
  assert.equal(visible.name, 'AI Office');
  assert.equal(visible.setupCommand, 'npm run setup');
  assert.equal(visible.providers.length, 5);
  assert.equal('dataDir' in visible, false);
  assert.equal('ollama' in visible, false);
  assert.equal('command' in visible.providers[0], false);
});

test('noninteractive setup supports explicit providers, local models, reviewers and concurrency', async t => {
  const options = fixture(t), log = output();
  const config = await setupOffice(['--yes', '--enable', 'claude,codex,local-qwen', '--command', 'claude=/opt/tools/claude', '--model', 'local-qwen=qwen3:8b', '--concurrency', 'claude=3', '--reviewer', 'claude=codex', '--mode', 'read-only', '--workspace', 'work'], { ...options, output: log });
  assert.equal(config.mode, 'read-only');
  assert.equal(config.workspace, path.join(options.cwd, 'work'));
  assert.equal(config.providers.claude.command, '/opt/tools/claude');
  assert.equal(config.providers.claude.concurrency, 3);
  assert.equal(config.providers['local-qwen'].model, 'qwen3:8b');
  assert.equal(config.providers.gemini.enabled, false);
  assert.match(log.text, /没有启动 AI/);
});

test('setup defaults safe, preserves settings unless overwrite and rejects noninteractive implicit consent', async t => {
  const options = fixture(t), log = output();
  await assert.rejects(setupOffice([], { ...options, input: { isTTY: false }, output: log }), /--yes/);
  const first = await setupOffice(['--yes', '--title', '保留'], { ...options, output: log });
  assert.equal(first.mode, 'disabled');
  assert.equal(first.providers.codex.enabled, false);
  await assert.rejects(setupOffice(['--yes'], { ...options, output: log }), /--overwrite/);
  const saved = await setupOffice(['--yes', '--overwrite', '--time-zone', 'UTC'], { ...options, output: log });
  assert.equal(saved.title, '保留');
  assert.equal(saved.timeZone, 'UTC');
  assert.equal(existsSync(saved.backupPath), true);
});

test('setup imports portable JSON without copying board or credential files', async t => {
  const options = fixture(t), log = output();
  const sourcePath = path.join(options.root, 'template.json');
  writeFileSync(sourcePath, JSON.stringify({ dataDir: './new-data', workspace: './project', providers: { codex: { enabled: true, command: 'codex' } } }));
  const saved = await setupOffice(['--yes', '--from', sourcePath], { ...options, output: log });
  assert.equal(saved.dataDir, path.join(options.root, 'new-data'));
  assert.equal(existsSync(saved.dataDir), false);
  assert.equal(saved.mode, 'disabled');
  assert.equal(saved.providers.codex.enabled, true);
});
