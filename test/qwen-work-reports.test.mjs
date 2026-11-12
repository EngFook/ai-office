import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQwenWorkReports, createWorkReportFile, validateWorkExtract, WORK_REPORT_PREREQUISITES, workReportSource } from '../server/qwen-work-reports.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';

const prerequisites = () => WORK_REPORT_PREREQUISITES.map(id => ({ id, status: 'done', provider: 'grok' }));
const card = (id = 'one', provider = 'codex') => ({ id, title: `Card ${id}`, status: 'done', provider: 'any', assignee: { provider }, result: '新增 server/example.mjs，通过 2 项测试。', updatedAt: '2026-11-03T01:00:00Z' });
const extract = task => ({ id: task.id, quote: task.result.slice(0, 600), files: [{ path: 'server/example.mjs', evidence: '新增 server/example.mjs' }] });
async function fixture(t) {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'qwen-work-reports-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  return projectPath;
}
function setup(t, options = {}) {
  let tasks = [...prerequisites(), card()]; let calls = 0;
  const writes = []; let saved = null;
  const service = createQwenWorkReports({ projectPath: '/mock',
    store: { snapshot(options) { assert.deepEqual(options, { recoverLeases: false }); return { tasks }; } },
    file: { async read() { return saved; }, async write(value) { writes.push(value); saved = value; } },
    qwenClient: { async extractWorkReport(source) { calls++; return { entries: JSON.parse(source).map(task => ({ id: task.id, quoteIndex: 0, fileIndices: task.files.map((_, index) => index) })) }; } }, ...options });
  t.after(() => service.stop());
  return { service, writes, setTasks(value) { tasks = value; }, get calls() { return calls; } };
}

test('both prerequisites gate extraction; actual assignee groups only completed four-provider cards', async t => {
  const f = setup(t); f.setTasks([prerequisites()[0], card()]);
  assert.equal((await f.service.start()).phase, 'waiting'); assert.equal(f.calls, 0);
  const tasks = ['claude', 'codex', 'gemini', 'local-qwen'].map((p, i) => card(`t${i}`, p));
  f.setTasks([...prerequisites(), ...tasks, { ...card('pending'), status: 'pending' }, card('grok', 'grok')]);
  const result = await f.service.tick();
  assert.equal(result.phase, 'ready'); assert.equal(f.calls, 1);
  assert.deepEqual(result.providers.map(p => p.tasks.length), [1, 1, 1, 1]);
  assert.equal(result.providers[1].tasks[0].sourceResult, tasks[1].result);
  await f.service.tick(); assert.equal(f.calls, 1, 'unchanged tasks reuse validated cache');
});

test('configured fresh office extracts work without historical prerequisite cards', async t => {
  const f=setup(t,{prerequisiteIds:[]});f.setTasks([card()]);
  assert.equal((await f.service.start()).phase,'ready');
  assert.equal(f.calls,1);
});

test('rejects paraphrases, fabricated files, duplicate IDs and missing source quotes', () => {
  const task = card();
  assert.equal(validateWorkExtract({ entries: [extract(task)] }, [task]).length, 1);
  for (const bad of [{ ...extract(task), quote: '非常优秀的工作' }, { ...extract(task), quote: '' }, { ...extract(task), files: [{ path: 'fake.mjs', evidence: '新增 fake.mjs' }] }, { ...extract(task), id: 'other' }]) {
    assert.throws(() => validateWorkExtract({ entries: [bad] }, [task]));
  }
  for (const evidence of ['server/example.mjs', '只审查 server/example.mjs，没有修改。']) {
    assert.throws(() => validateWorkExtract({ entries: [{ id: task.id, quote: evidence, files: [{ path: 'server/example.mjs', evidence }] }] }, [{ ...task, result: evidence }]));
  }
  assert.throws(() => validateWorkExtract({ entries: [extract(task), extract(task)] }, [task, card('two')]));
});

test('file persistence survives restart; invalid history and symlinks remain untouched', async t => {
  const root = await fixture(t), file = createWorkReportFile(root);
  assert.equal(await file.read(), null);
  const saved = { schemaVersion: 1, generatedAt: '2026-11-03T01:00:00Z', entries: [{ ...extract(card()), fingerprint: 'digest' }] };
  await file.write(saved);
  assert.deepEqual(await createWorkReportFile(root).read(), saved);
  const filename = path.join(root, 'reports/qwen-work-reports.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await writeFile(filename, '{invalid'); await assert.rejects(file.read());
  assert.equal(await readFile(filename, 'utf8'), '{invalid');
  await rm(filename); const outside = path.join(root, 'outside'); await writeFile(outside, 'untouched');
  await symlink(outside, filename); await assert.rejects(file.write(saved)); assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('restart caches are revalidated; offline model falls back to labeled exact source excerpts', async t => {
  let calls = 0, persisted; const saved = { entries: [{ ...extract(card()), fingerprint: 'wrong' }] };
  const f = setup(t, { file: { read: async () => saved, write: async value => { persisted = value; } }, qwenClient: { model: 'fixture:9b', async extractWorkReport() { calls++; throw new Error('offline'); } } });
  const result = await f.service.start(); assert.equal(result.phase, 'ready');
  const record = result.providers[1].tasks[0];
  assert.equal(record.extracted, true); assert.equal(record.extractionSource, 'source-fallback'); assert.equal(calls, 1);
  assert.equal(record.quote, card().result); assert.equal(record.sourceResult, card().result);
  assert.match(result.notice, /系统原文摘录/); assert.equal(result.model, 'fixture:9b');
  assert.deepEqual(result.counts, { totalLogs: 0, totalTasks: 1, extractedTasks: 1, pendingTasks: 0, sourceFallbackTasks: 1 });
  assert.equal(persisted.entries[0].extractionSource, 'source-fallback');
  assert.equal(validateWorkExtract({ entries: persisted.entries }, [card()]).length, 1);
  await f.service.tick(); assert.equal(calls, 1, 'unchanged exact-source fallback does not retry forever');
});

test('concurrent ticks coalesce; a task retried during inference loses its stale extract', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = setup(t, { qwenClient: { async extractWorkReport(source) { started(); await gate; return { entries: JSON.parse(source).map(task => ({ id: task.id, quoteIndex: 0, fileIndices: task.files.map((_, index) => index) })) }; } } });
  const running = f.service.start(); await entered;
  assert.equal(f.service.tick(), f.service.tick());
  f.setTasks([...prerequisites(), { ...card(), status: 'running' }]); release();
  const result = await running; assert.equal(result.providers[1].tasks.length, 0); assert.deepEqual(f.writes[0].entries, []);
});

test('large results use bounded source and preserve the full original; failed save retries next scan', async t => {
  let attempts = 0, source;
  const f = setup(t, { file: { read: async () => null, write: async () => { if (++attempts === 1) throw new Error('disk'); } },
    qwenClient: { async extractWorkReport(text) { source = text; return { entries: JSON.parse(text).map(task => ({ id: task.id, quoteIndex: 0, fileIndices: [] })) }; } } });
  f.setTasks([...prerequisites(), { ...card(), result: 'x'.repeat(50000) }]);
  assert.equal((await f.service.start()).phase, 'unavailable'); assert.ok(source.length < 7000);
  const result = await f.service.tick(); assert.equal(result.phase, 'ready');
  assert.equal(result.providers[1].tasks[0].sourceResult.length, 50000); assert.equal(result.providers[1].tasks[0].sourceTruncated, true);
});

test('extractor is pinned to local Ollama, serializes with assistance, aborts and rejects truncated responses', async t => {
  const root = await fixture(t); let body, signal;
  const client = createLocalQwen({ model: 'fixture-model:small', usageFile: path.join(root, 'usage.json'), fetchImpl: async (url, init) => {
    assert.equal(url, 'http://localhost:11434/api/chat'); body = JSON.parse(init.body); signal = init.signal;
    return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ entries: [] }) } }));
  } });
  assert.deepEqual(await client.extractWorkReport('[{"id":"one","result":"事实"}]'), { entries: [] });
  assert.equal(body.model, 'fixture-model:small'); assert.equal(body.think, false); assert.equal(body.format, 'json'); assert.equal(body.tools, undefined); assert.ok(signal);
  const bad = createLocalQwen({ fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'length', message: { content: '{}' } })) });
  await assert.rejects(bad.extractWorkReport('[]'), /incomplete/);
  let entered; const gate = new Promise(resolve => { entered = resolve; });
  const busy = createLocalQwen({ fetchImpl: async (_url, init) => { entered(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  const controller = new AbortController(), running = busy.extractWorkReport('[]', { signal: controller.signal }); await gate;
  const rejected = assert.rejects(running, /aborted/);
  controller.abort(); await rejected;
});

test('JSON escape expansion is bounded so every task can eventually enter a batch', async t => {
  let source;
  const f = setup(t, { qwenClient: { async extractWorkReport(text) { source = text; return { entries: JSON.parse(text).map(task => ({ id: task.id, quoteIndex: 0, fileIndices: [] })) }; } } });
  f.setTasks([...prerequisites(), { ...card(), result: '\\'.repeat(5000) }]);
  assert.equal((await f.service.start()).phase, 'ready'); assert.ok(source.length <= 7000);
});

test('stop during cache read prevents new model calls and writes', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); let calls = 0, writes = 0;
  const f = setup(t, { file: { read: async () => { entered(); await gate; return null; }, write: async () => { writes++; } }, qwenClient: { extractWorkReport: async () => { calls++; throw new Error(); } } });
  const starting = f.service.start(); await started;
  const stopping = f.service.stop(); release(); await Promise.all([starting, stopping]);
  assert.equal(calls, 0); assert.equal(writes, 0); assert.equal(f.service.status().phase, 'stopped');
});

test('file candidates exclude referenced paths and support explicit changed-file lists', () => {
  for (const result of ['修改 server/a.mjs，参考 server/b.mjs。', 'Updated server/a.mjs; read server/b.mjs for context.', '创建 reports/new.md，引用 docs/existing.md。']) {
    const files = workReportSource({ id: 't', result }).files;
    assert.equal(files.length, 1); assert.ok(!/b.mjs|existing.md/.test(files[0].path));
  }
  for (const result of ['修改文件：\n- `server/a.mjs`\n- `src/b.jsx`', 'Modified files:\n- server/a.mjs\n- src/b.jsx']) {
    const task = { ...card(), result }, files = workReportSource(task).files;
    assert.deepEqual(files.map(file => file.path), ['server/a.mjs', 'src/b.jsx']);
    assert.equal(validateWorkExtract({ entries: [{ id: task.id, quote: result, files }] }, [task]).length, 1);
  }
  assert.equal(workReportSource({ id: 't', result: '建议修改 server/a.mjs。' }).files.length, 0);
});

test('busy local model archives exact source without retrying inference every thirty seconds', async t => {
  const ms = Date.parse('2026-11-03T01:00:00Z');
  const f = setup(t, { now: () => ms, qwenClient: { async extractWorkReport() { throw new Error('Local Qwen concurrency is 1.'); } } });
  await f.service.start();
  assert.equal(f.service.status().phase, 'ready');
  assert.equal(f.service.status().nextCheckAt, new Date(ms + 300000).toISOString());
  assert.equal(f.service.status().counts.sourceFallbackTasks, 1);
});

test('invalid model selection is discarded and fallback keeps only original text and file evidence', async t => {
  const task = card();
  const f = setup(t, { qwenClient: { async extractWorkReport() { return { entries: [{ id: task.id, quoteIndex: 500, fileIndices: [5], quote: 'invented approval', files: ['fake.mjs'] }] }; } } });
  const result = await f.service.start();
  assert.equal(result.phase, 'ready');
  const record = result.providers[1].tasks[0];
  assert.equal(record.quote, task.result); assert.equal(record.extractionSource, 'source-fallback');
  assert.deepEqual(record.files, workReportSource(task).files);
  assert.equal(JSON.stringify(f.writes).includes('invented'), false);
});

test('fallback is revalidated against retried tasks and stop aborts without saving fallback', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const f = setup(t, { qwenClient: { async extractWorkReport(_source, { signal }) {
    entered(); await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    throw new Error('busy');
  } } });
  const starting = f.service.start(); await started;
  const stopping = f.service.stop(); release(); await Promise.all([starting, stopping]);
  assert.equal(f.writes.length, 0); assert.equal(f.service.status().phase, 'stopped');
  const g = setup(t, { qwenClient: { async extractWorkReport() { g.setTasks([...prerequisites(), { ...card(), status: 'running' }]); throw new Error('offline'); } } });
  const result = await g.service.start();
  assert.equal(result.counts.totalTasks, 0); assert.deepEqual(g.writes[0].entries, []);
});

test('cache failures are distinct from model availability and counts retain verified records', async t => {
  const readFailure = setup(t, { file: { read: async () => { throw new Error('private path'); } } });
  const unreadable = await readFailure.service.start();
  assert.equal(unreadable.phase, 'unavailable'); assert.match(unreadable.error, /读取报告缓存/); assert.equal(unreadable.error.includes('private path'), false);
  const saveFailure = setup(t, { file: { read: async () => null, write: async () => { throw new Error('private path'); } } });
  const unsaved = await saveFailure.service.start();
  assert.equal(unsaved.phase, 'unavailable'); assert.match(unsaved.error, /保存新摘录/);
  assert.deepEqual(unsaved.counts, { totalLogs: 0, totalTasks: 1, extractedTasks: 0, pendingTasks: 1, sourceFallbackTasks: 0 });
});


test('empty and whitespace-only results archive an empty source excerpt, never invented completion text', async t => {
  for (const result of ['', '  \n\t']) {
    const f = setup(t, { qwenClient: { async extractWorkReport() { throw new Error('offline'); } } });
    f.setTasks([...prerequisites(), { ...card(), result }]);
    const state = await f.service.start();
    assert.equal(state.phase, 'ready');
    const record = state.providers[1].tasks[0];
    assert.equal(record.quote, ''); assert.equal(record.sourceResult, result);
    assert.deepEqual(record.files, []); assert.equal(record.extractionSource, 'source-fallback');
  }
});


test('fallback from more than twelve changed files stays within the already-bounded source evidence', async t => {
  const task = { ...card('many-files'), result: Array.from({length:20}, (_,i) => `新增 src/file-${i}.mjs。`).join('\n') };
  const source = workReportSource(task);
  assert.equal(source.files.length,12);
  const f = setup(t,{qwenClient:{async extractWorkReport(){throw new Error('offline');}}});
  f.setTasks([...prerequisites(),task]);
  const state = await f.service.start();
  assert.equal(state.phase,'ready');
  const record = state.providers.find(group=>group.provider==='codex').tasks[0];
  assert.equal(record.extractionSource,'source-fallback');
  assert.deepEqual(record.files,source.files);
  assert.equal(validateWorkExtract({entries:[{id:task.id,quote:record.quote,files:record.files}]},[task]).length,1);
});

test('source failure after a successful initial cache read is not mislabeled a cache failure', async t => {
  let snapshots=0,reads=0;
  const f=setup(t,{store:{snapshot(){if(++snapshots>1)throw new Error('private source unavailable');return {tasks:[...prerequisites(),card()]};}},
    file:{async read(){reads++;return null;},async write(){assert.fail('must not publish stale source');}}});
  const state=await f.service.start();
  assert.equal(reads,1);
  assert.equal(state.phase,'unavailable');
  assert.match(state.error,/任务记录暂不可用/);
  assert.doesNotMatch(state.error,/读取报告缓存|private source/);
});
