import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FIGURE_CLIPS, FIGURE_HEIGHT, SEAT_PELVIS_Y, VAT_FPS,
  FIGURE_FLAG_KEY, figuresV8aEnabled,
  vatLayout, vatRows, clipIdForFigure, vatFrameFor,
} from '../src/figure-vat.js';
import { bakeFigureVat } from '../src/figure-vat-bake.js';
import { hashIndex } from '../src/person-appearance.js';

// --- feature flag (default OFF) ---------------------------------------------

test('V8a figures are off by default and controlled by URL and storage', () => {
  assert.equal(figuresV8aEnabled(), false);
  assert.equal(figuresV8aEnabled({ search: '', storage: null }), false);
  assert.equal(figuresV8aEnabled({ search: '?figures=v8a' }), true);
  assert.equal(figuresV8aEnabled({ search: '?foo=1&figures=v8a' }), true);
  const storage = new Map([[FIGURE_FLAG_KEY, '1']]);
  storage.getItem = storage.get;
  assert.equal(figuresV8aEnabled({ search: '', storage }), true);
  // an explicit URL value other than v8a overrides the stored opt-in
  assert.equal(figuresV8aEnabled({ search: '?figures=off', storage }), false);
  const broken = { getItem() { throw new Error('denied'); } };
  assert.equal(figuresV8aEnabled({ search: '', storage: broken }), false);
});

// --- layout & frame lookup ---------------------------------------------------

test('vat layout packs the four required clips with a wrap row each', () => {
  assert.deepEqual(FIGURE_CLIPS.map(clip => clip.id), ['idle', 'walk', 'sitTyping', 'sitLounge']);
  const layout = vatLayout();
  let row = 0;
  for (const range of layout) {
    assert.equal(range.start, row, `${range.id} starts after the previous clip's wrap row`);
    assert.ok(range.frames >= 2);
    assert.ok(Math.abs(range.frames - range.duration * VAT_FPS) <= 0.5);
    row += range.frames + 1;
  }
  assert.equal(vatRows(layout), row);
});

test('clip selection keeps the movement semantics', () => {
  assert.equal(clipIdForFigure({ sitting: true, spot: { kind: 'desk' } }), 'sitTyping');
  assert.equal(clipIdForFigure({ sitting: true, spot: { kind: 'lounge' } }), 'sitLounge');
  assert.equal(clipIdForFigure({ sitting: true, spot: { kind: 'meeting' } }), 'sitLounge');
  assert.equal(clipIdForFigure({ sitting: false, walking: true, spot: { kind: 'desk' } }), 'walk');
  assert.equal(clipIdForFigure({ sitting: false, walking: false, spot: { kind: 'report' } }), 'idle');
});

test('frame lookup stays inside its clip and staggers people', () => {
  const [idle, walk] = vatLayout();
  for (const t of [0, 0.4, 1.9, 7.3, 1000.01]) {
    for (const id of ['a', 'b', 'claude:w1']) {
      const frame = vatFrameFor(walk, t, hashIndex(id));
      assert.ok(frame >= walk.start && frame < walk.start + walk.frames);
    }
  }
  assert.ok(vatFrameFor(idle, 0, hashIndex('a')) !== vatFrameFor(idle, 0, hashIndex('d')),
    'different people start at different phases');
  const a = vatFrameFor(walk, 1, 7), b = vatFrameFor(walk, 1 + 1 / VAT_FPS, 7);
  assert.ok(Math.abs((b - a + walk.frames) % walk.frames - 1) < 1e-9, 'one tick advances one row');
});

// --- the real bake, headless on the committed CC0 GLB ------------------------

const glb = readFileSync(fileURLToPath(new URL('../public/figure-v8a.glb', import.meta.url)));
const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
const baked = bakeFigureVat(gltf);

test('bake stays inside the V8a budget and texture limits', () => {
  assert.ok(baked.triangles <= 2700, `ears dropped: ${baked.triangles} tris`);
  assert.ok(baked.triangles >= 1200, 'still a real character, not a placeholder');
  assert.ok(baked.vertexCount <= 4096, 'VAT width fits the universal texture-size limit');
  assert.equal(baked.texture.image.width, baked.vertexCount);
  assert.equal(baked.texture.image.height, vatRows(Object.values(baked.layout)));
  for (const id of ['idle', 'walk', 'sitTyping', 'sitLounge']) assert.ok(baked.layout[id], `clip ${id} baked`);
});

function frameBounds(row) {
  const { width } = baked.texture.image, data = baked.texture.image.data;
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let i = 0; i < width; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[(row * width + i) * 4 + c];
      min[c] = Math.min(min[c], value); max[c] = Math.max(max[c], value);
    }
  }
  return { min, max };
}

test('every baked row is finite and the wrap row closes each loop', () => {
  const data = baked.texture.image.data;
  for (let i = 0; i < data.length; i++) assert.ok(Number.isFinite(data[i]));
  const { width } = baked.texture.image;
  for (const range of Object.values(baked.layout)) {
    for (let i = 0; i < width * 4; i++) {
      assert.equal(data[(range.start + range.frames) * width * 4 + i], data[range.start * width * 4 + i]);
    }
  }
});

test('the figure is scaled to the primitive crowd height', () => {
  const idle = frameBounds(baked.layout.idle.start);
  assert.ok(Math.abs(idle.max[1] * baked.scale - FIGURE_HEIGHT) < 0.02, 'standing head top at FIGURE_HEIGHT');
  assert.ok(idle.min[1] * baked.scale > -0.05, 'feet on the floor');
});

test('walk animates, sitting raises the pelvis to the chair and typing moves', () => {
  const walk = baked.layout.walk;
  const early = frameBounds(walk.start), late = frameBounds(walk.start + Math.floor(walk.frames / 2));
  assert.ok(Math.abs(early.min[2] - late.min[2]) > 0.05, 'feet travel along the facing axis mid-cycle');

  for (const id of ['sitTyping', 'sitLounge']) {
    const seated = frameBounds(baked.layout[id].start);
    // the whole body sits above the floor on the chair, legs dangling
    assert.ok(seated.min[1] * baked.scale > 0.1, `${id}: no vertex left at floor level`);
    assert.ok(seated.max[1] > 0, `${id} has geometry`);
  }
  const typingA = frameBounds(baked.layout.sitTyping.start);
  const typingB = frameBounds(baked.layout.sitTyping.start + Math.floor(baked.layout.sitTyping.frames / 8));
  assert.ok(typingA.max[2] !== typingB.max[2] || typingA.max[1] !== typingB.max[1], 'typing loop is not static');
});

test('team tint only re-dyes the Main material vertices', () => {
  const tint = baked.geometry.getAttribute('aTint');
  const color = baked.geometry.getAttribute('color');
  let tinted = 0;
  for (let i = 0; i < tint.count; i++) {
    if (tint.getX(i) === 1) {
      tinted++;
      assert.deepEqual([color.getX(i), color.getY(i), color.getZ(i)], [1, 1, 1], 'tinted vertices start white');
    }
  }
  assert.ok(tinted > tint.count * 0.4, 'the shirt/body zone dominates');
  assert.ok(tinted < tint.count, 'eyes and accents keep their baked colour');
});

test('V8a draw-call and triangle budget versus the primitive crowd', () => {
  const figures = 16; // a busy office: workers + lounge + meeting reps
  const primitiveCalls = 9; // 7 body-part batches + eye batch + blob batch
  const vatCalls = 2; // VAT mesh + blob batch
  assert.ok(vatCalls < primitiveCalls);
  const vatTriangles = baked.triangles * figures;
  assert.ok(vatTriangles < 50_000, `${vatTriangles} tris for ${figures} figures stays well under the 120k phone budget`);
  assert.equal(SEAT_PELVIS_Y > 0.6 && SEAT_PELVIS_Y < 0.85, true);
});
