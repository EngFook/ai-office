import test from 'node:test';
import assert from 'node:assert/strict';
import { PROP_MODELS, PROP_PALETTE } from '../src/desk-prop-data.js';
import {
  PROP_WORLD, propScale, propPlacements, paletteU, buildPropGeometry, propPickHandler,
  CODE_HZ, CODE_W, CODE_H, CODE_LINE, shouldStepCode, drawCodeLine,
  STEAM_COUNT, STEAM_PERIOD, STEAM_RISE, steamParticle,
} from '../src/desk-props.js';
import { QUALITY_TIERS, qualityTier } from '../src/scene-quality.js';
import { WORKSTATION_GEOMETRY } from '../src/shared-layout.js';

const DESK_HALF_WIDTH = 2.25, DESK_HALF_DEPTH = 0.95; // WORKSTATION_GEOMETRY desk top

function fakeLayout() {
  return {
    desks: Array.from({ length: 36 }, (_, i) => ({
      id: `claude:workstation:${i}`, x: (i % 6) * 9 - 40, z: Math.floor(i / 6) * -12 + 8, angle: 0,
    })),
    lounge: { tables: [{ x: 11, z: -46 }, { x: 25, z: -46 }] },
    commons: { reception: { x: -40, z: 38.5 }, meeting: { table: { x: -19, z: 28.5 } } },
  };
}

test('every prop model respects the V6 budgets and the shared palette', () => {
  const names = Object.keys(PROP_MODELS);
  assert.deepEqual(names.sort(), ['cup', 'keyboard', 'monitor', 'plant']);
  for (const name of names) {
    const model = PROP_MODELS[name];
    assert.ok(model.tris > 0 && model.tris <= 350, `${name}: ${model.tris} tris exceeds the 350 budget`);
    assert.equal(model.index.length, model.tris * 3);
    assert.equal(model.positions.length % 3, 0);
    assert.equal(model.normals.length, model.positions.length);
    assert.equal(model.colors.length, model.positions.length / 3);
    const vertexCount = model.positions.length / 3;
    assert.ok(model.index.every(i => Number.isInteger(i) && i >= 0 && i < vertexCount), `${name}: index out of range`);
    assert.ok(model.colors.every(c => Number.isInteger(c) && c >= 0 && c < PROP_PALETTE.length), `${name}: palette index out of range`);
    // Normalised: feet on y=0, XZ centred, recorded size matches the vertices.
    let minY = Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < model.positions.length; i += 3) {
      minX = Math.min(minX, model.positions[i]); maxX = Math.max(maxX, model.positions[i]);
      minY = Math.min(minY, model.positions[i + 1]);
    }
    assert.ok(Math.abs(minY) < 1e-3, `${name}: feet not on y=0`);
    assert.ok(Math.abs(minX + maxX) < 1e-3, `${name}: not X-centred`);
    assert.ok(Math.abs(maxX - minX - model.size[0]) < 1e-3, `${name}: size mismatch`);
  }
  assert.ok(PROP_PALETTE.length >= 2 && PROP_PALETTE.every(c => /^#[0-9a-f]{6}$/.test(c)));
});

test('prop scales hit the intended world sizes', () => {
  for (const [name, target] of Object.entries(PROP_WORLD)) {
    const s = propScale(name);
    assert.ok(s > 0 && Number.isFinite(s));
    const model = PROP_MODELS[name];
    if (target.width) assert.ok(Math.abs(model.size[0] * s - target.width) < 1e-6);
    else assert.ok(Math.abs(model.size[1] * s - target.height) < 1e-6);
  }
});

test('buildPropGeometry maps every vertex into the shared palette strip', () => {
  for (const name of Object.keys(PROP_MODELS)) {
    const geometry = buildPropGeometry(name);
    const vertexCount = PROP_MODELS[name].positions.length / 3;
    assert.equal(geometry.getAttribute('position').count, vertexCount);
    assert.equal(geometry.getAttribute('uv').count, vertexCount);
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) > 0 && uv.getX(i) < 1, `${name}: palette U out of (0,1)`);
      assert.equal(uv.getY(i), 0.5);
    }
    assert.equal(geometry.getIndex().count, PROP_MODELS[name].tris * 3);
  }
  assert.ok(paletteU(0) > 0 && paletteU(PROP_PALETTE.length - 1) < 1);
});

test('placements are deterministic, varied, and stay on their surfaces', () => {
  const layout = fakeLayout();
  const a = propPlacements(layout), b = propPlacements(layout);
  assert.deepEqual(a, b, 'placements must be a pure function of the layout');

  assert.equal(a.keyboards.length, layout.desks.length, 'every desk has a keyboard');
  const deskCups = a.cups.filter(c => c.seat);
  for (const [items, label] of [[a.monitors, 'monitors'], [deskCups, 'cups'], [a.plants, 'plants']]) {
    const share = items.length / layout.desks.length;
    assert.ok(share > 0.2 && share < 0.9, `${label} share ${share} should vary per desk hash`);
  }
  // Desk props stay on the desk top, clear of its edges.
  for (const item of [...a.keyboards, ...a.monitors, ...a.plants, ...deskCups]) {
    const dx = item.x - item.seat.x, dz = item.z - item.seat.z;
    assert.ok(Math.abs(dx) <= DESK_HALF_WIDTH && Math.abs(dz) <= DESK_HALF_DEPTH, `prop off the desk: ${dx},${dz}`);
    assert.ok(item.scale > 0);
  }
  for (const item of a.keyboards) assert.equal(item.y, 1.0625); // keyboard pad top
  for (const item of [...a.monitors, ...a.plants, ...deskCups]) assert.equal(item.y, 1.03); // desk top
  // Cups beyond the desks: 2 per lounge table, 3 on the coffee counter, 4 on the meeting table.
  assert.equal(a.cups.length - deskCups.length, 2 * layout.lounge.tables.length + 3 + 4);
  const looseCups = a.cups.filter(c => !c.seat);
  assert.ok(looseCups.some(c => Math.abs(c.y - 0.5) < 1e-9), 'lounge table cups sit at .5');
  assert.ok(looseCups.some(c => Math.abs(c.y - 1.48) < 1e-9), 'coffee counter cups sit at 1.48');
  assert.ok(looseCups.some(c => Math.abs(c.y - 1.15) < 1e-9), 'meeting table cups sit at 1.15');
  // Steam rises over the espresso machine on the coffee counter.
  assert.deepEqual(a.steam, { x: layout.commons.reception.x - 1.8, y: 2.34, z: layout.commons.reception.z });
});

test('placements follow a rotated seat frame', () => {
  const layout = fakeLayout();
  layout.desks = [{ id: 'claude:workstation:0', x: 10, z: -5, angle: Math.PI / 2 }];
  const { keyboards } = propPlacements(layout);
  const kb = keyboards[0];
  // Local (0, -.33) rotated by PI/2: world x = seat.x - .33, z = seat.z.
  assert.ok(Math.abs(kb.x - (10 - 0.33)) < 1e-9 && Math.abs(kb.z - -5) < 1e-9);
  assert.ok(Math.abs(kb.yaw - Math.PI / 2) < 0.06, 'keyboard yaw follows the seat angle (plus jitter)');
});

test('side monitor screens face the chair, including rotated workstations', () => {
  // The screen is the set of #a8d3d3-palette faces of the real Kenney model;
  // average their recorded normals for the model-space screen direction.
  const screenColor = PROP_PALETTE.indexOf('#a8d3d3');
  assert.ok(screenColor >= 0, 'screen colour missing from the palette');
  const model = PROP_MODELS.monitor;
  let nx = 0, ny = 0, nz = 0, faces = 0;
  for (let i = 0; i < model.index.length; i += 3) {
    const tri = [model.index[i], model.index[i + 1], model.index[i + 2]];
    if (!tri.every(v => model.colors[v] === screenColor)) continue;
    for (const v of tri) { nx += model.normals[v * 3]; ny += model.normals[v * 3 + 1]; nz += model.normals[v * 3 + 2]; }
    faces++;
  }
  assert.ok(faces >= 2, 'no screen faces found on the monitor model');
  const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
  assert.ok(nz < -0.9, `the model screen must look toward -z, got ${nz.toFixed(3)}`);
  for (const angle of [0, Math.PI / 2, Math.PI, -2.1]) {
    const layout = fakeLayout();
    layout.desks = layout.desks.map(desk => ({ ...desk, angle }));
    const { monitors } = propPlacements(layout);
    assert.ok(monitors.length > 0);
    for (const item of monitors) {
      // The scene renders props with rotation.set(0, yaw, 0): world = Ry(yaw)·local.
      const wx = nx * Math.cos(item.yaw) + nz * Math.sin(item.yaw);
      const wz = -nx * Math.sin(item.yaw) + nz * Math.cos(item.yaw);
      // The sitter's chair is at seat-local (0, chairOffsetZ) in the same frame.
      const off = WORKSTATION_GEOMETRY.chairOffsetZ;
      const chairX = item.seat.x + off * Math.sin(angle), chairZ = item.seat.z + off * Math.cos(angle);
      const dx = chairX - item.x, dz = chairZ - item.z, d = Math.hypot(dx, dz);
      const dot = (wx * dx + wz * dz) / d;
      assert.ok(dot > 0.9, `screen faces away from the chair (dot ${dot.toFixed(3)}) at seat angle ${angle}`);
    }
  }
});

test('prop clicks pick the seat but never swallow clicks on loose props', () => {
  const seat = { id: 'claude:workstation:3' };
  const items = [{ seat, name: 'keyboard' }, { seat: null, name: 'cup' }];
  const picked = [];
  const handler = propPickHandler(items, s => picked.push(s));
  let stopped = 0;
  const eventFor = instanceId => ({ instanceId, stopPropagation: () => stopped++ });
  // A desk prop selects its seat and stops the ray there, like the desk does.
  handler(eventFor(0));
  assert.deepEqual(picked, [seat]);
  assert.equal(stopped, 1);
  // A loose cup (lounge / coffee bar / meeting, seat:null) must let the click
  // fall through to the room-focus surfaces underneath: no stop, no pick.
  handler(eventFor(1));
  assert.deepEqual(picked, [seat]);
  assert.equal(stopped, 1);
  // Out-of-range instance ids are equally harmless.
  handler(eventFor(99));
  assert.deepEqual(picked, [seat]);
  assert.equal(stopped, 1);
});

test('the code scroll steps at the approved 2-4Hz', () => {
  assert.ok(CODE_HZ >= 2 && CODE_HZ <= 4);
  assert.equal(shouldStepCode(1000, 1000), false);
  assert.equal(shouldStepCode(1000 + 1000 / CODE_HZ + 0.01, 1000), true);
  assert.equal(shouldStepCode(1000 + 1000 / CODE_HZ - 1, 1000), false);
  assert.ok(CODE_H % CODE_LINE === 0, 'whole lines fit the canvas');
});

test('drawCodeLine paints only inside the canvas line band', () => {
  const rects = [];
  const ctx = { fillStyle: '', fillRect: (x, y, w, h) => rects.push({ x, y, w, h, fill: ctx.fillStyle }) };
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let line = 0; line < 40; line++) drawCodeLine(ctx, CODE_W, 12, CODE_LINE, rand);
  assert.ok(rects.length > 0);
  for (const rect of rects) {
    assert.ok(rect.x >= 0 && rect.w > 0 && rect.x + rect.w <= CODE_W, `dash escapes the canvas: ${rect.x}+${rect.w}`);
    assert.equal(rect.y, 13); // y + 1
    assert.equal(rect.h, CODE_LINE - 2);
    assert.ok(/^#[0-9a-f]{6}$/.test(rect.fill));
  }
});

test('steam puffs loop smoothly, fade out before wrapping, and are staggered', () => {
  for (let i = 0; i < STEAM_COUNT; i++) {
    for (let t = 0; t < 12; t += 0.07) {
      const puff = steamParticle(t, i);
      assert.ok(puff.fade >= 0 && puff.fade <= 1);
      assert.ok(puff.y >= 0 && puff.y <= STEAM_RISE);
      assert.ok(puff.scale > 0);
      assert.ok(Math.abs(puff.drift) <= 0.08 && Math.abs(puff.sway) <= 0.05);
    }
    // At the very end of a puff's life it is already invisible (no pop on wrap).
    const periodStart = ((1 - i / STEAM_COUNT) % 1) * STEAM_PERIOD;
    const end = steamParticle(periodStart + STEAM_PERIOD - 1e-4, i);
    assert.ok(end.fade < 1e-2, `puff ${i} still visible at wrap: ${end.fade}`);
  }
  const phases = Array.from({ length: STEAM_COUNT }, (_, i) => steamParticle(1, i).phase);
  assert.equal(new Set(phases.map(p => p.toFixed(3))).size, STEAM_COUNT, 'puffs must be staggered');
});

test('coffee steam is reserved for the top quality tier (phones stay off)', () => {
  assert.equal(qualityTier('high').steam, true);
  for (const tier of QUALITY_TIERS.filter(t => t.id !== 'high')) {
    assert.equal(tier.steam, false, `tier ${tier.id} must not pay for steam`);
  }
});
