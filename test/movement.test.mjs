import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedLayout } from '../src/shared-layout.js';
import { createMovement, deskSpot, meetingSpot, reportSpot, loungeSpots, route, AISLE_Z, WALK_SPEED } from '../src/movement.js';

const layout = createSharedLayout([]);
const inside = (p, r) => p[0] > r.left + .01 && p[0] < r.right - .01 && p[1] > r.back + .01 && p[1] < r.front - .01;
function crosses(a, b, r) { for (let t = 0; t <= 1; t += 1 / 200) if (inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], r)) return true; return false; }

test('routes use the cross aisle and enter rooms only through doorways', () => {
  const spots = [...layout.desks.map(deskSpot), meetingSpot(0, layout.commons), meetingSpot(3, layout.commons), reportSpot(1, layout.commons), ...loungeSpots(layout.lounge)];
  const rooms = ['meeting', 'tasks', 'reports'].map(id => layout.commons[id]);
  for (const from of [spots[0], spots[40], spots.find(s => s.kind === 'research'), spots.find(s => s.kind === 'review'), spots.find(s => s.id.includes('grok'))].filter(Boolean)) for (const to of spots) {
    const pts = route(from, to);
    assert.deepEqual(pts.at(-1), [to.x, to.z]);
    if (from.id !== to.id) assert.ok(pts.some(p => p[1] === AISLE_Z), `${from.id} -> ${to.id} uses the aisle`);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const first = i === 1 || i === pts.length - 1;
      const roundSeat = spot => layout.desks.find(d=>`desk:${d.id}`===spot.id)?.roundTable;
      if (!first && !roundSeat(from) && !roundSeat(to)) assert.ok(Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9, 'axis aligned');
      for (const room of rooms) if (!inside(a, room) && !inside(b, room) && crosses(a, b, room)) assert.fail(`${from.id}->${to.id} walks through ${room.x} room wall`);
      if (!inside(a, layout.lounge) && !inside(b, layout.lounge)) assert.equal(crosses(a, b, layout.lounge), false, 'no shortcut through the lounge');
    }
  }
});

test('state changes make people walk: desk on work, meeting room on meeting, report then sofa when done', () => {
  const m = createMovement({ lounge: layout.lounge, commons: layout.commons, ambient: false });
  let figs = m.sync({ working: [], now: 0, initial: true });
  assert.equal(figs.length, 4, 'one resting person per provider');
  assert.ok(figs.every(f => f.spot.kind === 'lounge' && f.sitting));
  const desk = layout.desks.find(d => d.zone === 'codex');
  m.sync({ working: [{ id: 'a1', provider: 'codex', desk }], now: 1000 });
  let f = m.figures.get('a1');
  assert.ok(f.walking, 'codex resting person walks to the desk');
  m.step(1000 + 60000); f = m.figures.get('a1');
  assert.equal(f.spot.kind, 'desk'); assert.ok(f.sitting);
  m.sync({ working: [], meeting: { active: true, attendees: ['claude', 'codex', 'gemini', 'grok'] }, now: 70000 });
  m.step(200000); m.step(200001);
  const reps = [...m.figures.values()].filter(x => x.rep);
  assert.equal(reps.length, 4);
  assert.ok(reps.every(x => x.spot.kind === 'meeting'), 'all four reps sit in the meeting room');
  m.sync({ working: [], meeting: { active: false }, now: 300000 });
  for (let t = 300000; t < 500000; t += 5000) m.step(t);
  assert.ok([...m.figures.values()].every(x => x.spot.kind === 'lounge'), 'everyone back on sofas');
  assert.ok(WALK_SPEED > 0);
});

test('a finished agent hands in a report before resting', () => {
  const m = createMovement({ lounge: layout.lounge, commons: layout.commons, ambient: false });
  const desk = layout.desks.find(d => d.zone === 'claude');
  m.sync({ working: [{ id: 'w', provider: 'claude', desk }], now: 0, initial: true });
  m.sync({ working: [], now: 10 });
  const seen = new Set();
  for (let t = 10; t < 200000; t += 250) { m.step(t); seen.add(m.figures.get('w')?.spot?.kind); }
  assert.ok(seen.has('report')); assert.equal(m.figures.get('w').spot.kind, 'lounge');
});


test('compact walking routes avoid continuous tabletops and round tables', () => {
  const busy = createSharedLayout(['Claude Code','Codex','Grok','Local Qwen'].flatMap(provider => Array.from({length:provider==='Claude Code'?100:15}, (_,i) => ({id:`${provider}-${i}`,provider,liveStatus:'working',runtimeAgents:[{status:'working',observed:true}]}))));
  const surfaces = busy.benches.map(b => ({left:b.x-b.width/2-.2,right:b.x+b.width/2+.2,back:b.z-b.depth/2-.2,front:b.z+b.depth/2+.2}));
  const circles = [...busy.lounge.tables, ...busy.roundTables];
  const spots = [...busy.desks.map(deskSpot), ...loungeSpots(busy.lounge)];
  for (const spot of spots) {
    const pts = [[spot.x,spot.z],...spot.path];
    for(let i=1;i<pts.length;i++) {
      for(const surface of surfaces) assert.equal(crosses(pts[i-1],pts[i],surface),false,`${spot.id} crosses a tabletop`);
      for(let t=0;t<=1;t+=.02) for(const circle of circles) {
        const x=pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, z=pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t;
        assert.ok(Math.hypot(x-circle.x,z-circle.z)>circle.radius+.2,`${spot.id} crosses a round table`);
      }
    }
  }
});
