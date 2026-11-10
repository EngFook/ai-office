import test from 'node:test';
import assert from 'node:assert/strict';
import { taskMatchesAgent, findTaskAgent, modelReadiness, officeDepartmentFocus, roomProvider } from '../src/office-ui.js';

test('drawer follows runner claim to native main session without selecting a sibling subagent', () => {
  const task = { id: 'task-1', provider: 'codex', assignee: { id: 'runner-worker', provider: 'codex' } };
  const child = { id: 'shared:codex:child', provider: 'Codex', runtimeAgents: [{ id: 'child', sessionId: 'native-session', isSubagent: true }] };
  const main = { id: 'shared:codex:main', provider: 'Codex', runtimeAgents: [{ id: 'main', sessionId: 'native-session', isSubagent: false }] };
  const runtime = { running: [{ taskId: 'task-1', workerId: 'runner-worker', sessionId: 'native-session' }] };
  assert.equal(taskMatchesAgent(task, child, runtime), false);
  assert.equal(taskMatchesAgent(task, main, runtime), true);
  assert.equal(findTaskAgent(task, [child, main], runtime), main);
});
test('blocked task links retain direct worker identity and use explicit provider hints when unassigned', () => {
  const agent = { id: 'shared:claude:a', provider: 'Claude Code', runtimeAgents: [{ id: 'a' }] };
  assert.equal(findTaskAgent({ assignee: 'a' }, [agent], {}), agent);
  assert.equal(findTaskAgent({ provider: 'any' }, [agent], {}, 'claude'), agent);
  assert.equal(findTaskAgent({ provider: 'codex' }, [agent], {}), undefined);
});
test('drawer readiness distinguishes checking, authenticated models and Grok connection state', () => {
  assert.equal(modelReadiness('Codex'), undefined);
  assert.equal(modelReadiness('Codex', {providers:{codex:{available:true,authenticated:false}}}), false);
  assert.equal(modelReadiness('Codex', {providers:{codex:{available:true,authenticated:true}}}), true);
  assert.equal(modelReadiness('Grok', {}, {connected:true}), true);
  assert.equal(modelReadiness('Grok', {}, {connected:true,loading:true}), undefined);
});

test('department navigation follows fixed scene zones with Gemini after the specialist reviewers', async () => {
  const { createSharedLayout } = await import('../src/shared-layout.js');
  const layout = createSharedLayout();
  for (const [index, zone] of ['claude','codex','grok','gemini','local-qwen'].entries()) {
    const focus = officeDepartmentFocus(index);
    assert.equal(layout.zones[Number(focus.split('-')[1])].id, zone);
    assert.ok(roomProvider(focus));
  }
  assert.equal(roomProvider('department-3'), undefined);
  assert.equal(roomProvider('department-6'), undefined);
});
