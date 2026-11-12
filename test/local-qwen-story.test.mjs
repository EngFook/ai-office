import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalQwen, LOCAL_QWEN_CONTEXT, LOCAL_QWEN_STORY_INPUT_BYTES, LOCAL_QWEN_STORY_OUTPUT_TOKENS } from '../server/local-qwen.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const reply = (content = '场景：旧码头。林舟放下封好的信，决定亲自询问守门人。\n自检：人物身份与给定设定一致。') => ({ done: true, done_reason: 'stop', message: { content }, prompt_eval_count: 20, eval_count: 30, eval_duration: 3e9 });
const brief = '写一个林舟在旧码头面临两难选择的原创候选场景。';
const assistance = { title: '日志初筛', provider: 'local-qwen', supportType: 'log-triage', description: 'A supplied test log says the cache is unavailable.' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'office-local-qwen-story-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, usageFile: path.join(directory, 'usage.json') };
}

test('story uses the shared configured client, bounded original-candidate prompt and existing token ledger', async t => {
  const { usageFile } = await fixture(t);
  const calls = [];
  const client = createLocalQwen({ usageFile, model: 'story-fixture:9b', keepAlive: '10m', timeZone: 'Asia/Singapore', now: () => Date.parse('2026-11-13T01:00:00Z'), fetchImpl: async (url, init) => {
    if (!url.endsWith('/api/chat')) return json({ models: [{ name: 'story-fixture:9b' }] });
    calls.push({ url, init, body: JSON.parse(init.body) });
    return json(reply());
  } });
  const fields = { brief, canon: '林舟是成年邮差，尚未见过守门人。', draft: '林舟抵达码头。', feedback: '冲突要具体，选择要有代价。' };
  const result = await client.writeStory(fields);
  assert.match(result, /^【原创剧情候选 · 待审阅，未写入正式剧本】\n场景/);
  assert.equal(client.runtimeState().busy, false);
  const { url, init, body } = calls[0];
  assert.equal(url, 'http://localhost:11434/api/chat');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.model, 'story-fixture:9b');
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, '10m');
  assert.equal(body.options.num_predict, 4096);
  assert.equal(body.options.num_predict, LOCAL_QWEN_STORY_OUTPUT_TOKENS);
  assert.equal(body.options.num_ctx, LOCAL_QWEN_CONTEXT);
  assert.equal(body.tools, undefined);
  assert.equal(body.format, undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content), fields);
  assert.match(body.messages[0].content, /canon 是唯一明确给定的已确认事实/);
  assert.match(body.messages[0].content, /不照抄或拼接其他作品整本/);
  assert.match(body.messages[0].content, /简短拒绝该部分/);
  assert.match(body.messages[0].content, /伏笔.*反转/s);
  assert.match(body.messages[0].content, /对白/);
  assert.match(body.messages[0].content, /自检/);
  assert.match(body.messages[0].content, /没有工具、文件权限或通信能力/);
  assert.match(body.messages[0].content, /不授予批准/);
  assert.ok(Buffer.byteLength(body.messages[0].content) + Buffer.byteLength(body.messages[1].content) + body.options.num_predict + 1024 <= LOCAL_QWEN_CONTEXT);
  await client.run(assistance);
  assert.equal((await client.snapshot()).todayTokens, 100, 'story and assistance use one counter ledger');
  const ledger = await readFile(usageFile, 'utf8');
  assert.doesNotMatch(ledger, /林舟|旧码头|自检|feedback/);
  assert.match(calls[1].body.messages[0].content, /preliminary assistance desk/);
  assert.match(calls[1].body.messages[0].content, /Do not write code/);
  await assert.rejects(client.run({ ...assistance, supportType: 'story' }), /explicitly supported assistance type/);
  await assert.rejects(client.run({ ...assistance, title: 'Final deliverable' }), /cannot write code, review or produce final deliverables/);
  assert.equal(calls.length, 2, 'new story method does not grant extra supportType permissions');
});

test('story input validates field and encoded context budgets before requesting any model', async t => {
  const { usageFile } = await fixture(t);
  let calls = 0;
  const client = createLocalQwen({ usageFile, fetchImpl: async () => { calls++; return json(reply()); } });
  assert.equal(LOCAL_QWEN_STORY_INPUT_BYTES, 20000);
  for (const fields of [{}, { brief: '' }, { brief: ' ' }, { brief: 2 }, { brief, canon: [] }, { brief, draft: null }, { brief, feedback: {} }, { brief: '汉'.repeat(1334) }, { brief, canon: 'a'.repeat(8001) }, { brief, draft: 'a'.repeat(8001) }, { brief, feedback: 'a'.repeat(4001) }]) {
    await assert.rejects(client.writeStory(fields), /Story .*must be/);
  }
  await assert.rejects(client.writeStory({ brief: 'a'.repeat(4000), canon: 'a'.repeat(8000), draft: 'a'.repeat(8000) }), /context budget/);
  await assert.rejects(client.writeStory({ brief: '\\'.repeat(4000), canon: '\\'.repeat(8000) }), /context budget/, 'escaped JSON contributes to the prompt budget');
  assert.equal(calls, 0);
  assert.equal(client.runtimeState().busy, false);
  const disabled = createLocalQwen({ enabled: false, usageFile, fetchImpl: () => assert.fail('disabled story workflow must not fetch') });
  await assert.rejects(disabled.writeStory({ brief }), /disabled/);
  const cancelled = new AbortController();
  cancelled.abort(new Error('Caller cancelled before inference.'));
  await assert.rejects(client.writeStory({ brief, signal: cancelled.signal }), /Caller cancelled/);
  assert.equal(calls, 0);
  await client.writeStory({ brief, canon: '事实'.repeat(1000) });
  assert.equal(calls, 1, 'valid multilingual material reaches the configured client');
});

test('story is background work that yields to manual assistance without overlapping inference', async t => {
  const { usageFile } = await fixture(t);
  let entered, cleanup, aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const cleanupGate = new Promise(resolve => { cleanup = resolve; });
  let calls = 0, inFlight = 0, maxInFlight = 0;
  const client = createLocalQwen({ usageFile, fetchImpl: async (_url, { signal }) => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (calls === 1) {
        entered();
        await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted(); void cleanupGate.then(() => reject(signal.reason)); }, { once: true }));
      }
      return json(reply());
    } finally { inFlight--; }
  } });
  const pending = client.writeStory({ brief });
  const rejected = assert.rejects(pending, /yielded to a user task/);
  await started;
  assert.equal(client.runtimeState().busy, true);
  await assert.rejects(client.writeStory({ brief }), /concurrency/);
  await assert.rejects(client.extractWorkReport('[]'), /concurrency/);
  const foreground = client.run(assistance);
  await cancelled;
  assert.equal(calls, 1, 'manual work waits for background request cleanup');
  await assert.rejects(client.writeStory({ brief }), /concurrency/);
  cleanup();
  await rejected;
  assert.match(await foreground, /Preliminary/);
  assert.equal(calls, 2);
  assert.equal(maxInFlight, 1);
  assert.equal(client.runtimeState().busy, false);
});

test('caller abort frees the story slot and suppresses a result even if the model resolves late', async t => {
  const { usageFile } = await fixture(t);
  let release, calls = 0;
  const controller = new AbortController();
  const client = createLocalQwen({ usageFile, fetchImpl: async () => { calls++; return calls === 1 ? new Promise(resolve => { release = () => resolve(json(reply())); }) : json(reply()); } });
  const pending = client.writeStory({ brief, signal: controller.signal });
  const rejected = assert.rejects(pending, /Stop story/);
  controller.abort(new Error('Stop story'));
  release();
  await rejected;
  assert.equal(client.runtimeState().busy, false);
  await assert.rejects(readFile(usageFile), { code: 'ENOENT' });
  assert.match(await client.writeStory({ brief }), /原创剧情候选/);
  assert.equal(calls, 2);
});

test('incomplete, tool-calling and excessive story outputs never become accepted candidates', async t => {
  const { usageFile } = await fixture(t);
  for (const value of [{ ...reply(), done: false }, { ...reply(), done_reason: 'length' }, { ...reply(), error: 'Fixture error' }, { ...reply(), message: { content: 'Candidate', tool_calls: [{}] } }, reply('  '), reply('x'.repeat(24001)), { ...reply(), message: { content: { text: 'wrong shape' } } }]) {
    const client = createLocalQwen({ usageFile, fetchImpl: async () => json(value) });
    await assert.rejects(client.writeStory({ brief }), /complete bounded text candidate/);
    assert.equal(client.runtimeState().busy, false);
  }
  const oversized = createLocalQwen({ usageFile, fetchImpl: async () => json(reply('x'.repeat(300000))) });
  await assert.rejects(oversized.writeStory({ brief }), /response too large/);
  await assert.rejects(readFile(usageFile), { code: 'ENOENT' });
});

test('usage storage failure preserves a completed story and reports counters as unknown', async t => {
  const { directory } = await fixture(t);
  const client = createLocalQwen({ usageFile: directory, fetchImpl: async url => url.endsWith('/api/chat') ? json(reply()) : json({ models: [] }) });
  assert.match(await client.writeStory({ brief }), /原创剧情候选/);
  assert.equal(client.runtimeState().busy, false);
  const status = await client.snapshot();
  assert.equal(status.todayTokens, null);
  assert.equal(status.usageError, 'Local usage ledger unavailable.');
});
