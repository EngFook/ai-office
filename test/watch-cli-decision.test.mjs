import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { parseMeetingDecisions } from '../server/blocked-meeting-policy.mjs';
import { runWatchDecision } from '../server/watch-cli-decision.mjs';

function fixture(provider, { reply, ignoreSignals = false, timeoutMs = 5000, parseResponse } = {}) {
  const controller = new AbortController(), calls = [], signals = [];
  const result = runWatchDecision({ provider, binary: '/mock/cli', prompt: '自己判断，不运行工具', env: {}, platform: 'darwin', signal: controller.signal, timeoutMs, killGraceMs: 5, ...(parseResponse ? { parseResponse } : {}),
    spawnProcess: (binary, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, encoding, done) { child.prompt = (child.prompt || '') + chunk.toString(); done(); } });
      child.close = code => { child.emit('close', code); };
      calls.push({ binary, args, options, child });
      if (reply) queueMicrotask(() => { child.stdout.write(reply); child.close(0); });
      return child;
    },
    terminate: (child, signal) => { signals.push(signal); if (!ignoreSignals) child.close(143); },
  });
  return { result, controller, calls, signals };
}
async function started(fixture) { for (let i = 0; i < 100 && !fixture.calls.length; i++) await delay(2); assert.equal(fixture.calls.length, 1); return fixture.calls[0]; }

test('native Claude/Codex/Gemini success envelopes parse decisions with isolated non-writing CLI flags', async () => {
  const decisions = [{ taskId: 'a', action: 'retry' }];
  const payload = JSON.stringify({ decisions });
  const replies = {
    codex: [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }), JSON.stringify({ type: 'turn.completed' })].join('\n'),
    claude: JSON.stringify({ type: 'result', subtype: 'success', result: payload }),
    gemini: JSON.stringify({ status: 'SUCCESS', response: payload }),
  };
  await Promise.all(Object.entries(replies).map(async ([provider, reply]) => {
    const f = fixture(provider, { reply });
    assert.deepEqual(await f.result, decisions);
    const call = f.calls[0]; assert.equal(call.options.shell, false); assert.equal(call.options.detached, true);
    assert.ok(call.options.cwd.includes('office-watch-decision-'));
    assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!call.args.includes('--dangerously-skip-permissions'));
    if (provider === 'claude') { assert.equal(call.args[call.args.indexOf('--tools') + 1], ''); assert.ok(call.args.includes('--strict-mcp-config')); }
    if (provider === 'codex') { assert.ok(call.args.includes('read-only')); assert.ok(call.args.includes('--ignore-user-config')); }
    if (provider === 'gemini') { assert.ok(call.args.includes('plan')); assert.ok(call.args.includes('--sandbox')); }
    await assert.rejects(access(call.options.cwd));
  }));
});

test('malformed output, CLI failure events and missing confirmation never return decisions', async () => {
  for (const reply of ['garbage', JSON.stringify({ type: 'turn.completed' }), [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"decisions":[]}' } }), JSON.stringify({ type: 'error' }), JSON.stringify({ type: 'turn.completed' })].join('\n')]) {
    const f = fixture('codex', { reply }); await assert.rejects(f.result);
  }
});

test('cancel and timeout terminate only the owned decision process and eventually release it', async () => {
  const f = fixture('codex', { ignoreSignals: true }); const call = await started(f);
  const rejected = assert.rejects(f.result);
  f.controller.abort(); await rejected;
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); await assert.rejects(access(call.options.cwd));
  const timed = fixture('gemini', { timeoutMs: 5 });
  await assert.rejects(timed.result); assert.deepEqual(timed.signals, ['SIGTERM']);
});

test('meeting parser retains only bounded analysis and typed plans from all native envelopes', async () => {
  const decision = { taskId: 'a', action: 'wait', resolved: false, evidence: 'Needs approval.', subtasks: [] };
  const payload = JSON.stringify({ decisions: [decision] });
  const replies = {
    codex: [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }), JSON.stringify({ type: 'turn.completed' })].join('\n'),
    claude: JSON.stringify({ type: 'result', subtype: 'success', result: payload }),
    gemini: JSON.stringify({ status: 'SUCCESS', response: payload }),
  };
  await Promise.all(Object.entries(replies).map(async ([provider, reply]) => {
    assert.deepEqual(await fixture(provider, { reply, parseResponse: parseMeetingDecisions }).result, [decision]);
  }));
});
