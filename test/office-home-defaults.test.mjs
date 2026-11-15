import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProjectCatalog } from '../server/project-catalog.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';

async function withOfficeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-home-defaults-')), previous = process.env.AI_OFFICE_HOME;
  process.env.AI_OFFICE_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.AI_OFFICE_HOME; else process.env.AI_OFFICE_HOME = previous; await rm(home, { recursive: true, force: true }); });
  return home;
}

test('project catalog default location follows AI_OFFICE_HOME', async t => {
  const home = await withOfficeHome(t), folder = path.join(home, 'example-project');
  await writeFile(path.join(home, 'project-catalog.json'), JSON.stringify([{ id: 'example', name: 'Example', path: folder }]));
  assert.deepEqual(readProjectCatalog().map(item => item.id), ['example']);
});

test('local Qwen usage ledger default location follows AI_OFFICE_HOME', async t => {
  const home = await withOfficeHome(t);
  const client = createLocalQwen({ fetchImpl: async () => new Response(JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 4, eval_duration: 1, message: { content: JSON.stringify({ entries: [] }) } })) });
  await client.extractWorkReport('[]');
  const ledger = JSON.parse(await readFile(path.join(home, 'local-qwen-usage.json'), 'utf8'));
  assert.equal(ledger.version, 1);
  assert.equal(Object.values(ledger.days).reduce((sum, day) => sum + day.input + day.output, 0), 7);
});

test('dispatch relay journal default location follows AI_OFFICE_HOME', async t => {
  const home = await withOfficeHome(t);
  await writeFile(path.join(home, 'dispatch-relay-requests.json'), 'invalid JSON');
  const { officeRelay } = await import('../server/office-relay.mjs');
  assert.throws(() => officeRelay(), /journal is unreadable/);
});
