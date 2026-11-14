import test from 'node:test';
import assert from 'node:assert/strict';
import { createQwenWorkReports } from '../server/qwen-work-reports.mjs';
const base = Date.parse('2026-11-12T12:00:00Z');
const active = (id = 'agent-1') => ({ id, observed: true, status: 'working', executionState: 'working', tool: 'Read', updatedAt: new Date(base).toISOString() });
function fixture(t, options = {}) {
  let time = base; const inputs = [], writes = [];
  const service = createQwenWorkReports({ projectPath: '/mock', prerequisiteIds: [], now: () => time,
    store: { snapshot: () => ({ tasks: [] }) }, file: { read: async () => null, write: async value => writes.push(value) },
    qwenClient: { summarizeRunningLogs: async source => { inputs.push(JSON.parse(source)); return { summary: '本地状态摘要草稿', highlights: ['只有所提供的状态事实。'] }; } }, ...options });
  t.after(() => service.stop());
  return { service, inputs, writes, advance(ms) { time += ms; } };
}

test('native metadata drives useful summaries; wall clock polling and unchanged snapshots do not repeat inference', async t => {
  let agent = active();
  const f = fixture(t, { claudeReader: () => ({ connected: true, observedAt: new Date().toISOString(), agents: [agent] }) });
  let state = await f.service.start(); assert.equal(f.inputs.length, 1);
  assert.equal(state.counts.totalLogs, 1); assert.equal(state.logSummary.source, 'local-qwen');
  f.advance(60000); agent = { ...agent, updatedAt: new Date(base + 60000).toISOString() };
  await f.service.tick(); assert.equal(f.inputs.length, 1, 'native heartbeat timestamps alone are not new work');
  agent = { ...agent, tool: 'Bash' }; state = await f.service.tick(); assert.equal(f.inputs.length, 2);
  assert.equal(state.runningLogs[0].tool, 'Bash');
  agent = { ...agent, tool: 'Write' }; state = await f.service.tick();
  assert.equal(f.inputs.length, 2); assert.equal(state.logSummary.stale, true);
  f.advance(60000); await f.service.tick(); assert.equal(f.inputs.length, 3);
  assert.equal(f.writes.length, 0, 'live observations do not rewrite historical extraction cache');
});

test('idle snapshots do not manufacture model work; running requires explicit per-agent evidence and active runner', async t => {
  const f = fixture(t, { claudeReader: () => ({ connected: true, agents: [
    { ...active('idle'), status: 'idle', executionState: 'idle' },
    { ...active('missing'), executionState: undefined }, { ...active('unobserved'), observed: false },
  ] }), runtimeReader: () => ({ started: false, running: [{ provider: 'codex', taskId: 'stale-job' }] }) });
  const state = await f.service.start(); assert.equal(f.inputs.length, 0);
  assert.deepEqual(state.runningLogs.map(row => row.status).sort(), ['idle', 'unconfirmed', 'unconfirmed']);
  assert.equal(state.logSummary.facts.runnerJobs, 0);
});

test('runner lifecycle records deduplicate and exclude chat, arbitrary output, auth and private reader fields', async t => {
  const f = fixture(t, { grokReader: () => ({ connected: true, messages: ['PRIVATE_CHAT'], authorization: 'SECRET_AUTH', agents: [] }),
    codexReader: () => ({ connected: true, agents: [{ ...active(), prompt: 'PRIVATE_PROMPT', arguments: 'PRIVATE_ARGUMENT', result: 'PRIVATE_OUTPUT' }] }) });
  await f.service.start(); f.advance(60000);
  const row = { key: 'runner:t:started', type: 'task_started', provider: 'codex', taskId: 't', occurredAt: new Date(base).toISOString(), detail: 'SECRET_AUTH', title: 'PRIVATE_TITLE' };
  assert.equal(f.service.recordLog(row), true); assert.equal(f.service.recordLog(row), false);
  assert.equal(f.service.recordLog({ ...row, key: 'other', type: 'agent_message', detail: 'PRIVATE_CHAT' }), false);
  const state = await f.service.tick(); const serialized = JSON.stringify([state, f.inputs]);
  assert.doesNotMatch(serialized, /PRIVATE_|SECRET_AUTH/); assert.equal(state.logSummary.facts.runnerEvents, 1);
  assert.equal(state.runningLogs.find(row => row.category === 'runner').type, 'task_started');
});

test('partial source failure is visible and sanitized while readable native agents and history survive', async t => {
  let failed = true;
  const f = fixture(t, { claudeReader: () => { if (failed) throw new Error('PRIVATE_ERROR'); return { connected: true, agents: [] }; },
    codexReader: () => ({ connected: true, agents: [active()] }) });
  let state = await f.service.start(); assert.equal(state.phase, 'ready');
  assert.deepEqual(state.logSummary.sourceErrors, ['claude']); assert.equal(state.logSummary.phase, 'unavailable');
  assert.equal(state.runningLogs[0].status, 'working'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_ERROR/);
  failed = false; f.advance(60000); state = await f.service.tick();
  assert.deepEqual(state.logSummary.sourceErrors, []); assert.equal(state.logSummary.phase, 'watching');
});

test('bounded records and UTF-8 prompt budget cover large native teams with explicit omission counts', async t => {
  const agents = Array.from({ length: 400 }, (_, index) => active(`agent-${String(index).padStart(3, '0')}`));
  const f = fixture(t, { claudeReader: () => ({ connected: true, agents }) });
  const state = await f.service.start();
  assert.equal(state.runningLogs.length, 160); assert.equal(state.logSummary.facts.nativeAgents, 400);
  assert.equal(state.logSummary.facts.omitted, 240); assert.ok(f.inputs[0].omittedFromPrompt > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(f.inputs[0]), 'utf8') <= 16000);
});

test('foreground inference is not interrupted and failed summaries back off without hiding source records', async t => {
  let busy = true, calls = 0;
  const f = fixture(t, { claudeReader: () => ({ connected: true, agents: [active()] }),
    qwenClient: { runtimeState: () => ({ busy }), summarizeRunningLogs: async () => { calls++; throw new Error('PRIVATE_MODEL_ERROR'); } } });
  await f.service.start(); assert.equal(calls, 0);
  busy = false; let state = await f.service.tick(); assert.equal(calls, 1);
  assert.equal(state.runningLogs.length, 1); assert.equal(state.logSummary.source, 'structured-facts');
  assert.match(state.logSummary.error, /暂不可用/); assert.doesNotMatch(state.logSummary.error, /PRIVATE/);
  state = await f.service.tick(); assert.equal(calls, 1); assert.equal(state.logSummary.phase, 'unavailable');
  f.advance(60000); await f.service.tick(); assert.equal(calls, 2);
});

test('stop aborts log inference and publishes no late summary; actual events during inference mark result stale', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { claudeReader: () => ({ connected: true, agents: [active()] }),
    qwenClient: { summarizeRunningLogs: async (_source, { signal }) => { entered(); await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { summary: 'late', highlights: [] }; } } });
  const starting = f.service.start(); await started;
  assert.equal(f.service.status().started, true);
  assert.equal(f.service.status().phase, 'collecting');
  assert.equal(f.service.status().logSummary.phase, 'summarizing');
  const stopping = f.service.stop(); release(); await Promise.all([starting, stopping]);
  assert.equal(f.service.status().logSummary.phase, 'stopped'); assert.equal(f.service.status().logSummary.generatedAt, null);
  let release2, entered2; const began = new Promise(resolve => { entered2 = resolve; });
  const g = fixture(t, { codexReader: () => ({ connected: true, agents: [active()] }),
    qwenClient: { summarizeRunningLogs: async () => { entered2(); await new Promise(resolve => { release2 = resolve; }); return { summary: 'snapshot draft', highlights: [] }; } } });
  const run = g.service.start(); await began;
  g.service.recordLog({ key: 'new-event', type: 'task_done', provider: 'codex', taskId: 't' }); release2();
  assert.equal((await run).logSummary.stale, true);
});


test('compact source omissions remain explicit while current workers stay observable', async t => {
  const f = fixture(t, { claudeReader: () => ({ connected: true, agents: [active()], totalAgentCount: 6001, omittedOfflineCount: 6000 }) });
  const state = await f.service.start();
  assert.equal(state.runningLogs[0].status, 'working');
  assert.equal(state.logSummary.facts.nativeAgents, 1);
  assert.equal(state.logSummary.facts.omitted, 6000);
  assert.equal(state.logSummary.facts.archivedOfflineOmitted, 6000);
  assert.deepEqual(state.logSummary.sourceErrors, []);
});
