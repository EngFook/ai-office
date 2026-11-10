import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { taskPrompt } from '../server/task-runner.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';
import { createGrokWake } from '../server/grok-wake.mjs';
import { createGrokManagement } from '../server/grok-management.mjs';
import { createTaskStore } from '../server/task-store.mjs';

function assertPolicy(prompt) {
  assert.match(prompt, /must never type, paste, or send messages to Grok Bot chat/);
  assert.match(prompt, /user's account, the local Grok Bot app, a browser session, UI automation, AppleScript, or a delegated script\/agent/);
  assert.match(prompt, /This includes progress updates, setup instructions and test messages/);
  assert.match(prompt, /only through the office pending-questions queue and its configured webhook wake/);
  assert.match(prompt, /do not fall back to chat/);
  assert.match(prompt, /own bot identity, never impersonating the user/);
}

async function temporaryHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-communication-policy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('all coding, review, research and recovery workers receive the user-only chat rule', () => {
  const base = { id: 'fixture', title: 'Fixture', description: 'Inspect supplied evidence.' };
  for (const provider of ['codex', 'claude', 'gemini']) {
    for (const kind of ['task', 'review', 'research', 'resolution']) {
      const prompt = taskPrompt({ ...base, provider, kind, huddleRetry: { active: true, previousError: 'Interrupted', previousResult: '' } });
      assertPolicy(prompt);
      assert.ok(prompt.indexOf('Only the user controls that chat.') < prompt.indexOf(base.description));
    }
  }
});

test('Qwen support and blocked-task discussion carry the rule in the system message', async t => {
  const home = await temporaryHome(t), requests = [];
  const client = createLocalQwen({ usageFile: path.join(home, 'usage.json'), fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return new Response(JSON.stringify({ done: true, message: { content: body.format === 'json' ? '{"summary":"fixture","suggestions":[]}' : 'Fixture observation.' } }));
  } });
  await client.run({ provider: 'local-qwen', supportType: 'log-triage', title: 'Fixture logs', description: 'One supplied log line.' });
  await client.discussBlocked({ tasks: [] });
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.messages[0].role, 'system');
    assertPolicy(body.messages[0].content);
    assert.equal(body.tools, undefined);
  }
});

test('optional Grok planning receives the same rule without launching chat automation', async t => {
  const home = await temporaryHome(t), store = createTaskStore({ home }), requests = [];
  const manager = createGrokManagement({ store, home, env: { XAI_API_KEY: 'fixture-only-key' }, intervalMs: 100000,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'grok-4-fast-non-reasoning' }] }));
      const body = JSON.parse(init.body); requests.push(body);
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"Fixture plan","roles":[],"tasks":[]}' }] }] }));
    } });
  t.after(() => { manager.stop(); store.close(); });
  store.createInstruction({ text: 'Fixture planning request.' });
  await manager.start();
  await manager.kick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input[0].role, 'system');
  assertPolicy(requests[0].input[0].content);
});

test('webhook instructs bot identity and queue lookup; failure leaves delivery unacknowledged', async t => {
  const home = await temporaryHome(t), calls = [];
  const wake = createGrokWake({ home, env: {}, fetchImpl: async (url, init) => { calls.push({ url, init }); throw new Error('Fixture offline transport.'); } });
  t.after(() => wake.stop());
  const question = { id: 'human:fixture', taskId: 'fixture', state: 'pending', kind: 'info', question: 'Supply fixture input.' };
  assert.equal((await wake.notify([question])).sent, false);
  assert.equal(calls.length, 0, 'unconfigured transport never attempts another route');
  wake.configure({ url: 'https://api2.cursor.sh/routines/fixture/trigger', token: 'fixture-token' });
  assert.equal((await wake.notify([question])).sent, false);
  assert.equal(calls.length, 1, 'failed webhook never attempts a chat fallback');
  const body = JSON.parse(calls[0].init.body);
  assertPolicy(body.message);
  assert.match(body.message, /MUST run office-board.mjs pending-questions/);
  assert.match(body.message, /not approval/);
  assert.equal(question.state, 'pending');
  assert.ok(wake.status().error);
});
