import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedLayout } from '../src/shared-layout.js';
import { createMovement, MAX_AMBIENT_WALKERS, MAX_IDLE_FIGURES, AISLE_Z, ambientSpots, loungeSpots, route } from '../src/movement.js';
const layout = createSharedLayout([]);
const make = extra => createMovement({ lounge: layout.lounge, commons: layout.commons, ...extra });

test('steady state circulates existing idle figures, begins promptly and keeps sparse staggered traffic', () => {
  const movement = make(), visits = new Map(), departures = [];
  movement.sync({ now: 0, initial: true });
  let prevWalking = new Set();
  for (let now = 0; now <= 240000; now += 250) {
    const figures = movement.step(now);
    assert.equal(figures.length, 4);
    assert.ok(figures.filter(f => f.ambientTrip).length <= MAX_AMBIENT_WALKERS);
    for (const f of figures) {
      assert.equal(f.agent, null); assert.equal(f.idle, true); assert.ok(!f.rep);
      if (!visits.has(f.id)) visits.set(f.id, new Set());
      visits.get(f.id).add(f.spot.kind);
      if (f.walking && !prevWalking.has(f.id)) departures.push({ id: f.id, now });
    }
    prevWalking = new Set(figures.filter(f => f.walking).map(f => f.id));
  }
  assert.ok(departures[0].now >= 1000 && departures[0].now <= 3000);
  assert.ok(departures[1].now > departures[0].now);
  assert.ok([...visits.values()].every(kinds => kinds.has('lounge') && kinds.has('ambient')));
  assert.ok(departures.some(item => item.now > 180000), 'continues after the first circuit');
  assert.ok(new Set([...movement.figures.values()].map(f => f.speed)).size > 1);
});

test('frequent identical sync leaves ambient paths and timing intact', () => {
  const quiet = make(), polled = make();
  quiet.sync({ now: 0, initial: true }); polled.sync({ now: 0, initial: true });
  for (let now = 100; now <= 90000; now += 100) {
    const a = quiet.step(now), b = polled.sync({ now });
    assert.deepEqual(b.map(f => [f.id, f.x, f.z, f.walk?.start, f.queue.map(s => s.id)]), a.map(f => [f.id, f.x, f.z, f.walk?.start, f.queue.map(s => s.id)]));
  }
});

test('meeting and actual work interrupt ambient routes continuously and preserve real agent identity', () => {
  const movement = make(); movement.sync({ now: 0, initial: true });
  movement.step(1200); movement.step(3000);
  const idle = [...movement.figures.values()].find(f => f.ambientTrip);
  const before = { x: idle.x, z: idle.z }, provider = idle.provider;
  movement.sync({ now: 3000, meeting: { active: true, attendees: [provider] } });
  const rep = [...movement.figures.values()].find(f => f.rep);
  assert.equal(rep.x, before.x); assert.equal(rep.z, before.z);
  assert.equal(rep.ambientTrip, false); assert.equal(rep.walk.to.kind, 'meeting');
  for (let now = 3250; now < 90000; now += 250) movement.step(now);
  assert.equal(rep.spot.kind, 'meeting');
  movement.sync({ now: 90000, meeting: { active: false } });
  const actor = [...movement.figures.values()].find(f => f.idle && !f.rep && f.walking);
  const agent = { id: 'real-worker', status: 'working' };
  const desk = layout.desks.find(d => d.zone === actor.provider) || layout.desks[0];
  const start = { x: actor.x, z: actor.z };
  movement.sync({ now: 90000, working: [{ id: agent.id, provider: actor.provider, agent, desk }] });
  const worker = movement.figures.get(agent.id);
  assert.equal(worker.agent, agent); assert.equal(worker.idle, false); assert.equal(worker.ambientTrip, false);
  assert.equal(worker.x, start.x); assert.equal(worker.z, start.z);
  assert.equal(worker.walk.to.id, `desk:${desk.id}`); assert.equal(worker.queue.length, 0);
  for (let now = 90250; now < 180000; now += 250) movement.step(now);
  assert.equal(worker.spot.id, `desk:${desk.id}`); assert.ok(worker.sitting);
});

test('completion report remains ahead of background circulation', () => {
  const movement = make(), desk = layout.desks.find(d => d.zone === 'claude');
  movement.sync({ now: 0, initial: true, working: [{ id: 'finisher', provider: 'claude', desk, agent: { id: 'finisher' } }] });
  movement.sync({ now: 1000, working: [] });
  const seen = [];
  for (let now = 1000; now < 90000; now += 250) {
    movement.step(now); const f = movement.figures.get('finisher');
    if (seen.at(-1) !== f.spot.kind) seen.push(f.spot.kind);
    if (!seen.includes('report')) assert.equal(f.ambientTrip, false);
  }
  assert.ok(seen.includes('report')); assert.ok(seen.indexOf('report') < seen.indexOf('lounge'));
});

test('one hundred real workers stay seated and bounded decoration starts within three seconds', () => {
  const agents = Array.from({ length: 100 }, (_, i) => ({ id: `worker-${i}`, provider: 'Claude Code', liveStatus: 'working', runtimeAgents: [{ status: 'working', executionState: 'working', observed: true }] }));
  const busy = createSharedLayout(agents);
  const working = agents.map(agent => ({ id: agent.id, provider: 'claude', agent, desk: busy.placements.get(agent.id) }));
  const movement = createMovement({ lounge: busy.lounge, commons: busy.commons });
  movement.sync({ working, now: 0, initial: true });
  const first = movement.step(2000);
  assert.ok(first.some(f => f.ambientTrip && f.walking));
  for (let now = 2000; now < 180000; now += 1000) {
    const figures = movement.sync({ working, now });
    assert.equal(figures.filter(f => f.agent).length, 100);
    assert.ok(figures.length <= 100 + MAX_IDLE_FIGURES);
    assert.ok(figures.filter(f => f.agent).every(f => !f.walking && f.sitting && !f.ambientTrip));
  }
  movement.sync({ working: [], now: 180000 });
  assert.ok(movement.figures.size <= MAX_IDLE_FIGURES);
});

test('ambient false starts still and dynamic disabling cancels only background walking without teleport', () => {
  const movement = make({ ambient: false }); movement.sync({ now: 0, initial: true });
  assert.ok(movement.step(60000).every(f => !f.walking));
  movement.sync({ now: 60000, ambient: true }); movement.step(62000);
  const moving = [...movement.figures.values()].find(f => f.walking), position = { x: moving.x, z: moving.z };
  movement.sync({ now: 62000, ambient: false });
  assert.equal(moving.x, position.x); assert.equal(moving.z, position.z);
  assert.ok(movement.step(120000).every(f => !f.walking && !f.ambientTrip));
  movement.sync({ now: 120000, ambient: true });
  assert.ok([...movement.figures.values()].some(f => f.walking));
});

test('ambient routes stay in existing lounge exits and main aisle outside all rooms and tables', () => {
  const destinations = ambientSpots(layout.commons), seats = loungeSpots(layout.lounge);
  const surfaces = [...layout.benches, layout.centralSocial.planter, layout.centralSocial.board].map(b => ({ left: b.x - b.width / 2 - .2, right: b.x + b.width / 2 + .2, back: b.z - b.depth / 2 - .2, front: b.z + b.depth / 2 + .2 }));
  for (const spot of destinations) assert.deepEqual(spot.path.at(-1), [spot.id.includes('central') ? 16 : spot.x, AISLE_Z]);
  for (const seat of seats) for (const destination of destinations) {
    const points = route(seat, destination);
    for (let i = 1; i < points.length; i++) for (let t = 0; t <= 1; t += .02) {
      const x = points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t;
      const z = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t;
      for (const r of surfaces) assert.ok(!(x > r.left && x < r.right && z > r.back && z < r.front));
      for (const circle of [...layout.lounge.tables, ...layout.roundTables]) assert.ok(Math.hypot(x - circle.x, z - circle.z) > circle.radius + .2);
      assert.ok(z < layout.commons.tasks.back, 'ambient stops never imply task-board interaction or a meeting');
    }
  }
});


test('all providers working still retain a fixed two-person decorative pool', () => {
  const movement = make();
  const working = ['claude', 'codex', 'gemini', 'grok'].map(provider => ({ id: `real:${provider}`, provider, agent: { id: `real:${provider}` }, desk: layout.desks.find(d => d.zone === provider) }));
  movement.sync({ working, now: 0, initial: true });
  for (let now = 2000; now < 120000; now += 1000) {
    const figures = movement.sync({ working, now });
    assert.equal(figures.length, 6);
    const decoration = figures.filter(f => !f.agent);
    assert.equal(decoration.length, 2); assert.ok(decoration.every(f => f.id.startsWith('ambient:')));
    assert.ok(figures.filter(f => f.agent).every(f => !f.walking && f.sitting));
    if (now === 2000) assert.ok(decoration.some(f => f.walking));
  }
});
