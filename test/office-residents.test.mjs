import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedProviderResidents, residentStatusLabel, residentActivitySummary } from '../src/office-ui.js';
import { buildSharedRoster, workingOfficeAgents } from '../src/unified-office.js';

const connected = { connected: true, agents: [], error: null };
const ready = { available: true, authenticated: true };
const worker = (id, provider, extra = {}) => ({ id, provider, liveStatus: 'working', runtimeAgents: [{ id, status: 'working', observed: true, executionState: 'working' }], ...extra });

test('only explicit live connection evidence creates one idle representative per connected provider', () => {
  assert.deepEqual(connectedProviderResidents(), []);
  assert.deepEqual(connectedProviderResidents({ claude: { hookInstalled: true }, codex: { connected: true, error: 'offline' }, grok: { configured: true }, runtime: { providers: { gemini: { available: true }, 'local-qwen': { available: true, authenticated: false } } } }), []);
  const residents = connectedProviderResidents({ claude: connected, codex: connected, grok: connected, runtime: { providers: { claude: ready, gemini: ready, 'local-qwen': ready } } });
  assert.equal(residents.length, 5);
  assert.equal(new Set(residents.map(item => item.id)).size, 5);
  assert.ok(residents.every(item => item.status === 'idle' && item.workingCount === 0 && item.activeTaskCount === 0));
  assert.equal(residents.find(item => item.key === 'claude').provider, 'Claude Code');
});

test('observed active workers provide connection evidence; catalog entries, idle or unobserved workers do not', () => {
  const roster = [worker('a', 'Claude Code'), worker('b', 'Claude Code'), worker('c', 'Codex', { liveStatus: 'idle' }), worker('d', 'Gemini', { runtimeAgents: [{ id: 'd', status: 'working', observed: false }] })];
  const before = JSON.stringify(roster);
  assert.deepEqual(connectedProviderResidents({ roster }), [{ id: 'resident:claude', key: 'claude', provider: 'Claude Code', status: 'working', workingCount: 2, recordedActiveCount: 0, activeTaskCount: 0 }]);
  assert.equal(JSON.stringify(roster), before);
  assert.deepEqual(connectedProviderResidents({ claude: { skills: [{ id: 'installed-skill' }] } }), []);
});

test('running task records set activity before native session appears without inflating worker headcount', () => {
  const runtime = { started: true, running: [{ taskId: 'qwen-task', provider: 'local-qwen', workerId: 'worker', sessionId: null }, { taskId: 'qwen-task', provider: 'local-qwen', workerId: 'worker' }, { taskId: 'bot-task', provider: 'grok-bot' }, { provider: 'claude' }, { taskId: 'old', provider: 'codex', finished: true }, { taskId: 'queued', provider: 'gemini', status: 'pending' }] };
  const residents = connectedProviderResidents({ runtime });
  assert.deepEqual(residents.map(item => item.key).sort(), ['grok', 'local-qwen']);
  assert.ok(residents.every(item => item.status === 'working' && item.workingCount === 0 && item.activeTaskCount === 1));
  const withSession = connectedProviderResidents({ runtime, roster: [worker('native', 'Local Qwen')] }).find(item => item.key === 'local-qwen');
  assert.equal(withSession.workingCount, 1);
  assert.equal(withSession.activeTaskCount, 1);
});

test('representative identity survives active-to-idle transition while actual roster counts remain unchanged', () => {
  const state = { ...connected, agents: [{ id: 'native', status: 'working', executionState: 'working', observed: true }] };
  const roster = buildSharedRoster({ claude: state });
  const active = connectedProviderResidents({ claude: state, roster });
  assert.equal(workingOfficeAgents(roster).length, 1);
  assert.equal(roster.length, 1);
  const idleState = { ...state, agents: [{ id: 'native', status: 'idle', observed: true }] };
  const idleRoster = buildSharedRoster({ claude: idleState });
  const idle = connectedProviderResidents({ claude: idleState, roster: idleRoster });
  assert.equal(idle[0].id, active[0].id);
  assert.equal(idle[0].status, 'idle');
  assert.equal(idle[0].workingCount, 0);
  assert.equal(workingOfficeAgents(idleRoster).length, 0);
  assert.equal(idleRoster.length, 1);
  assert.deepEqual(connectedProviderResidents({ claude: { ...idleState, connected: false } }), []);
});


test('configured Grok webhook retains an on-demand representative after heartbeat expiry without creating workers or online state', () => {
  const grok = { connected: false, bot: { connected: false, agents: [] }, agents: [], skills: [] };
  const grokWake = { configured: true, lastSentAt: '2026-11-09T15:28:00Z', error: null };
  const before = JSON.stringify({ grok, grokWake });
  const roster = buildSharedRoster({ grok });
  const residents = connectedProviderResidents({ grok, grokWake, roster });
  assert.deepEqual(residents, [{ id: 'resident:grok', key: 'grok', provider: 'Grok', status: 'on-demand', workingCount: 0, recordedActiveCount: 0, activeTaskCount: 0 }]);
  assert.equal(residentStatusLabel(residents[0], 'zh'), '按需唤醒');
  assert.equal(residentStatusLabel(residents[0], 'en'), 'Wake on demand');
  assert.equal(workingOfficeAgents(roster).length, 0);
  assert.equal(roster.length, 0);
  assert.equal(grok.connected, false);
  assert.equal(JSON.stringify({ grok, grokWake }), before);
  assert.deepEqual(connectedProviderResidents({ grok, grokWake: { configured: false } }), []);
});

test('Grok representative keeps identity across working, heartbeat standby, expired lease and wake failure', () => {
  const grokWake = { configured: true };
  const active = connectedProviderResidents({ grok: connected, grokWake, roster: [worker('real-grok', 'Grok')] })[0];
  const standby = connectedProviderResidents({ grok: connected, grokWake })[0];
  const expired = connectedProviderResidents({ grok: { connected: false }, grokWake })[0];
  const failed = connectedProviderResidents({ grok: { connected: false }, grokWake: { ...grokWake, error: 'Notification failed' } })[0];
  assert.equal(new Set([active, standby, expired, failed].map(value => value.id)).size, 1);
  assert.deepEqual([active, standby, expired, failed].map(value => value.status), ['working', 'idle', 'on-demand', 'unconfirmed']);
  assert.equal(active.workingCount, 1);
  assert.ok([standby, expired, failed].every(value => value.workingCount === 0 && value.activeTaskCount === 0));
  assert.equal(residentStatusLabel(failed, 'zh'), '状态待确认');
});


test('resident keeps all recorded Claude activity visible without claiming execution; a real runner is confirmed independently', () => {
  const claude = { connected: true, agents: Array.from({ length: 5 }, (_, i) => ({ id: `child-${i}`, status: 'working', observed: true, executionState: 'unconfirmed' })) };
  const roster = buildSharedRoster({ claude });
  const resident = connectedProviderResidents({ claude, roster, runtime: { running: [] } })[0];
  assert.equal(resident.status, 'recorded-active'); assert.equal(resident.workingCount, 0); assert.equal(resident.recordedActiveCount, 5);
  assert.equal(workingOfficeAgents(roster).length, 0);
  assert.equal(residentStatusLabel(resident, 'zh'), '活动待确认');
  assert.match(residentActivitySummary(resident, 'zh'), /当前执行状态待确认/);
  assert.doesNotMatch(residentActivitySummary(resident), /standing by|is running/);
  const running = connectedProviderResidents({ claude, roster, runtime: { started: true, running: [{ taskId: 'actual-board-job', provider: 'claude' }] } })[0];
  assert.equal(running.status, 'working'); assert.equal(running.activeTaskCount, 1); assert.equal(running.recordedActiveCount, 5);
  assert.match(residentActivitySummary(running), /confirmed session or task/);
});

test('native execution confirmation controls resident status for every provider, including absent confirmation', () => {
  for (const provider of ['Claude Code', 'Codex', 'Grok', 'Gemini', 'Local Qwen']) {
    for (const executionState of ['unconfirmed', undefined]) {
      const roster = [worker('native', provider, { runtimeAgents: [{ id: 'native', status: 'working', executionState: 'working', observed: true, executionState }] })];
      assert.equal(connectedProviderResidents({ roster })[0].status, 'recorded-active');
    }
    assert.equal(connectedProviderResidents({ roster: [worker('confirmed', provider)] })[0].status, 'working');
  }
});


test('stopped or unobserved runner snapshots do not create resident task activity', () => {
  const runtime = { running: [{ taskId: 'old', provider: 'codex' }] };
  assert.deepEqual(connectedProviderResidents({ runtime }), []);
  assert.deepEqual(connectedProviderResidents({ runtime: { ...runtime, started: false } }), []);
  const resident = connectedProviderResidents({ codex: connected, runtime: { ...runtime, started: false } })[0];
  assert.equal(resident.status, 'idle');
  assert.equal(resident.activeTaskCount, 0);
});
