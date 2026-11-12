import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskStore } from '../server/task-store.mjs';
import { createTaskRunner, researchPrompt } from '../server/task-runner.mjs';

const NOTE = 'Verified research finding. [Official source](https://example.com/source)';
const success = more => ({ conversation_id: 'fixture-gemini', status: 'SUCCESS', response: NOTE, ...more });
async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-gemini-completion-')));
  const researchDir = path.join(home, 'research'), store = createTaskStore({ home, researchDir });
  const calls = [], logs = [];
  const runner = createTaskRunner({ store, env: {}, pollIntervalMs: 60000, onLog: event => logs.push(event),
    probeProviders: async () => ({ gemini: { available: true, authenticated: true, path: '/mock/agy' } }),
    spawnProcess: () => {
      const child = new EventEmitter(); child.pid = 100000 + calls.length; child.exitCode = null; child.signalCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.event = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.close = () => { child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0); };
      calls.push(child); return child;
    }, terminate: child => child.close(),
  });
  t.after(async () => { await runner.stop(); store.close(); await rm(home, { recursive: true, force: true }); });
  const run = async (events, stderr = '', input = {}) => {
    const task = store.createTask({ provider: 'gemini', title: 'Research fixture', description: 'Verify the current public source.', ...input });
    if (runner.status().started) await runner.kick(); else await runner.start();
    const child = calls.at(-1); assert.ok(child);
    if (stderr) child.stderr.write(stderr);
    for (const event of events) child.event(event);
    child.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = store.snapshot().tasks.find(item => item.id === task.id);
      if (current.status !== 'running') return current;
      await delay(5);
    }
    assert.fail('Fixture did not reach a terminal task state.');
  };
  return { run, logs, researchDir, store };
}

test('Gemini accepts legacy successful output and ignores unrelated future metadata', async t => {
  const f = await fixture(t), task = await f.run([success({ usage: { total_tokens: 10 }, future_metadata: { harmless: true } })]);
  assert.equal(task.status, 'done'); assert.match(task.result, /Verified research finding/);
  assert.equal((await readdir(f.researchDir)).length, 1);
});

test('Gemini accepts the documented nested stream result without mistaking progress for completion', async t => {
  const f = await fixture(t);
  const task = await f.run([{ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response' } }, { event: 'result', result: success({ denied_actions: [] }) }]);
  assert.equal(task.status, 'done');
});

test('Gemini rejects truncated, interrupted, errored and unknown early finishes even with SUCCESS and exit zero', async t => {
  for (const finished_reason of ['print_timeout', 'interrupted', 'error', 'future_unknown_reason', false, { unknown: true }]) {
    const f = await fixture(t), task = await f.run([success({ finished_reason })]);
    assert.equal(task.status, 'blocked'); assert.equal(task.result, '');
    assert.match(task.error, /时间上限|中断|提前结束/);
    assert.equal((await readdir(f.researchDir)).length, 0, 'partial output is never saved as a successful research note');
  }
});

test('nested Gemini terminal metadata cannot hide early finishes or denied research access', async t => {
  for (const event of [
    { event: 'result', result: success({ finished_reason: 'print_timeout' }) },
    { event: 'result', finished_reason: 'interrupted', result: success() },
    { event: 'result', result: success({ denied_actions: ['read_url(https://example.com)'] }) },
    { event: 'result', denied_actions: ['web_search'], result: success() },
  ]) { const f = await fixture(t); assert.equal((await f.run([event])).status, 'blocked'); }
});

test('denied source lookup, reads, commands and unknown denial shapes block Gemini research without raw output leaks', async t => {
  const secret = 'fixture-private-token-do-not-publish';
  for (const denied_actions of [
    ['web_search'], ['read_url(https://example.com)'], [{ tool: 'read_file', target: secret }],
    [{ action: 'command(cat private-file)' }], [{ unfamiliar: secret }], { message: secret }, secret,
  ]) {
    const f = await fixture(t), task = await f.run([success({ denied_actions, error: null })], `private stderr ${secret}`);
    assert.equal(task.status, 'blocked'); assert.match(task.error, /查证工具或资料访问被拒绝/);
    assert.ok(!JSON.stringify(task).includes(secret));
    assert.ok(!JSON.stringify(f.logs).includes(secret));
    assert.ok(!f.logs.some(event => event.type === 'turn_completed'));
  }
});

test('refusal of an unrelated file mutation preserves a complete read-only research result', async t => {
  const f = await fixture(t);
  const task = await f.run([success({ denied_actions: ['write_file(/unrelated/output.md)', { tool: 'edit_file' }, { action: 'delete_file', name: 'delete_file' }] })]);
  assert.equal(task.status, 'done');
  const mixed = await f.run([success({ denied_actions: ['write_to_file', { action: 'web_search' }] })]);
  assert.equal(mixed.status, 'blocked', 'a benign write refusal cannot mask required lookup denial');
});

test('explicit Gemini errors, empty responses and earlier failed terminal envelopes cannot be accepted', async t => {
  const secret = 'fixture-private-raw-error';
  for (const events of [
    [success({ error: secret })], [success({ response: '  ' })], [success({ status: secret })],
    [success({ finished_reason: 'error' }), success()],
  ]) {
    const f = await fixture(t), task = await f.run(events);
    assert.equal(task.status, 'blocked'); assert.ok(!JSON.stringify(task).includes(secret));
    assert.ok(!JSON.stringify(f.logs).includes(secret));
  }
});

const story = (stage, more = {}) => ({ officeWorkflow: 'story-studio-v1', projectId: 'walkalone', stage, goal: 'Develop the next authorized scene.', canon: 'The protagonist keeps the established memory gap.', cycleId: 'fixture-cycle', sourceManifest: [{ path: 'canon.txt', sha256: 'a'.repeat(64) }], ...more });
const prompt = value => researchPrompt({ provider: 'gemini', title: '退界剧情·资料与创意', description: JSON.stringify(value) });

test('marked story research requests original ideas from accessible public sources and a bounded JSON contract', () => {
  const value = story('research'), text = prompt(value);
  assert.match(text, /Research and original ideation/); assert.match(text, /Verify URLs you actually accessed/);
  assert.match(text, /1–6 verified sources, 1–3 original ideas and 3–8 outline beats/);
  assert.match(text, /"accessedAt":"YYYY-MM-DD"/); assert.match(text, /complete JSON within 12 KB/);
  assert.match(text, /"blocked":true/); assert.ok(text.includes(JSON.stringify(value)));
  assert.match(text, /Do not edit files, run commands, change the task board/);
});

test('marked story assessment uses the provided draft and canon without mandatory search or code-review approval', () => {
  const value = story('story_review', { draft: 'The protagonist entered the room.', researchBrief: '{"ideas":[]}' });
  const text = prompt(value);
  assert.match(text, /read ONLY the supplied current draft, canon and researchBrief/);
  assert.match(text, /Do not browse or search the web/);
  assert.match(text, /"verdict":"revise"/); assert.match(text, /short exact excerpt from the current draft/);
  assert.match(text, /Never emit a software APPROVED verdict/);
  assert.doesNotMatch(text, /Use web search and fetch|Research and original ideation/);
  assert.ok(text.includes(JSON.stringify(value)));
});

test('ordinary and malformed Gemini tasks keep the existing research prompt', () => {
  for (const value of [story('other'), story('story_review'), story('research', { projectId: 'other' }), { ...story('research'), officeWorkflow: 'unknown' }, [], null]) {
    const text = prompt(value);
    assert.match(text, /Use web search and fetch to find current, sourced answers/);
    assert.doesNotMatch(text, /Bounded stage input/);
  }
});


test('story stages reporting blocked or malformed JSON stay blocked despite successful Gemini exit', async t => {
  const f = await fixture(t), privateReason = 'fixture-private-source-unavailable';
  const responses = [JSON.stringify({ blocked: true, reason: privateReason }), '```json\n'+JSON.stringify({ blocked: true, reason: privateReason })+'\n```', '{"sources":[', 'Incomplete story response', 'null', '[]', '42', '"a string"'];
  for (const stage of ['research', 'story_review']) {
    for (const response of responses) {
      const description = JSON.stringify(story(stage, stage === 'story_review' ? { draft: 'An original current draft.', researchBrief: '{}' } : {}));
      const task = await f.run([success({ response })], '', { description });
      assert.equal(task.status, 'blocked');
      assert.equal(task.result, '');
      assert.match(task.error, /剧情阶段未交付完整结构化结果/);
      assert.doesNotMatch(JSON.stringify(task), new RegExp(privateReason));
      assert.notEqual(task.completionSource, 'agent');
    }
  }
  assert.equal((await readdir(f.researchDir)).length, 0, 'failed story stages must not publish successful research notes');
});

test('complete story JSON still saves notes and ordinary research keeps its existing text contract', async t => {
  const f = await fixture(t);
  const research = { sources: [{ url: 'https://example.com/story', title: 'Fixture source', accessedAt: '2026-11-13' }], ideas: [{ title: 'Original scene', premise: 'A difficult choice', technique: 'Foreshadowing' }], outline: [{ beat: 'Setup', purpose: 'Introduce motive' }, { beat: 'Conflict', purpose: 'Raise cost' }, { beat: 'Choice', purpose: 'Commit' }] };
  const review = { verdict: 'ready', feedback: [{ issue: 'Motivation is clear', evidence: 'An original current draft.', suggestion: 'Keep the stated motive.' }] };
  for (const [stage, response] of [['research', JSON.stringify(research)], ['story_review', '```json\n'+JSON.stringify(review)+'\n```']]) {
    const description = JSON.stringify(story(stage, stage === 'story_review' ? { draft: 'An original current draft.', researchBrief: JSON.stringify(research) } : {}));
    const task = await f.run([success({ response })], '', { description });
    assert.equal(task.status, 'done');
    assert.equal(task.completionSource, 'agent');
    assert.match(task.result, /Research note:/);
  }
  const ordinary = await f.run([success({ response: 'A plain Markdown research note remains valid.' })]);
  assert.equal(ordinary.status, 'done');
  assert.equal((await readdir(f.researchDir)).length, 3);
});
