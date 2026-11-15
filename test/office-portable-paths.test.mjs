import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOfficeConfig, validateOfficeConfig } from '../server/office-config.mjs';
import { setupOffice } from '../scripts/setup-office.mjs';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-portable-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project 空格'); mkdirSync(home); mkdirSync(cwd);
  return { root, home, cwd, env: {}, output: { write() {} } };
}
test('configuration resolves provider paths once relative to the settings file, independent of task folders', t => {
  const f = fixture(t), configPath = path.join(f.root, 'settings.json');
  writeFileSync(configPath, JSON.stringify({ providers: { claude: { command: './bin/claude' }, codex: { command: '~/custom bin/codex' }, gemini: { command: 'agy' } } }));
  const config = loadOfficeConfig({ ...f, configPath });
  assert.equal(config.providers.claude.command, path.join(f.root, 'bin/claude'));
  assert.equal(config.providers.codex.command, path.join(f.home, 'custom bin/codex'));
  assert.equal(config.providers.gemini.command, 'agy');
  assert.equal(validateOfficeConfig({ providers: { claude: { command: '/opt/custom cli' } } }).providers.claude.command, '/opt/custom cli');
});
test('setup command arguments resolve relative executable/folder paths from the invocation directory', async t => {
  const f = fixture(t);
  const config = await setupOffice(['--yes', '--command', 'codex=./tools/codex', '--workspace', './work', '--data-dir', './private'], f);
  assert.equal(config.providers.codex.command, path.join(f.cwd, 'tools/codex'));
  assert.equal(config.workspace, path.join(f.cwd, 'work'));
  assert.equal(config.dataDir, path.join(f.cwd, 'private'));
  assert.equal(JSON.parse(readFileSync(config.configPath, 'utf8')).providers.codex.command, path.join(f.cwd, 'tools/codex'));
});
test('setup expands an exact tilde office-home selector consistently with runtime', async t => {
  const f = fixture(t), options = { ...f, env: { AI_OFFICE_HOME: '~' } };
  const saved = await setupOffice(['--yes'], options), loaded = loadOfficeConfig(options);
  assert.equal(saved.dataDir, f.home); assert.equal(loaded.dataDir, f.home);
  assert.equal(saved.configPath, path.join(f.home, 'config.json'));
});
