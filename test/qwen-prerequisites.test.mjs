import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readQwenPrerequisites, QWEN_PREREQUISITE_ENV } from '../server/qwen-prerequisites.mjs';

test('prerequisite task IDs are install config, empty by default', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'qwen-prereq-')); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(readQwenPrerequisites('watch', { home, env: {}, warn: () => assert.fail('missing file is not a warning') }), []);
  assert.deepEqual(readQwenPrerequisites('workReports', { home, env: {} }), []);
  await writeFile(path.join(home, 'qwen-prerequisites.json'), JSON.stringify({ watch: ['task-a'], workReports: ['task-b', 'task-c', 'task-b'] }));
  assert.deepEqual(readQwenPrerequisites('watch', { home, env: {} }), ['task-a']);
  assert.deepEqual(readQwenPrerequisites('workReports', { home, env: {} }), ['task-b', 'task-c']);
  assert.deepEqual(readQwenPrerequisites('watch', { home, env: { [QWEN_PREREQUISITE_ENV.watch]: ' env-1, env-2 ' } }), ['env-1', 'env-2'], 'environment wins');
  const warnings = [], warn = message => warnings.push(message);
  assert.deepEqual(readQwenPrerequisites('watch', { home, env: { [QWEN_PREREQUISITE_ENV.watch]: 'bad id;rm' }, warn }), [], 'invalid ids fail closed to none');
  await writeFile(path.join(home, 'qwen-prerequisites.json'), '{');
  assert.deepEqual(readQwenPrerequisites('watch', { home, env: {}, warn }), []);
  assert.equal(warnings.length, 2); assert.match(warnings[0], /AI_OFFICE_QWEN_WATCH_PREREQUISITES/); assert.match(warnings[1], /qwen-prerequisites\.json/);
  assert.ok(!warnings.join('').includes('bad id'), 'warnings never echo the configured value');
  assert.throws(() => readQwenPrerequisites('other', { home, env: {} }), /Unknown/);
});

test('Qwen services ship no install-specific prerequisite IDs', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['server/qwen-watch.mjs', 'server/qwen-work-reports.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, `${file} hardcodes a task id`);
  }
});
