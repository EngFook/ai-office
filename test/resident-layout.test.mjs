import test from 'node:test';
import assert from 'node:assert/strict';
import { residentFigures, RESIDENT_SPOTS } from '../src/office-resident-layout.js';
import { createSharedLayout, OFFICE_PROVIDERS } from '../src/shared-layout.js';
import { AISLE_Z } from '../src/movement.js';

const residents = Object.entries(OFFICE_PROVIDERS).map(([key, value]) => ({
  id: `resident:${key}`, key, provider: value.name, status: 'idle', workingCount: 0, activeTaskCount: 0,
}));
const workers = Array.from({ length: 100 }, (_, index) => ({
  id: `real-worker:${index}`, provider: index < 80 ? 'Claude Code' : index < 92 ? 'Codex' : index < 96 ? 'Gemini' : index < 98 ? 'Grok' : 'Local Qwen',
  liveStatus: 'working', runtimeAgents: [{ id: `session:${index}`, status: 'working', executionState: 'working', observed: true }],
}));
const coordinates = figures => Object.fromEntries(figures.map(figure => [figure.id, [figure.x, figure.z, figure.angle]]));

test('five resident figures have unique stable identities and positions independent of activity or polling order', () => {
  const figures = residentFigures(residents), before = structuredClone(residents);
  assert.equal(figures.length, 5);
  assert.equal(new Set(figures.map(f => f.id)).size, 5);
  assert.equal(new Set(figures.map(f => `${f.x},${f.z}`)).size, 5);
  for (const figure of figures) {
    assert.equal(figure.resident, residents.find(r => r.id === figure.id));
    assert.deepEqual([figure.x, figure.z, figure.angle], Object.values(RESIDENT_SPOTS[figure.provider]));
    assert.equal(figure.agent, null); assert.equal(figure.walking, false); assert.equal(figure.sitting, false);
    assert.deepEqual(figure.queue, []); assert.equal(figure.spot.kind, 'resident');
    assert.ok(Number.isFinite(figure.x) && Number.isFinite(figure.z) && Number.isFinite(figure.angle));
  }
  const active = [...residents].reverse().map(r => ({ ...r, status: 'working', workingCount: 20, activeTaskCount: 4 }));
  assert.deepEqual(coordinates(residentFigures(active)), coordinates(figures));
  assert.deepEqual(residents, before);
  assert.deepEqual(residentFigures([{ id: 'unknown', key: 'unknown' }]), []);
});

test('resident rendering leaves all 100 real worker allocations and actual work counts unchanged', () => {
  const allocations = new Map(), layout = createSharedLayout(workers, allocations);
  const original = structuredClone({ agents: layout.agents, desks: layout.desks, placements: [...layout.placements], allocations: [...allocations] });
  const figures = residentFigures(residents);
  const after = createSharedLayout([...workers].reverse(), allocations);
  assert.equal(layout.agents.length, 100); assert.equal(after.agents.length, 100);
  assert.equal(after.placements.size, 100);
  assert.deepEqual([...after.placements].map(([id, desk]) => [id, desk.id]).sort(), original.placements.map(([id, desk]) => [id, desk.id]).sort());
  assert.deepEqual([...allocations], original.allocations);
  assert.deepEqual(layout.agents, original.agents); assert.deepEqual(layout.desks, original.desks);
  for (const figure of figures) {
    assert.ok(!after.placements.has(figure.id));
    assert.ok(!after.desks.some(d => d.reservedFor === figure.id || d.occupant?.id === figure.id));
    assert.ok(!after.agents.some(agent => agent.id === figure.id));
  }
});

test('resident standing positions clear real tables, chairs, corridors and each other in empty and busy layouts', () => {
  const figures = residentFigures(residents);
  for (const layout of [createSharedLayout([]), createSharedLayout(workers)]) {
    for (const f of figures) {
      assert.ok(f.x > layout.bounds.x - layout.bounds.width / 2 + .7 && f.x < layout.bounds.x + layout.bounds.width / 2 - .7);
      assert.ok(f.z > layout.bounds.z - layout.bounds.depth / 2 + .7 && f.z < layout.bounds.z + layout.bounds.depth / 2 - .7);
      assert.ok(Math.abs(f.z - AISLE_Z) > 1.2, `${f.id} keeps the main aisle clear`);
      for (const desk of layout.desks) {
        assert.ok(Math.hypot(f.x - desk.chairX, f.z - desk.chairZ) > 1.4, `${f.id} overlaps ${desk.id}'s chair`);
        if (desk.roundTable) continue;
        const dx = f.x - desk.x, dz = f.z - desk.z;
        const localX = dx * Math.cos(desk.angle) - dz * Math.sin(desk.angle);
        const localZ = dx * Math.sin(desk.angle) + dz * Math.cos(desk.angle);
        assert.ok(Math.abs(localX) > desk.width / 2 + .6 || Math.abs(localZ) > desk.depth / 2 + .6, `${f.id} overlaps ${desk.id}'s tabletop`);
      }
      for (const table of [...layout.roundTables, ...layout.lounge.tables]) {
        assert.ok(Math.hypot(f.x - table.x, f.z - table.z) > table.radius + .6, `${f.id} overlaps a round table`);
      }
      for (const bench of layout.benches) {
        assert.ok(Math.abs(f.x - bench.x) > bench.width / 2 + .6 || Math.abs(f.z - bench.z) > bench.depth / 2 + .6, `${f.id} overlaps a shared bench`);
      }
      for (const other of figures) if (other.id !== f.id) assert.ok(Math.hypot(f.x - other.x, f.z - other.z) > 1.4);
    }
  }
});
