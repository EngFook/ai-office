import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_DEPARTMENTS, buildSharedRoster, codexOfficeRole, officeAgentLabel, officeRoleLabel, officeRoleDescription, migrateOfficeRecords, officeBridgeAvailable, resolveSharedSelection, workingOfficeAgents } from '../src/unified-office.js';

const worker = (id, status = 'working', extra = {}) => ({ id, sessionId: 'session', name: id, agentType: 'worker', isSubagent: true, observed: true, status, updatedAt: '2026-11-02T00:00:00Z', ...extra });

test('only actual runtime workers become people and providers cannot collide on identity or seats', () => {
  const states = { claude: { skills: [{ id: 'gamedev:game-ai', name: 'Game AI' }], agents: [worker('same-id')] }, codex: { agents: [worker('same-id')] }, grok: { agents: [worker('same-id')] } };
  const roster = buildSharedRoster(states);
  assert.equal(roster.length, 3);
  assert.equal(new Set(roster.map(agent => agent.id)).size, 3);
  assert.equal(new Set(roster.map(agent => agent.index)).size, 3);
  assert.deepEqual(roster.map(agent => agent.department), SHARED_DEPARTMENTS.slice(0, 3));
  assert.equal(roster.find(agent => agent.provider === 'Grok').department, 'Grok Dispatch');
  assert.equal(roster.find(agent => agent.provider === 'Grok').role, 'Manager');
  assert.deepEqual(roster.map(agent => agent.officeZone), ['claude', 'codex', 'grok']);
  assert.ok(roster.every(agent => agent.floor === 3 && agent.runtimeAgents.length === 1 && agent.officeSlot === 0));
  assert.deepEqual(buildSharedRoster({ claude: { skills: states.claude.skills, agents: [] } }), []);
});

test('worker indexes and per-provider slots survive status changes, reordered polls and bridge outages', () => {
  const seats = new Map();
  const initial = buildSharedRoster({ claude: { agents: [worker('b'), worker('c', 'idle')] }, codex: { agents: [worker('x', 'waiting')] } }, seats);
  const indexes = new Map(initial.map(agent => [agent.id, [agent.index, agent.officeSlot]]));
  const changed = buildSharedRoster({ claude: { error: 'offline', agents: [worker('c'), worker('b')] }, codex: { agents: [worker('x', 'idle')] }, grok: { agents: [worker('z')] } }, seats);
  for (const agent of changed.filter(agent => indexes.has(agent.id))) assert.deepEqual([agent.index, agent.officeSlot], indexes.get(agent.id));
  buildSharedRoster({}, seats);
  const returned = buildSharedRoster({ claude: { agents: [worker('a'), worker('b', 'waiting')] } }, seats);
  const b = returned.find(agent => agent.runtimeAgents[0].id === 'b');
  assert.deepEqual([b.index, b.officeSlot], indexes.get(b.id));
  assert.equal(new Set(returned.map(agent => agent.index)).size, returned.length);
});

test('working filter excludes waiting, idle, ended, unobserved and unavailable activity', () => {
  const roster = buildSharedRoster({ claude: { agents: [worker('running'), worker('idle', 'idle'), worker('waiting', 'waiting'), worker('ended', 'offline'), worker('detected', 'working', { observed: false })] }, codex: { error: 'bridge unavailable', agents: [worker('stale')] }, grok: { connected: false, agents: [worker('disconnected')] } });
  assert.deepEqual(workingOfficeAgents(roster).map(agent => agent.runtimeAgents[0].id), ['running']);
  assert.equal(roster.find(agent => agent.runtimeAgents[0].id === 'waiting').liveStatus, 'waiting');
  assert.equal(roster.find(agent => agent.runtimeAgents[0].id === 'idle').liveStatus, 'idle');
  assert.equal(roster.find(agent => agent.runtimeAgents[0].id === 'detected').liveStatus, 'idle');
  assert.ok(!roster.some(agent => agent.runtimeAgents[0].id === 'ended'));
  assert.ok(roster.filter(agent => ['Codex', 'Grok'].includes(agent.provider)).every(agent => agent.liveStatus === 'offline' && agent.runtimeAgents[0].status === 'offline'));
  assert.equal(officeBridgeAvailable({ metadataAvailable: false }), false);
  assert.equal(workingOfficeAgents(buildSharedRoster({ codex: { metadataAvailable: false, agents: [worker('unavailable')] } })).length, 0);
  assert.equal(officeBridgeAvailable({ agents: [] }), true);
});

test('Codex roles use actor metadata with the coordinator as Facilitator', () => {
  assert.equal(codexOfficeRole(worker('root', 'working', { isSubagent: false, agentType: 'main', lastTool: 'test' })), 'Facilitator');
  assert.equal(codexOfficeRole({ agentType: 'planner', isSubagent: true }), 'Facilitator');
  assert.equal(codexOfficeRole({ agentPath: '/root/claude_hooks', isSubagent: true }), 'Admin');
  assert.equal(codexOfficeRole({ agentRole: 'reviewer', tool: 'exec_command' }), 'Tester');
  assert.equal(codexOfficeRole({ agentType: 'general-implementation', prompt: 'Please audit and plan', description: 'private quality work' }), 'Helper');
  assert.equal(codexOfficeRole({}), 'Helper');
  assert.equal(buildSharedRoster({ codex: { agents: [{ id: 'generic', status: 'idle' }] } })[0].role, 'Helper');
});

test('approved role labels change presentation while role and routing keys remain stable', () => {
  assert.equal(officeRoleLabel('Manager', 'Grok'), 'Dispatch Lead');
  assert.equal(officeRoleLabel('Manager', 'Claude Code'), 'Manager');
  assert.equal(officeRoleLabel('Researcher', 'Gemini'), 'Research Analyst');
  assert.equal(officeRoleLabel('Admin', 'Codex'), 'Coordinator');
  assert.equal(officeRoleLabel('Facilitator', 'Codex'), 'Facilitator');
  assert.equal(officeRoleLabel('Helper', 'Codex'), 'Builder');
  assert.equal(officeRoleLabel('Helper', 'Codex', { category: 'Design & Content' }), 'Helper');
  assert.equal(officeRoleLabel('Helper', 'Grok'), 'Helper');
  assert.equal(officeRoleLabel('Worker', 'Claude Code'), 'Builder');
  assert.match(officeRoleDescription({ provider: 'Codex' }), /release sign-off/);
  assert.equal(codexOfficeRole({ agentRole: 'Admin', agentType: 'office task runner' }), 'Admin');
  assert.equal(codexOfficeRole({ agentRole: 'Helper', agentType: 'office task runner' }), 'Helper');
  assert.equal(officeAgentLabel('Codex task worker'), 'Codex task agent');
  assert.equal(officeAgentLabel('My task worker'), 'My task worker');
  assert.equal(officeAgentLabel('Codex task worker: custom'), 'Codex task worker: custom');
});

test('selection follows provider-qualified identity and never switches to a colliding provider or reused slot', () => {
  const roster = buildSharedRoster({ claude: { agents: [worker('same')] }, codex: { agents: [worker('same')] } });
  const selected = roster.find(agent => agent.provider === 'Claude Code');
  const updated = buildSharedRoster({ claude: { agents: [worker('same', 'idle')] }, codex: { agents: [worker('same')] } });
  assert.equal(resolveSharedSelection(updated, selected).provider, 'Claude Code');
  assert.equal(resolveSharedSelection(updated, selected).liveStatus, 'idle');
  const removed = resolveSharedSelection(updated.filter(agent => agent.provider === 'Codex'), selected);
  assert.equal(removed.liveStatus, 'offline');
  assert.equal(removed.provider, 'Claude Code');
  assert.equal(removed.runtimeAgents[0].tool, null);
  assert.equal(resolveSharedSelection(roster, null), null);
});

test('runtime profiles expose only safe metadata and match skills without creating extra figures', () => {
  const [agent] = buildSharedRoster({ claude: { skills: [{ id: 'gamedev:game-ai', name: 'Game AI', description: 'Installed game AI skill', privateBody: 'PRIVATE' }], agents: [worker('one', 'working', { skillId: 'gamedev:game-ai', prompt: 'PRIVATE', arguments: 'PRIVATE', transcript: 'PRIVATE', lastTool: 'Read' })] } });
  assert.equal(agent.skill.name, 'Game AI');
  assert.equal(agent.runtimeAgents[0].provider, 'Claude Code');
  assert.equal(agent.runtimeAgents[0].lastTool, 'Read');
  assert.ok(!JSON.stringify(agent).includes('PRIVATE'));
});

test('migration preserves IDs, content and historical positions without inventing worker mappings', () => {
  const records = [{ id: 'assignment', floor: 1, agentId: 'old-codex-id', agentIndex: 149, name: 'Work', brief: 'Keep this content', custom: { keep: true } }, { id: 'report', floor: 2, index: 88, body: 'Keep report', legacyFloor: 1 }, { id: 'floor-wide', floor: 3, agentId: null, agentIndex: '' }];
  const original = structuredClone(records);
  const migrated = migrateOfficeRecords(records);
  assert.deepEqual(records, original);
  assert.ok(migrated.every(record => record.floor === 3));
  assert.equal(migrated[0].id, 'assignment');
  assert.equal(migrated[0].agentId, 'old-codex-id');
  assert.equal(migrated[0].legacyFloor, 1);
  assert.equal(migrated[0].legacyAgentIndex, 149);
  assert.deepEqual(migrated[0].custom, { keep: true });
  assert.equal(migrated[1].legacyFloor, 1);
  assert.equal(migrated[1].legacyIndex, 88);
  assert.equal(migrated[2].agentId, null);
  assert.deepEqual(migrateOfficeRecords(migrated), migrated);
});
