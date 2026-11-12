import test from 'node:test';
import assert from 'node:assert/strict';
import { agentExecutionDisplay, isConfirmedExecution, officeExecutionCounts, officeRuntimeWorkers } from '../src/claude-execution.js';
import { buildSharedRoster, workingOfficeAgents, withTaskWorkers } from '../src/unified-office.js';
import { claudeWorkerGroups } from '../src/claude-office.js';
import { officeActivityCounts, connectedProviderResidents, findTaskAgent, taskMatchesAgent } from '../src/office-ui.js';
import { createSharedLayout } from '../src/shared-layout.js';
const worker = (id, extra = {}) => ({ id, sessionId: id, status: 'working', executionState: 'working', observed: true, isSubagent: false, ...extra });

test('every active surface requires explicit observed execution, and retains unknown records off the floor', () => {
  const states = { claude: { connected: true, agents: [worker('old-hook', { executionState: 'unconfirmed', updatedAt: '2020-01-01', observationSource: 'claude-lifecycle-hooks' }), worker('no-execution', { executionState: undefined }), worker('not-observed', { observed: false })] }, codex: { connected: true, agents: [worker('real'), worker('idle', { status: 'idle', executionState: 'idle' }), worker('ambiguous-idle', { status: 'idle', executionState: undefined })] } };
  const roster = buildSharedRoster(states);
  const counts = officeExecutionCounts(roster.flatMap(agent => agent.runtimeAgents));
  assert.deepEqual(counts, { active: 3, recorded: 2, confirmed: 1, idle: 1, waiting: 0, unconfirmed: 2 });
  assert.deepEqual(officeActivityCounts(roster), { confirmed: 1, recorded: 2 });
  const layout = createSharedLayout(roster);
  assert.deepEqual(layout.agents.map(agent => agent.runtimeAgents[0].id), ['real']);
  assert.equal(workingOfficeAgents(roster).length, counts.confirmed);
  assert.equal(claudeWorkerGroups(roster).running.length, counts.confirmed);
  assert.equal(claudeWorkerGroups(roster).unconfirmed.length, counts.recorded + counts.unconfirmed);
  assert.equal(layout.zones.find(zone => zone.id === 'claude').workingCount, 0);
  assert.equal(layout.zones.find(zone => zone.id === 'claude').unconfirmedCount, 3);
  const residents = connectedProviderResidents({ ...states, roster });
  assert.equal(residents.find(item => item.key === 'claude').status, 'recorded-active');
  assert.equal(residents.find(item => item.key === 'codex').workingCount, 1);
  for (const candidate of [worker('unknown', { observed: undefined }), worker('unknown', { executionState: undefined }), worker('unknown', { executionState: 'unconfirmed' }), worker('unknown', { status: 'offline' })]) assert.equal(isConfirmedExecution(candidate), false);
  assert.equal(agentExecutionDisplay(worker('not-observed', { observed: false })), 'unconfirmed');
});

test('runner survives its own native-source outage without resurrecting cached peers or washing away failure', () => {
  const connection = { connected: false, metadataAvailable: false, error: 'Native source unavailable', agents: [worker('main'), worker('old-peer')] };
  const runtime = { started: true, running: [{ taskId: 'task', provider: 'codex', sessionId: 'main', workerId: 'runner' }], agents: [worker('runner', { taskId: 'task', sessionId: 'main', provider: 'Codex', agentType: 'office-task-runner', role: 'Helper' })] };
  const merged = withTaskWorkers(connection, runtime, 'Codex');
  assert.equal(merged.error, connection.error);
  assert.equal(merged.metadataAvailable, false);
  assert.equal(merged.connected, false);
  assert.equal(merged.agents.length, 2);
  assert.deepEqual(merged.runtimeVerifiedIds, ['main']);
  const roster = buildSharedRoster({ codex: merged });
  assert.deepEqual(workingOfficeAgents(roster).map(agent => agent.runtimeAgents[0].id), ['main']);
  assert.ok(!roster.some(agent => agent.runtimeAgents[0].id === 'old-peer'));
  assert.equal(connection.agents[1].status, 'working', 'input cache is not mutated');
  assert.equal(withTaskWorkers(connection, { ...runtime, unavailable: true }, 'Codex'), connection);
  assert.equal(workingOfficeAgents(buildSharedRoster({ codex: withTaskWorkers(connection, { ...runtime, unavailable: true }, 'Codex') })).length, 0);
  assert.equal(withTaskWorkers(connection, { agents: [{ ...runtime.agents[0], observed: false }] }, 'Codex'), connection);
});

test('failed or stale board cannot create runtime representatives or link unrelated same-provider agents', () => {
  const agent = { id: 'shared:codex:one', name: 'Codex task agent', provider: 'Codex', runtimeAgents: [worker('one', { sessionId: 'shared' })] };
  const task = { id: 't', provider: 'codex', assignee: { name: agent.name } };
  const runtime = { unavailable: true, providers: { codex: { available: true, authenticated: true } }, running: [{ taskId: 't', workerId: 'one', sessionId: 'shared', provider: 'codex' }] };
  assert.deepEqual(connectedProviderResidents({ runtime }), []);
  assert.equal(findTaskAgent(task, [agent], runtime), undefined);
  assert.equal(findTaskAgent({ provider: 'codex' }, [agent], {}), undefined);
  assert.equal(findTaskAgent({ ...task, assignee: { provider: 'claude', id: 'one' } }, [agent], {}), undefined);
  assert.equal(findTaskAgent({ ...task, assignee: { provider: 'codex', id: 'one' } }, [agent], {}), agent);
  assert.equal(taskMatchesAgent({ id: 't', provider: 'any' }, agent, { running: [{ taskId: 't', workerId: 'one', sessionId: 'shared', provider: 'claude' }] }), false);
});


test('Grok bot provider aliases preserve exact identity joins without introducing a second resident', () => {
  const agent = { id: 'shared:grok:bot', provider: 'Grok', runtimeAgents: [worker('bot')] };
  const task = { id: 'grok-task', provider: 'grok-bot', assignee: { id: 'bot', provider: 'grok-bot' } };
  assert.equal(findTaskAgent(task, [agent], {}, 'grok-bot'), agent);
  assert.equal(connectedProviderResidents({ grok: { connected: true }, roster: [agent] }).length, 1);
});


test('each worker keeps its own state when a legacy aggregate contains an idle sibling', () => {
  const parent = { id: 'group', provider: 'Codex', officeZone: 'codex', liveStatus: 'working', runtimeAgents: [worker('active'), worker('idle', { status: 'idle', executionState: 'idle' })] };
  assert.deepEqual(officeExecutionCounts(officeRuntimeWorkers([parent])), { active: 1, recorded: 0, confirmed: 1, idle: 1, waiting: 0, unconfirmed: 0 });
  assert.deepEqual(officeActivityCounts([parent]), { confirmed: 1, recorded: 0 });
  assert.equal(createSharedLayout([parent]).zones.find(zone => zone.id === 'codex').unconfirmedCount, 0);
  const offline = { ...parent, liveStatus: 'offline' };
  assert.equal(officeExecutionCounts(officeRuntimeWorkers([offline])).confirmed, 0);
  assert.equal(officeActivityCounts([offline]).confirmed, 0);
  assert.equal(workingOfficeAgents([offline]).length, 0);
  assert.equal(createSharedLayout([offline]).agents.length, 0);
  for (const liveStatus of ['idle', 'waiting', 'unconfirmed']) {
    const inconsistent = { ...parent, liveStatus };
    const workers = officeRuntimeWorkers([inconsistent]);
    assert.equal(officeExecutionCounts(workers).confirmed, 0);
    assert.equal(officeExecutionCounts(workers).recorded, 0);
    assert.equal(officeExecutionCounts(workers).unconfirmed, 1);
    assert.equal(officeActivityCounts([inconsistent]).confirmed, 0);
    assert.equal(workingOfficeAgents([inconsistent]).length, 0);
    assert.equal(createSharedLayout([inconsistent]).agents.length, 0);
    assert.equal(claudeWorkerGroups([inconsistent]).unconfirmed.length, 1);
  }
  assert.equal(parent.runtimeAgents[1].status, 'idle');
  assert.equal(parent.runtimeAgents[0].status, 'working');
});

test('previous runtime permissions expire on every early return and never arrive through native input', () => {
  const connection = { connected: false, metadataAvailable: false, runtimeVerifiedIds: ['old'], agents: [worker('old')] };
  for (const runtime of [{}, { unavailable: true, agents: [worker('old', { provider: 'Codex' })] }, { agents: [worker('old', { provider: 'Gemini' })] }]) {
    const merged = withTaskWorkers(connection, runtime, 'Codex');
    assert.equal(Object.hasOwn(merged, 'runtimeVerifiedIds'), false);
    assert.equal(workingOfficeAgents(buildSharedRoster({ codex: merged })).length, 0);
  }
  assert.deepEqual(connection.runtimeVerifiedIds, ['old']);
});

test('bare runner status needs its bound active job before it becomes execution evidence', () => {
  const native = { connected: false, metadataAvailable: true, agents: [] };
  const actor = worker('actual-session', { provider: 'Codex', agentType: 'office-task-runner', taskId: 'task', executionState: undefined });
  const valid = { started: true, running: [{ taskId: 'task', sessionId: 'actual-session', workerId: 'worker', provider: 'codex' }], agents: [actor] };
  for (const runtime of [{ agents: [actor] }, { ...valid, started: false }, { ...valid, running: [] }, { ...valid, running: [{ ...valid.running[0], provider: 'claude' }] }, { ...valid, running: [{ ...valid.running[0], taskId: 'other' }] }, { ...valid, running: [{ ...valid.running[0], sessionId: 'sibling' }] }, { ...valid, running: [{ ...valid.running[0], finished: true }] }]) {
    assert.equal(workingOfficeAgents(buildSharedRoster({ codex: withTaskWorkers(native, runtime, 'Codex') })).length, 0);
  }
  assert.equal(workingOfficeAgents(buildSharedRoster({ codex: withTaskWorkers(native, valid, 'Codex') })).length, 1);
});


test('explicit runner execution claims still require a current matching job for every runner identity field', () => {
  const native = { connected: false, metadataAvailable: true, agents: [] };
  for (const field of ['agentType', 'source', 'observationSource']) {
    for (const status of ['working', 'running']) {
      const actor = worker('session', { provider: 'Codex', [field]: 'office-task-runner', taskId: 'task', status, executionState: status });
      const job = { taskId: 'task', sessionId: 'session', provider: 'codex' };
      const valid = { started: true, running: [job], agents: [actor] };
      for (const runtime of [{ agents: [actor] }, { ...valid, started: false }, { ...valid, running: [] }, { ...valid, running: [{ ...job, finished: true }] }, { ...valid, running: [{ ...job, status: 'done' }] }, { ...valid, running: [{ ...job, taskId: 'other' }] }]) {
        const merged = withTaskWorkers(native, runtime, 'Codex');
        assert.equal(merged.agents[0].executionState, 'unconfirmed');
        assert.equal(workingOfficeAgents(buildSharedRoster({ codex: merged })).length, 0);
      }
      const confirmed = withTaskWorkers(native, valid, 'Codex');
      assert.equal(isConfirmedExecution(confirmed.agents[0]), true);
      if (status === 'working') assert.equal(workingOfficeAgents(buildSharedRoster({ codex: confirmed })).length, 1);
      assert.equal(actor.executionState, status);
    }
  }
});

test('idle compatibility is limited to started runner sources and independent heartbeat evidence remains valid', () => {
  for (const status of ['idle', 'waiting']) {
    for (const field of ['agentType', 'source', 'observationSource']) {
      const actor = worker('session', { provider: 'Codex', [field]: 'office-task-runner', status, executionState: undefined });
      assert.equal(withTaskWorkers({}, { started: true, agents: [actor] }, 'Codex').agents[0].executionState, status);
      assert.equal(withTaskWorkers({}, { started: false, agents: [actor] }, 'Codex').agents[0].executionState, 'unconfirmed');
      assert.equal(withTaskWorkers({}, { agents: [actor] }, 'Codex').agents[0].executionState, 'unconfirmed');
    }
    const unknown = worker('unknown', { provider: 'Codex', status, executionState: undefined });
    assert.equal(withTaskWorkers({}, { started: true, agents: [unknown] }, 'Codex').agents[0].executionState, 'unconfirmed');
  }
  const heartbeat = worker('lease', { provider: 'Codex', source: 'local-agent-heartbeat', observationSource: 'local-agent-heartbeat' });
  for (const started of [undefined, false, true]) {
    const merged = withTaskWorkers({}, { started, agents: [heartbeat] }, 'Codex');
    assert.equal(workingOfficeAgents(buildSharedRoster({ codex: merged })).length, 1);
  }
});


test('running aliases retain verified execution across roster, floor, room and provider counts', () => {
  const alias = worker('native-running', { status: 'running', executionState: 'running', observationSource: 'claude-live-lifecycle', evidenceExpiresAt: '2026-11-12T01:02:00Z' });
  const unknown = worker('unknown-running', { status: 'running', executionState: 'unconfirmed' });
  const states = { claude: { connected: true, agents: [alias, unknown] } };
  const roster = buildSharedRoster(states);
  assert.equal(roster[0].runtimeAgents[0].status, 'working');
  assert.equal(roster[0].runtimeAgents[0].evidenceExpiresAt, alias.evidenceExpiresAt);
  assert.equal(alias.status, 'running', 'native input is not changed');
  assert.deepEqual(officeActivityCounts(roster), { confirmed: 1, recorded: 1 });
  assert.equal(workingOfficeAgents(roster).length, 1);
  assert.equal(claudeWorkerGroups(roster).running.length, 1);
  const zone = createSharedLayout(roster).zones.find(zone => zone.id === 'claude');
  assert.equal(zone.workingCount, 1);
  assert.equal(zone.unconfirmedCount, 1);
  assert.equal(connectedProviderResidents({ ...states, roster })[0].workingCount, 1);
  const unobserved = buildSharedRoster({ claude: { connected: true, agents: [{ ...alias, observed: false }] } });
  assert.equal(workingOfficeAgents(unobserved).length, 0);
});
