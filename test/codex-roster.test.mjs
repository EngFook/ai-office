import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexRoster, CODEX_DEPARTMENTS, codexDepartment, codexDepartmentForIndex, codexSeatForIndex, codexWorkerIdentity } from '../src/codex-office.js';

test('Codex categories follow explicit roles, skill names and public tool metadata', () => {
  const cases = [
    [{ name: 'sdk' }, 'Engineering'],
    [{ name: 'sites' }, 'Engineering'],
    [{ name: 'imagegen' }, 'Design & Content'],
    [{ name: 'documents' }, 'Design & Content'],
    [{ name: 'presentations' }, 'Design & Content'],
    [{ name: 'create-game-assets' }, 'Design & Content'],
    [{ name: 'web-search' }, 'Research & Planning'],
    [{ name: 'data-analysis' }, 'Research & Planning'],
    [{ agentRole: 'explorer', name: 'Engineer' }, 'Research & Planning'],
    [{ name: 'review-security' }, 'Quality & Delivery'],
    [{ name: 'deploy-with-vercel' }, 'Quality & Delivery'],
    [{ agentType: 'test-runner' }, 'Quality & Delivery'],
    [{ agentRole: 'engineer', tool: 'image_gen__imagegen' }, 'Engineering'],
    [{ category: 'Quality & Delivery', agentRole: 'engineer' }, 'Quality & Delivery'],
    [{ isSubagent: true, tool: 'image_gen__imagegen' }, 'Design & Content'],
    [{ isSubagent: true, lastTool: 'web__search' }, 'Research & Planning'],
    [{ agentPath: '/root/security_review' }, 'Quality & Delivery'],
    [{ agentPath: '/root/claude_floor' }, 'Design & Content'],
    [{ agentPath: '/root/claude_hooks' }, 'Engineering'],
    [{ isSubagent: true, agentType: 'default', lastTool: 'image_gen__imagegen' }, 'Design & Content'],
    [{ agentType: 'main', tool: 'image_gen__imagegen' }, 'Engineering'],
    [{ name: 'Babbage', prompt: 'review security and design images', transcript: 'data analysis' }, 'Engineering'],
  ];
  for (const [metadata, expected] of cases) assert.equal(codexDepartment(metadata), expected, JSON.stringify(metadata));
});

test('installed skill profiles never claim to be observed workers or work without evidence', () => {
  const skills = [{ id: 'sdk', name: 'sdk', description: 'Develop integrations.' }, { id: 'imagegen', name: 'imagegen' }, { id: 'review', name: 'review' }];
  const roster = buildCodexRoster(skills);
  assert.equal(roster.length, 3);
  assert.ok(roster.every(agent => agent.kind === 'specialist' && agent.liveStatus === 'idle' && agent.runtimeAgents.length === 0));
  assert.ok(roster.every(agent => agent.floor === 1 && agent.provider === 'Codex'));
  assert.deepEqual(roster.map(agent => agent.department), ['Design & Content', 'Quality & Delivery', 'Engineering']);
  assert.equal(roster.find(agent => agent.skillId === 'sdk').description, 'Develop integrations.');
});

test('each actual Codex worker has exactly one figure and its own strict identity', () => {
  const roster = buildCodexRoster([{ id: 'sdk', name: 'sdk' }], [
    { id: 'session-123456:main', sessionId: 'session-123456', agentType: 'main', isSubagent: false, name: 'Codex coordinator', status: 'working', skillId: 'sdk' },
    { id: 'sub-789012', agentRole: 'reviewer', name: 'Ada', status: 'idle', isSubagent: true, skillId: 'sdk' },
    { id: 'closed', status: 'offline' },
    { id: 'not-observed', status: 'working', observed: false },
    { agentType: 'worker', status: 'working' },
  ]);
  const workers = roster.filter(agent => agent.kind === 'live');
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.flatMap(agent => agent.runtimeAgents.map(worker => worker.id)).sort(), ['session-123456:main', 'sub-789012']);
  assert.ok(workers.every(agent => agent.runtimeAgents.length === 1 && agent.runtimeAgents[0].provider === 'Codex'));
  assert.equal(roster.find(agent => agent.kind === 'specialist').liveStatus, 'idle');
  assert.equal(workers.find(agent => agent.name === 'Ada').liveStatus, 'idle');
  assert.equal(workers.find(agent => agent.name === 'Ada').department, 'Quality & Delivery');
  assert.deepEqual(codexWorkerIdentity(workers[0].runtimeAgents[0]), { label: 'Codex coordinator', shortId: '123456', project: 'Local project' });
  assert.equal(new Set(roster.map(agent => agent.index)).size, roster.length);
});

test('unknown statuses, connection loss and newest offline metadata never invent working agents', () => {
  const agents = [{ id: 'working', status: 'working' }, { id: 'waiting', status: 'waiting' }, { id: 'unknown', status: 'running' }];
  assert.equal(buildCodexRoster([], agents).filter(agent => agent.liveStatus === 'working').length, 1);
  assert.ok(buildCodexRoster([], agents, false).every(agent => agent.liveStatus === 'offline'));
  const duplicates = [{ id: 'same', status: 'working', updatedAt: 10 }, { id: 'same', status: 'offline', updatedAt: 20 }];
  assert.equal(buildCodexRoster([], duplicates).length, 0);
});

test('workers retain identities, departments and seats through new arrivals and skill changes', () => {
  const seats = new Map();
  const b = { id: 'b', isSubagent: true, agentRole: 'engineer', status: 'working' };
  const first = buildCodexRoster([{ id: 'sdk', name: 'sdk' }], [b], true, seats);
  const before = first.find(agent => agent.kind === 'live');
  const manyProfiles = Array.from({ length: 95 }, (_, index) => ({ id: `engineering-${index}`, name: 'coding' }));
  const second = buildCodexRoster(manyProfiles, [{ ...b, skillId: 'new-skill', tool: 'web__search' }, { id: 'a', status: 'working' }], true, seats);
  const after = second.find(agent => agent.id === before.id);
  assert.equal(after.index, before.index);
  assert.equal(after.department, before.department);
  assert.equal(after.runtimeAgents[0].id, 'b');
  assert.equal(after.skillId, 'new-skill');
  assert.equal(new Set(second.map(agent => agent.index)).size, second.length);
  buildCodexRoster([], [{ id: 'a', status: 'idle' }], true, seats);
  assert.equal(seats.has('b'), false);
  const third = buildCodexRoster([], [{ id: 'a', status: 'idle' }, { id: 'c', status: 'working' }], true, seats);
  assert.equal(third.find(agent => agent.runtimeAgents[0].id === 'c').index, before.index);
});

test('overflow preserves unique seats and each of the four departments', () => {
  const agents = CODEX_DEPARTMENTS.flatMap((department, group) => Array.from({ length: 24 }, (_, index) => ({ id: `group-${group}-${index}`, category: department, status: 'working' })));
  const skills = CODEX_DEPARTMENTS.flatMap((department, group) => Array.from({ length: 46 }, (_, index) => ({ id: `skill-${group}-${index}`, category: department, name: 'specialist' })));
  const roster = buildCodexRoster(skills, agents);
  assert.equal(new Set(roster.map(agent => agent.index)).size, roster.length);
  for (const agent of roster) assert.equal(CODEX_DEPARTMENTS[codexDepartmentForIndex(agent.index)], agent.department);
  assert.deepEqual(codexSeatForIndex(249), { department: 0, local: 99 });
  assert.ok(roster.some(agent => agent.index >= 400));
});
