import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeExecutionReader, parseClaudeExecutionRecords, reconcileClaudeExecution } from '../server/claude-execution.mjs';
import { readClaudeStatus, reconstructAgents } from '../server/claude-bridge.mjs';

const now = Date.parse('2026-11-12T01:00:00Z');
const iso = value => new Date(value).toISOString();
const child = { id: 'session:child', sessionId: 'session', agentId: 'child', isSubagent: true, observed: true, status: 'working', executionState: 'unconfirmed', lastEvent: 'PreToolUse', lastEventAt: iso(now - 1000) };
const sessions = new Map([['session', { pid: 321, alive: true, startedAt: now - 600000 }]]);
const event = (extra = {}) => ({ sessionId: 'session', agentId: 'child', event: 'PreToolUse', timestamp: now - 1000, pid: 321, ...extra });
const row = (type, content, extra = {}) => JSON.stringify({ type, sessionId: 'session', agentId: 'child', timestamp: iso(now - 1000), message: { role: type, content }, ...extra }) + '\n';

test('fresh individual lifecycle plus matching current live process confirms, expired/no owner/reused process does not', () => {
  for (const age of [0, 60000, 120000]) {
    const actor = { ...child, lastEventAt: iso(now - age) };
    reconcileClaudeExecution([actor], sessions, [event({ timestamp: now - age })], new Map(), { now });
    assert.equal(actor.executionState, 'working');
    assert.equal(actor.evidenceExpiresAt, iso(now - age + 120000));
  }
  for (const [owner, hook] of [
    [{ pid: 321, alive: true, startedAt: now - 600000 }, event({ timestamp: now - 120001 })],
    [{ pid: 321, alive: false, startedAt: now - 600000 }, event()],
    [{ pid: 321, alive: true, startedAt: now }, event()],
    [{ pid: 999, alive: true, startedAt: now - 600000 }, event()],
    [{ pid: 321, alive: true }, event()],
  ]) {
    const actor = { ...child, lastEventAt: iso(hook.timestamp) };
    reconcileClaudeExecution([actor], new Map([['session', owner]]), [hook], new Map(), { now });
    assert.equal(actor.executionState, 'unconfirmed');
  }
});

test('fresh transcript confirms its own stale hook only; sibling and silent pending calls stay uncertain', () => {
  const actor = { ...child, lastEventAt: iso(now - 180000) }, sibling = { ...actor, id: 'session:other', agentId: 'other' };
  reconcileClaudeExecution([actor, sibling], sessions, [event({ timestamp: now - 180000 }), event({ agentId: 'other', timestamp: now - 180000 })], new Map([[child.id, { timestamp: now - 500, phase: 'generating' }]]), { now });
  assert.equal(actor.executionState, 'working'); assert.equal(actor.observationSource, 'claude-live-transcript');
  assert.equal(sibling.executionState, 'unconfirmed');
  const silent = { ...child, lastEventAt: iso(now - 180000) };
  reconcileClaudeExecution([silent], sessions, [event({ timestamp: now - 180000 })], new Map([[child.id, { timestamp: now - 180000, phase: 'tool-pending' }]]), { now });
  assert.equal(silent.status, 'working'); assert.equal(silent.executionState, 'unconfirmed');
});

test('terminal transcript closes missing stop hook without changing waiting or offline state', () => {
  const actor = { ...child }, waiting = { ...child, id: 'waiting', status: 'waiting', executionState: 'waiting' };
  reconcileClaudeExecution([actor, waiting], sessions, [event()], new Map([[child.id, { timestamp: now - 500, phase: 'finished' }], ['waiting', { timestamp: now - 500, phase: 'finished' }]]), { now });
  assert.equal(actor.status, 'idle'); assert.equal(actor.executionState, 'idle'); assert.equal(actor.observationSource, 'claude-transcript-terminal');
  assert.equal(waiting.status, 'waiting');
});

test('parser reads lifecycle fields and skips foreign actors, request blobs, reasoning and partial records', () => {
  const text = row('assistant', [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }], { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { command: 'PRIVATE_COMMAND' } }] } })
    + row('user', [{ type: 'tool_result', content: 'PRIVATE_RESULT' }], { timestamp: iso(now - 500) })
    + row('api-request-blob', 'PRIVATE_BLOB', { timestamp: iso(now) })
    + row('assistant', 'PRIVATE_FOREIGN', { agentId: 'other', timestamp: iso(now) }) + '{"partial":';
  assert.deepEqual(parseClaudeExecutionRecords(text, child), { timestamp: now - 500, phase: 'between-tools' });
  assert.deepEqual(parseClaudeExecutionRecords(row('assistant', 'PRIVATE_OUTPUT', { message: { role: 'assistant', stop_reason: 'stop_sequence', content: 'PRIVATE_OUTPUT' } }), child), { timestamp: now - 1000, phase: 'finished' });
  assert.equal(parseClaudeExecutionRecords(row('user', 'ordinary prompt'), child), null);
});

test('named primary agent transcript accepts its own ID and excludes sibling activity', () => {
  const primary = { ...child, id: 'session:main', agentId: 'primary', isSubagent: false };
  const own = row('assistant', 'private primary output', { agentId: 'primary', message: { role: 'assistant', stop_reason: 'end_turn' } });
  const sibling = row('assistant', 'private sibling output', { agentId: 'other', timestamp: iso(now), message: { role: 'assistant', stop_reason: 'tool_use' } });
  assert.deepEqual(parseClaudeExecutionRecords(own + sibling, primary), { timestamp: now - 1000, phase: 'finished' });
  assert.equal(parseClaudeExecutionRecords(own, { ...primary, agentId: null }), null);
});

test('child StopFailure targets child; main Stop never stops a different active child', () => {
  const events = [event({ event: 'SessionStart', agentId: null, timestamp: now - 5000 }), event({ event: 'SubagentStart', timestamp: now - 4000 }), event({ event: 'StopFailure', timestamp: now - 2000 }), event({ event: 'Stop', agentId: null, timestamp: now - 1000 })];
  const actors = reconstructAgents(events);
  assert.equal(actors.find(a => a.isSubagent).status, 'waiting');
  assert.equal(actors.find(a => !a.isSubagent).status, 'idle');
  assert.equal(reconstructAgents(events.filter(e => e.event !== 'StopFailure')).find(a => a.isSubagent).status, 'working');
  assert.equal(reconstructAgents([...events, event({ event: 'PostToolUse', timestamp: now })]).find(a => a.isSubagent).status, 'waiting');
  assert.equal(reconstructAgents([...events, event({ event: 'SubagentStart', timestamp: now })]).find(a => a.isSubagent).status, 'working');
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-execution-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sub = path.join(home, 'projects', 'project', 'session', 'subagents');
  await mkdir(sub, { recursive: true });
  await mkdir(path.join(home, 'ai-office', 'events'), { recursive: true });
  await mkdir(path.join(home, 'sessions'));
  await writeFile(path.join(home, 'sessions', '321.json'), JSON.stringify({ sessionId: 'session', pid: 321, startedAt: now - 600000 }));
  return { home, sub };
}

test('bounded reader refreshes terminal metadata, rejects symlinks and never returns private fields', async t => {
  const { home, sub } = await fixture(t), read = createClaudeExecutionReader({ claudeHome: home });
  const file = path.join(sub, 'agent-child.jsonl');
  await writeFile(file, row('assistant', 'PRIVATE_' + 'x'.repeat(300000)) + row('assistant', 'PRIVATE_CONTENT', { message: { role: 'assistant', stop_reason: 'tool_use' } }));
  assert.equal((await read([child])).get(child.id).phase, 'tool-pending');
  await appendFile(file, row('assistant', 'PRIVATE_FINAL', { timestamp: iso(now), message: { role: 'assistant', stop_reason: 'end_turn' } }));
  assert.deepEqual((await read([child])).get(child.id), { timestamp: now, phase: 'finished' });
  await rm(file); await symlink(path.join(home, 'sessions', '321.json'), file);
  assert.equal((await read([child])).has(child.id), false);
});

test('real status integration promotes only fresh live-owned activity, updates counts, closes finished child', async t => {
  const { home, sub } = await fixture(t);
  await writeFile(path.join(home, 'ai-office', 'events', 'event.json'), JSON.stringify(event({ event: 'PreToolUse', tool: 'Bash' })));
  let result = await readClaudeStatus({ claudeHome: home, now, isProcessAlive: () => true });
  assert.equal(result.agents.find(a => a.isSubagent).executionState, 'working');
  assert.equal(result.executionCounts.working, 1);
  await writeFile(path.join(sub, 'agent-child.jsonl'), row('assistant', 'PRIVATE', { timestamp: iso(now - 500), message: { role: 'assistant', stop_reason: 'end_turn' } }));
  result = await readClaudeStatus({ claudeHome: home, now, isProcessAlive: () => true });
  assert.equal(result.agents.find(a => a.isSubagent).status, 'idle');
  assert.equal(result.executionCounts.working, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
