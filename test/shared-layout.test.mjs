import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSharedRoster, resolveSharedSelection, workingOfficeAgents } from '../src/unified-office.js';
import { createSharedLayout, REVIEWER_ROLES, sharedFocusArea, sharedSeatForAgent, WORKSTATION_GEOMETRY, WORKSTATION_GRID } from '../src/shared-layout.js';

const runtime = (id, status = 'working') => ({ id, status, isSubagent: true, observed: true, name: id });
const state = (provider, count) => ({ connected: true, agents: Array.from({ length: count }, (_, index) => runtime(`${provider}-${String(index).padStart(3, '0')}`)) });
const position = seat => [seat.zone, seat.slot, seat.x, seat.z, seat.chairX, seat.chairZ, seat.angle];
const epsilon = 1e-8;
const expectedRoles = ['Playtester', 'UX/UI Reviewer', 'Performance Engineer', 'Code Reviewer'];
const fixedCounts = { claude: 20, codex: 6, reviewers: 4, grok: 1 };
const board = () => ({
  roles: expectedRoles.map(name => ({ name, provider: 'grok' })),
  tasks: [
    { provider: 'codex', role: 'Tester', status: 'pending' },
    { provider: 'codex', role: 'Helper', status: 'running' },
    { provider: 'claude', role: 'any', status: 'pending' },
  ],
});
function contains(area, x, z, halfWidth = 0, halfDepth = 0) {
  return x - halfWidth >= area.x - area.width / 2 - epsilon && x + halfWidth <= area.x + area.width / 2 + epsilon && z - halfDepth >= area.z - area.depth / 2 - epsilon && z + halfDepth <= area.z + area.depth / 2 + epsilon;
}
function overlaps(a, b) {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 - epsilon && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 - epsilon;
}
const rugFor = desk => ({ x: desk.podX, z: desk.podZ, width: desk.podWidth, depth: desk.podDepth });
function clearance(a, b) {
  const xGap = Math.max(0, Math.abs(a.x - b.x) - (a.width + b.width) / 2);
  const zGap = Math.max(0, Math.abs(a.z - b.z) - (a.depth + b.depth) / 2);
  return Math.hypot(xGap, zGap);
}
function assertFixedDesks(layout) {
  for (const [id, count] of Object.entries(fixedCounts)) {
    assert.equal(layout.desks.filter(desk => desk.zone === id).length, count, `${id} must keep its owner-specified capacity`);
    assert.equal(layout.zones.find(zone => zone.id === id).deskCount, count);
  }
  assert.deepEqual(layout.desks.filter(desk => desk.zone === 'reviewers').map(desk => desk.label).sort(), [...expectedRoles].sort());
  assert.equal(layout.desks.find(desk => desk.zone === 'grok').label, 'Grok Dispatch Lead');
}

test('quiet office has exactly 20 Claude, 6 Codex, four reviewer pods and one manager without invented people', () => {
  const layout = createSharedLayout();
  assertFixedDesks(layout);
  assert.equal(layout.desks.length, 37);
  assert.equal(layout.agents.length, 0);
  assert.equal(layout.placements.size, 0);
  assert.deepEqual([...REVIEWER_ROLES].sort(), [...expectedRoles].sort());
  assert.ok(layout.desks.every(desk => desk.occupant === null));
  for (const zone of layout.zones) assert.equal(zone.workingCount, 0);
  for (const [id, columns, rows] of [['codex', 3, 2], ['reviewers', 2, 2]]) {
    const desks = layout.desks.filter(desk => desk.zone === id);
    assert.equal(new Set(desks.map(desk => desk.x)).size, columns);
    assert.equal(new Set(desks.map(desk => desk.z)).size, rows);
  }
});

test('board roles, wildcards, duplicates and completed history never inflate the fixed workstation counts', () => {
  const data = board();
  data.roles.push({ name: ' code reviewer ', provider: 'grok' }, { name: 'Manager', provider: 'grok' });
  data.tasks.push({ provider: 'codex', role: 'Helper', status: 'blocked' });
  data.tasks.push(...Array.from({ length: 100 }, (_, index) => ({ provider: 'claude', role: `Historic role ${index}`, status: 'done' })));
  const layout = createSharedLayout([], new Map(), data);
  assertFixedDesks(layout);
  assert.equal(layout.desks.length, 37);
  assert.equal(layout.agents.length, 0);
  assert.deepEqual(layout.bounds, createSharedLayout().bounds);
  assert.equal(layout.zones.some(zone => zone.id === 'overflow'), false);
});

test('workers use existing team desks and matching reviewer pods before adding furniture', () => {
  const roster = buildSharedRoster({
    claude: { connected: true, agents: [{ ...runtime('designer'), agentRole: 'Game Designer' }, runtime('builder')] },
    codex: { connected: true, agents: [{ ...runtime('helper'), agentRole: 'Helper' }, { ...runtime('reviewer'), agentRole: 'Code Reviewer' }, { ...runtime('root'), isSubagent: false }] },
    grok: { connected: true, agents: [{ ...runtime('playtester'), agentRole: 'Playtester' }, { ...runtime('manager'), agentRole: 'Manager' }] },
  });
  const layout = createSharedLayout(roster, new Map(), board());
  assertFixedDesks(layout);
  assert.equal(layout.desks.length, 37);
  assert.equal(layout.placements.size, roster.length);
  for (const [id, label] of [['designer', 'UX/UI Reviewer'], ['reviewer', 'Code Reviewer'], ['playtester', 'Playtester']]) {
    const seat = sharedSeatForAgent(roster.find(agent => agent.runtimeAgents[0].id === id), layout);
    assert.equal(seat.zone, 'reviewers');
    assert.equal(seat.label, label);
  }
  assert.equal(sharedSeatForAgent(roster.find(agent => agent.runtimeAgents[0].id === 'manager'), layout).zone, 'grok');
  for (const agent of roster) {
    const seat = sharedSeatForAgent(agent, layout);
    assert.equal(seat.occupant.id, agent.id);
    assert.equal(seat.provider, agent.officeZone);
    const focus = sharedFocusArea(`agent-${agent.index}`, layout);
    assert.equal(focus.type, 'agent');
    assert.equal(focus.x, seat.chairX);
    assert.equal(focus.z, seat.chairZ);
  }
});

test('simultaneous workers sharing a reviewer role retain separate seats without adding management desks', () => {
  const roster = buildSharedRoster(Object.fromEntries(['claude', 'codex', 'grok'].map(provider => [provider, {
    connected: true,
    agents: [{ ...runtime(`${provider}-reviewer`), agentRole: '  code reviewer  ' }],
  }])));
  const layout = createSharedLayout(roster);
  assertFixedDesks(layout);
  assert.equal(layout.placements.size, 3);
  assert.equal(new Set([...layout.placements.values()].map(seat => `${seat.zone}:${seat.slot}`)).size, 3);
  assert.equal(layout.desks.filter(desk => desk.zone === 'reviewers' && desk.occupant).length, 1);
  assert.equal(layout.desks.find(desk => desk.zone === 'reviewers' && desk.occupant).label, 'Code Reviewer');
  assert.equal(layout.desks.find(desk => desk.zone === 'grok').occupant, null);
  assert.equal(layout.desks.filter(desk => desk.zone === 'overflow').length, 1);
});

test('idle history, waiting, ended, unobserved and unavailable workers never add pods or people', () => {
  const states = { claude: state('claude', 100), codex: state('codex', 40), grok: state('grok', 20) };
  for (const provider of Object.values(states)) provider.agents.forEach((agent, index) => { agent.status = index % 2 ? 'waiting' : 'idle'; });
  states.claude.agents[0].status = 'offline';
  states.claude.agents[1].status = 'working';
  states.claude.agents[1].observed = false;
  states.claude.agents[2].status = 'ended';
  states.codex.error = 'Bridge offline';
  const roster = buildSharedRoster(states);
  const inconsistent = { ...roster[0], id: 'inconsistent', liveStatus: 'working', runtimeAgents: [runtime('inconsistent', 'idle')] };
  const layout = createSharedLayout([...roster, inconsistent], new Map(), board());
  assert.equal(layout.agents.length, 0);
  assert.equal(layout.placements.size, 0);
  assert.equal(layout.desks.length, 37);
  assert.ok(layout.desks.every(desk => desk.occupant === null));
  for (const agent of roster) assert.equal(sharedSeatForAgent(agent, layout), undefined);
});

test('sparse historical provider indices use the fixed work-floor grid without empty overflow rows', () => {
  const roster = buildSharedRoster({ claude: state('claude', 2), codex: state('codex', 1), grok: state('grok', 1) }).map((agent, index) => ({ ...agent, officeSlot: 100000 + index * 100000 }));
  const layout = createSharedLayout(roster);
  assertFixedDesks(layout);
  assert.equal(layout.agents.length, 4);
  assert.equal(layout.desks.length, 37);
  assert.equal(layout.placements.size, 4);
  assert.deepEqual(layout.bounds, createSharedLayout().bounds);
  assert.ok([...layout.placements.values()].every(seat => seat.slot < 2));
});

test('ongoing workers retain their pods as peers finish, roles arrive and bridges recover', () => {
  const states = { claude: state('claude', 35), codex: state('codex', 16), grok: state('grok', 3) };
  const seats = new Map(), allocations = new Map();
  const original = buildSharedRoster(states, seats), before = createSharedLayout(original, allocations, board());
  const selected = original.find(agent => agent.runtimeAgents[0].id === 'codex-014');
  const positions = new Map(original.map(agent => [agent.id, position(sharedSeatForAgent(agent, before))]));
  states.codex.agents[0].status = 'idle';
  states.codex.agents.push(runtime('codex-new'));
  let roster = buildSharedRoster(states, seats), layout = createSharedLayout(roster, allocations, board());
  for (const agent of layout.agents.filter(agent => positions.has(agent.id))) assert.deepEqual(position(sharedSeatForAgent(agent, layout)), positions.get(agent.id));
  const updated = board();
  updated.tasks.push({ provider: 'codex', role: 'Admin', status: 'pending' });
  layout = createSharedLayout(roster, allocations, updated);
  for (const agent of layout.agents.filter(agent => positions.has(agent.id))) assert.deepEqual(position(sharedSeatForAgent(agent, layout)), positions.get(agent.id));
  states.claude.error = 'Temporary outage';
  roster = buildSharedRoster(states, seats);
  layout = createSharedLayout(roster, allocations, updated);
  assert.ok(layout.agents.every(agent => agent.officeZone !== 'claude'));
  for (const agent of layout.agents.filter(agent => positions.has(agent.id))) assert.deepEqual(position(sharedSeatForAgent(agent, layout)), positions.get(agent.id));
  delete states.claude.error;
  states.claude.agents.reverse();
  roster = buildSharedRoster(states, seats);
  layout = createSharedLayout(roster, allocations, updated);
  assert.equal(layout.placements.size, workingOfficeAgents(roster).length);
  assert.equal(new Set([...layout.placements.values()].map(seat => `${seat.zone}:${seat.slot}`)).size, layout.agents.length);
  assert.equal(resolveSharedSelection(roster, selected).id, selected.id);
  assertFixedDesks(layout);
});

test('bench desks and dynamically added workers retain aligned rows and one orientation', () => {
  const roster = buildSharedRoster({ claude: state('claude', 41), codex: state('codex', 21), grok: state('grok', 9) });
  const layout = createSharedLayout(roster, new Map(), board());
  const expected = {
    codex: { columns: [0, 5, 10], startZ: 8, rowStep: -8 },
    reviewers: { columns: [20, 25], startZ: 8, rowStep: -8 },
    grok: { columns: [37], startZ: -3, rowStep: -8 },
    overflow: { columns: [-31, -26, -21, -16, -11, 0, 5, 10, 20], startZ: -48, rowStep: -8 },
  };
  for (const [id, grid] of Object.entries(expected)) {
    assert.deepEqual(WORKSTATION_GRID[id], grid);
    const pods = layout.desks.filter(desk => desk.zone === id);
    assert.ok(pods.length > 0, `${id} should be exercised`);
    for (const desk of pods) {
      assert.equal(desk.x, grid.columns[desk.slot % grid.columns.length]);
      assert.equal(desk.z, grid.startZ + grid.rowStep * Math.floor(desk.slot / grid.columns.length));
      assert.equal(desk.angle, 0);
      assert.equal(desk.dx, 0);
      assert.equal(desk.dz, 1);
      assert.equal(desk.chairX, desk.x);
      assert.ok(Math.abs(desk.chairZ - desk.z + 1.65) < epsilon);
      assert.equal(desk.podX, desk.x);
      assert.equal(desk.podZ, desk.z - .5);
      assert.equal(desk.podWidth, 4.6);
      assert.equal(desk.podDepth, 5.8);
      if (id === 'overflow') {
        const laneColumns = { claude: [-31, -26, -21, -16, -11], codex: expected.codex.columns, grok: expected.reviewers.columns };
        assert.ok(laneColumns[desk.provider].includes(desk.x), 'Overflow must stay in its provider lane');
      }
    }
  }
  assertFixedDesks(layout);
});

test('management stays at one desk and a compact two-seat meeting table even with many Grok workers', () => {
  const roster = buildSharedRoster({ grok: state('grok', 25) });
  const layout = createSharedLayout(roster, new Map(), board());
  const manager = layout.zones.find(zone => zone.id === 'grok');
  assert.equal(manager.deskCount, 1);
  assert.equal(manager.workingCount, 1);
  assert.equal(manager.width, 14);
  assert.equal(manager.depth, 20);
  assert.equal(manager.meeting.seats, 2);
  assert.ok(manager.meeting.tableWidth <= 3.6 && manager.meeting.tableDepth <= 1.8);
  assert.ok(contains(manager, manager.meeting.x, manager.meeting.z, manager.meeting.width / 2, manager.meeting.depth / 2));
  for (const desk of layout.desks) assert.equal(overlaps(manager.meeting, rugFor(desk)), false, 'Small meeting area overlaps a workstation');
  assert.equal(layout.desks.filter(desk => desk.zone === 'overflow').length, 24);
  assert.equal(layout.desks.filter(desk => desk.zone === 'reviewers' && desk.occupant).length, 0, 'Manager overflow cannot take unrelated reviewer pods');
  assert.equal(layout.placements.size, 25);
});

test('chairs are tucked behind desks with monitor screens facing their seated workers', () => {
  const geometry = WORKSTATION_GEOMETRY;
  assert.ok(geometry.screenZ < geometry.monitorZ);
  assert.ok(geometry.monitorZ < geometry.depth / 2);
  const layout = createSharedLayout([], new Map(), board());
  for (const desk of layout.desks) {
    const toDeskX = desk.x - desk.chairX, toDeskZ = desk.z - desk.chairZ;
    assert.ok(toDeskX * desk.dx + toDeskZ * desk.dz > 0, 'Chair and seated person face toward their desk');
    const distanceToDeskEdge = Math.hypot(toDeskX, toDeskZ) - desk.depth / 2;
    assert.ok(distanceToDeskEdge > 0 && distanceToDeskEdge <= .75, 'Chairs stay tucked close to the desk');
    assert.ok((geometry.screenZ - geometry.monitorZ) * (geometry.chairOffsetZ - geometry.monitorZ) > 0);
    assert.ok(contains(rugFor(desk), desk.chairX, desk.chairZ, .67, .67));
  }
});

test('many actual workers retain personal space at shared benches and clear walking rows', () => {
  for (const counts of [[1, 7, 0], [30, 12, 1], [100, 24, 10]]) {
    const roster = buildSharedRoster({ claude: state('claude', counts[0]), codex: state('codex', counts[1]), grok: state('grok', counts[2]) });
    const layout = createSharedLayout(roster, new Map(), board());
    assert.equal(layout.placements.size, roster.length);
    assertFixedDesks(layout);
    assert.ok(layout.desks.length <= roster.length + 37);
    for (const zone of layout.zones) assert.ok(contains(layout.bounds, zone.x, zone.z, zone.width / 2, zone.depth / 2), `${zone.id} outside floor`);
    for (const desk of layout.desks) {
      const zone = layout.zones.find(item => item.id === desk.zone);
      assert.ok(contains(zone, desk.podX, desk.podZ, desk.podWidth / 2, desk.podDepth / 2), `Pod ${desk.zone}:${desk.slot} outside zone`);
      assert.ok(contains(layout.bounds, desk.podX, desk.podZ, desk.podWidth / 2, desk.podDepth / 2));
      assert.ok(contains(zone, desk.chairX, desk.chairZ, .67, .67), `Person ${desk.zone}:${desk.slot} outside zone`);
      assert.ok(Math.abs(desk.chairX - (desk.x - Math.sin(desk.angle) * 1.65)) < epsilon);
      assert.ok(Math.abs(desk.chairZ - (desk.z - Math.cos(desk.angle) * 1.65)) < epsilon);
    }
    for (let index = 0; index < layout.zones.length; index++) for (const other of layout.zones.slice(index + 1)) assert.equal(overlaps(layout.zones[index], other), false, 'Team zones overlap');
    for (let index = 0; index < layout.desks.length; index++) for (const other of layout.desks.slice(index + 1)) {
      const desk = layout.desks[index];
      const sharedRow = desk.zone === other.zone && desk.z === other.z;
      assert.ok(clearance(rugFor(desk), rugFor(other)) >= (sharedRow ? .4 : 2) - epsilon, `Personal spaces must stay clear: ${desk.zone}:${desk.slot} / ${other.zone}:${other.slot}`);
      assert.ok(Math.hypot(desk.chairX - other.chairX, desk.chairZ - other.chairZ) >= (desk.roundTable && other.roundTable ? 4 : 5), 'Pods leave too little room for people');
    }
    for (const point of Object.values(layout.shared)) assert.ok(contains(layout.bounds, ...point));
  }
});

test('perimeter rooms and coffee stay clear of approved workstations and straight aisles as teams grow', () => {
  for (const counts of [[0, 0, 0], [1, 3, 6], [30, 12, 1], [100, 24, 10]]) {
    const roster = buildSharedRoster({ claude: state('claude', counts[0]), codex: state('codex', counts[1]), grok: state('grok', counts[2]) });
    const layout = createSharedLayout(roster, new Map(), board());
    const front = layout.bounds.z + layout.bounds.depth / 2;
    const wallInsets = { reception: .5, meeting: 5, tasks: 5, reports: 5 };
    const commons = Object.entries(layout.commons);
    assert.deepEqual(commons.map(([id]) => id), ['reception', 'meeting', 'tasks', 'reports']);
    assert.equal(layout.aisles.entrance.x, -5.5);
    assert.equal(layout.aisles.entrance.width, 5);
    assert.equal(layout.aisles.cross.z, 14);
    assert.equal(layout.aisles.cross.depth, 4);
    assert.ok(Math.abs(front - 39) < epsilon, 'Only the front perimeter is expanded for the rooms');
    assert.equal(layout.bounds.x - layout.bounds.width / 2, -36);
    assert.equal(layout.bounds.x + layout.bounds.width / 2, 46);
    assert.ok(Math.abs(layout.bounds.z - layout.bounds.depth / 2 - (Math.min(layout.lounge.back, ...layout.zones.map(zone => zone.back)) - 2)) < epsilon);
    for (const [id, area] of commons) {
      assert.equal(area.angle, 0, `${id} must align with the wall`);
      assert.deepEqual(layout.shared[id], [area.x, area.z]);
      assert.ok(contains(layout.bounds, area.x, area.z, area.width / 2, area.depth / 2), `${id} extends beyond the floor`);
      if (id !== 'reception') assert.ok(Math.abs(front - (area.z + area.depth / 2) - wallInsets[id]) < epsilon, `${id} should retain its perimeter circulation space`);
      else { assert.equal(area.z, layout.lounge.z); assert.ok(area.x + area.width / 2 < layout.lounge.left, 'Coffee counter sits beside the upper lounge'); }
      for (const aisle of Object.values(layout.aisles)) assert.equal(overlaps(aisle, area), false, `${id} blocks a straight aisle`);
      for (const desk of layout.desks) assert.equal(overlaps(area, rugFor(desk)), false, `${id} overlaps ${desk.zone}:${desk.slot}`);
    }
    for (let index = 0; index < commons.length; index++) for (const [otherId, other] of commons.slice(index + 1)) assert.equal(overlaps(commons[index][1], other), false, `${commons[index][0]} overlaps ${otherId}`);
    for (const desk of layout.desks) for (const aisle of Object.values(layout.aisles)) assert.equal(overlaps(aisle, rugFor(desk)), false, `${desk.zone}:${desk.slot} blocks a straight aisle`);
  }
});

test('spacious rooms have usable doorways from the cross aisle and furniture circulation in quiet, full and overflow offices', () => {
  const original = createSharedLayout();
  const oldAreas = { meeting: 11 * 7.2, tasks: 5.7 * 1.2, reports: 6 * 1.05 };
  for (const counts of [[0, 0, 0], [30, 12, 1], [100, 24, 10]]) {
    const roster = buildSharedRoster({ claude: state('claude', counts[0]), codex: state('codex', counts[1]), grok: state('grok', counts[2]) });
    const layout = createSharedLayout(roster, new Map(), board());
    const rooms = Object.entries(layout.commons).filter(([, area]) => area.room);
    assert.deepEqual(rooms.map(([id]) => id), ['meeting', 'tasks', 'reports']);
    assert.deepEqual(layout.commons, original.commons, 'Room footprints must not shift when workers arrive or leave');
    for (const [id, room] of rooms) {
      assert.ok(room.width >= 20 && room.depth >= 16, `${id} needs a full room footprint`);
      assert.ok(room.width * room.depth >= 320 && room.width * room.depth > oldAreas[id] * 3, `${id} needs substantially more usable floor area`);
      assert.ok(room.wallHeight >= 3, `${id} must define a room-height partition`);
      assert.equal(room.left, room.x - room.width / 2);
      assert.equal(room.right, room.x + room.width / 2);
      assert.equal(room.back, room.z - room.depth / 2);
      assert.equal(room.front, room.z + room.depth / 2);
      assert.ok(room.back >= layout.aisles.cross.z + layout.aisles.cross.depth / 2 + 2, `${id} leaves room to approach the entrance`);
      for (const desk of layout.desks) assert.ok(clearance(room, rugFor(desk)) >= 7 - epsilon, `${id} crowds ${desk.zone}:${desk.slot}`);
      for (const zone of layout.zones) assert.ok(clearance(room, zone) >= 5 - epsilon, `${id} crowds the ${zone.id} work floor`);

      const { doorway, approach } = room;
      assert.ok(doorway.width >= 3 && doorway.depth >= 1.5, `${id} needs a generous doorway`);
      assert.equal(doorway.z, room.back, `${id} doorway must face the work-floor cross aisle`);
      assert.ok(doorway.x - doorway.width / 2 >= room.left + 1 && doorway.x + doorway.width / 2 <= room.right - 1, `${id} doorway must fit between the side partitions`);
      assert.equal(approach.x, doorway.x);
      assert.ok(approach.width >= doorway.width);
      assert.ok(contains(approach, doorway.x, doorway.z, doorway.width / 2, doorway.depth / 2), `${id} approach must pass through the entire doorway`);
      assert.equal(approach.z - approach.depth / 2, layout.aisles.cross.z + layout.aisles.cross.depth / 2, `${id} doorway route must join the cross aisle`);
      assert.ok(approach.z + approach.depth / 2 >= room.back + 3, `${id} entrance needs standing space inside the room`);
      assert.ok(contains(layout.bounds, approach.x, approach.z, approach.width / 2, approach.depth / 2));
      for (const desk of layout.desks) assert.equal(overlaps(approach, rugFor(desk)), false, `${id} doorway route crosses a desk`);
      for (const [otherId, other] of Object.entries(layout.commons)) if (otherId !== id) assert.equal(overlaps(approach, other), false, `${id} doorway route crosses ${otherId}`);

      const focus = sharedFocusArea(id, layout);
      assert.equal(focus.type, id);
      assert.ok(contains(focus, room.x, room.z, room.width / 2 + 1, room.depth / 2 + 1), `${id} camera focus must include the whole room with margin`);
    }
    for (let index = 0; index < rooms.length; index++) for (const [otherId, other] of rooms.slice(index + 1)) {
      assert.ok(clearance(rooms[index][1], other) >= 3 - epsilon, `${rooms[index][0]} and ${otherId} need a clear passage between their partitions`);
    }
    const { meeting, tasks } = layout.commons;
    assert.ok(meeting.table.width >= 10 && meeting.table.depth >= 4, 'Meeting table must seat a group comfortably');
    assert.ok(contains(meeting, meeting.table.x, meeting.table.z, meeting.table.width / 2 + 3, meeting.table.depth / 2 + 3), 'Meeting table needs chair and walking space on every side');
    assert.equal(overlaps(meeting.table, meeting.approach), false, 'Meeting table blocks its doorway');
    assert.ok(clearance(meeting.table, meeting.approach) >= 3, 'Meeting doorway needs a clear route around the table');
    assert.ok(tasks.standing.width * tasks.standing.depth >= 100, 'Task board needs a generous open standing area');
    assert.ok(contains(tasks, tasks.standing.x, tasks.standing.z, tasks.standing.width / 2 + 2, tasks.standing.depth / 2 + 2), 'War-room standing area needs circulation space around it');
    assert.ok(tasks.standing.z - tasks.standing.depth / 2 - tasks.back >= 4, 'Leave viewing distance between the standing area and the rear board wall');
    assert.equal(overlaps(tasks.standing, tasks.approach), false, 'War-room doorway needs an open landing before the standing area');
  }
});

test('overflow extends the floor without moving existing pods, commons or focus destinations', () => {
  const allocations = new Map(), seats = new Map(), states = { codex: state('codex', 3) };
  const roster = buildSharedRoster(states, seats), original = createSharedLayout(roster, allocations);
  states.codex = state('codex', 6);
  const filled = createSharedLayout(buildSharedRoster(states, seats), allocations);
  assert.equal(filled.desks.length, 37);
  assert.deepEqual(filled.bounds, original.bounds);
  states.codex = state('codex', 20);
  const expanded = createSharedLayout(buildSharedRoster(states, seats), allocations);
  assert.equal(expanded.desks.length, 51);
  assert.equal(expanded.bounds.width, original.bounds.width);
  assert.ok(expanded.bounds.depth > original.bounds.depth);
  assert.deepEqual(expanded.shared, original.shared);
  for (const agent of roster) assert.deepEqual(position(sharedSeatForAgent(agent, expanded)), position(sharedSeatForAgent(agent, original)));
  for (const focus of ['reception', 'meeting', 'tasks', 'reports']) assert.equal(sharedFocusArea(focus, expanded).type, focus);
  for (const index of expanded.zones.keys()) assert.equal(sharedFocusArea(`department-${index}`, expanded).id, expanded.zones[index].id);
  assert.equal(sharedFocusArea('agent-99999', expanded).type, 'overview');
  states.codex.agents.forEach((agent, index) => { if (index >= 3) agent.status = 'idle'; });
  const quietAgain = createSharedLayout(buildSharedRoster(states, seats), allocations);
  assert.equal(quietAgain.desks.length, 37, 'Finished overflow workers must not leave extra empty pods');
  assert.deepEqual(quietAgain.bounds, original.bounds);
  for (const agent of roster) assert.deepEqual(position(sharedSeatForAgent(agent, quietAgain)), position(sharedSeatForAgent(agent, original)));
});

test('lounge is a separate roomy rest area that overlaps no room, desk pod or commons', () => {
  const layout = createSharedLayout([]);
  const l = layout.lounge;
  assert.ok(l.width >= 20 && l.depth >= 16);
  assert.ok(l.sofas.length >= 4 && l.tables.length >= 2 && l.plants.length >= 4);
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.back < b.front && b.back < a.front;
  const rect = a => a.left !== undefined ? a : { left: a.x - a.width / 2, right: a.x + a.width / 2, back: a.z - a.depth / 2, front: a.z + a.depth / 2 };
  for (const zone of layout.zones) assert.equal(hit(l, zone), false, `lounge overlaps ${zone.id}`);
  for (const area of Object.values(layout.commons)) assert.equal(hit(l, rect(area)), false);
  for (const d of layout.desks) assert.equal(hit(l, rect({ x: d.podX, z: d.podZ, width: d.podWidth, depth: d.podDepth })), false);
  assert.ok(l.back > layout.bounds.z - layout.bounds.depth / 2, 'inside the floor');
  assert.equal(sharedFocusArea('lounge', layout).type, 'lounge');
  assert.equal(layout.desks.filter(d => d.zone === 'claude').length, 20);
});

// Tabletop geometry is shared, while every monitor and chair remains individually selectable.
test('compact studio has continuous communal tables and circular lounge tables', () => {
  const layout = createSharedLayout();
  assert.ok(layout.bounds.width * layout.bounds.depth < 110 * 99 * .65, 'Footprint shrinks by at least 35%');
  const tables = layout.benches.filter(b => b.seats.length > 1);
  assert.ok(tables.length + layout.roundTables.length >= 7);
  for (const table of tables) {
    for (const seat of table.seats) assert.ok(contains(table, seat.x, seat.z, seat.width / 2, seat.depth / 2));
  }
  for (const table of layout.lounge.tables) {
    assert.ok(table.radius >= 1.5);
    assert.ok(contains(layout.lounge, table.x, table.z, table.radius + 1, table.radius + 1));
  }
});


test('Claude circles seat twenty people facing inward with clear circulation and no leftover benches', () => {
  const layout = createSharedLayout(), zone = layout.zones.find(z => z.id === 'claude');
  assert.equal(layout.roundTables.length, 4);
  assert.equal(layout.collaboration, undefined, 'Independent discussion area has been removed');
  assert.equal(new Set(layout.roundTables.map(t => t.x)).size, 2);
  assert.equal(new Set(layout.roundTables.map(t => t.z)).size, 2);
  assert.ok(layout.benches.every(b => b.seats.every(s => s.zone !== 'claude')));
  for (const table of layout.roundTables) {
    assert.ok(contains(zone, table.x, table.z, table.radius + 1.6, table.radius + 1.6));
    const seats = layout.desks.filter(s => s.roundTable?.id === table.id);
    assert.equal(seats.length, 5);
    for (const seat of seats) {
      const r = Math.hypot(seat.chairX - table.x, seat.chairZ - table.z);
      assert.ok(r > table.radius + .5, 'Chair clears the curved table edge');
      assert.ok(Math.abs((table.x-seat.chairX)/r-seat.dx)<epsilon);
      assert.ok(Math.abs((table.z-seat.chairZ)/r-seat.dz)<epsilon);
      // Main monitor and keyboard must stay on the circular surface.
      for (const [lx,lz] of [[-.73,.55],[.73,.55],[-.68,-.63],[.68,-.63],[-1.89,-.41]]) {
        const x=seat.x+lx*Math.cos(seat.angle)+lz*Math.sin(seat.angle);
        const z=seat.z-lx*Math.sin(seat.angle)+lz*Math.cos(seat.angle);
        assert.ok(Math.hypot(x-table.x,z-table.z)<table.radius);
      }
    }
    for(const other of layout.roundTables.filter(t=>t!==table))
      assert.ok(Math.hypot(table.x-other.x,table.z-other.z)>=12, 'Adjacent chair rings leave a passage');
  }
});
