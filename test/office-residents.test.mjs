import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedProviderResidents } from '../src/office-ui.js';
import { buildSharedRoster, workingOfficeAgents } from '../src/unified-office.js';

const connected = { connected: true, agents: [], error: null };
const ready = { available: true, authenticated: true };
const worker = (id, provider, extra = {}) => ({ id, provider, liveStatus: 'working', runtimeAgents: [{ id, status: 'working', observed: true }], ...extra });

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
  assert.deepEqual(connectedProviderResidents({ roster }), [{ id: 'resident:claude', key: 'claude', provider: 'Claude Code', status: 'working', workingCount: 2, activeTaskCount: 0 }]);
  assert.equal(JSON.stringify(roster), before);
  assert.deepEqual(connectedProviderResidents({ claude: { skills: [{ id: 'installed-skill' }] } }), []);
});

test('running task records set activity before native session appears without inflating worker headcount', () => {
  const runtime = { running: [{ taskId: 'qwen-task', provider: 'local-qwen', workerId: 'worker', sessionId: null }, { taskId: 'qwen-task', provider: 'local-qwen', workerId: 'worker' }, { taskId: 'bot-task', provider: 'grok-bot' }, { provider: 'claude' }, { taskId: 'old', provider: 'codex', finished: true }, { taskId: 'queued', provider: 'gemini', status: 'pending' }] };
  const residents = connectedProviderResidents({ runtime });
  assert.deepEqual(residents.map(item => item.key).sort(), ['grok', 'local-qwen']);
  assert.ok(residents.every(item => item.status === 'working' && item.workingCount === 0 && item.activeTaskCount === 1));
  const withSession = connectedProviderResidents({ runtime, roster: [worker('native', 'Local Qwen')] }).find(item => item.key === 'local-qwen');
  assert.equal(withSession.workingCount, 1);
  assert.equal(withSession.activeTaskCount, 1);
});

test('representative identity survives active-to-idle transition while actual roster counts remain unchanged', () => {
  const state = { ...connected, agents: [{ id: 'native', status: 'working', observed: true }] };
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
