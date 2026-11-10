import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scene, OrthographicCamera, Mesh, PlaneGeometry, MeshStandardMaterial } from 'three';
import { N8AOPostPass } from 'n8ao';
import {
  AO_SETTINGS, N8AO_NESTED_QUAD_KEYS, disposeN8AONestedMaterials,
} from '../src/scene-postprocessing.js';

// V7 fix regression (Codex round 1): the real N8AOPostPass from the installed
// n8ao, configured exactly like the mounted chain — orthographic camera, a
// transparent material in the scene (the office's glass/steam makes the pass
// transparency-aware, creating depthCopyPass), half-res AO on the performance
// preset. All of this runs without a WebGL context, so the lifecycle is
// testable under plain node.
function mountPass() {
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ transparent: true, opacity: 0.4 })));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const pass = new N8AOPostPass(scene, camera);
  pass.configuration.halfRes = AO_SETTINGS.halfRes;
  pass.configuration.depthAwareUpsampling = AO_SETTINGS.depthAwareUpsampling;
  const mode = AO_SETTINGS.quality;
  pass.setQualityMode(mode.charAt(0).toUpperCase() + mode.slice(1));
  return pass;
}

function trackNestedMaterials(pass) {
  const tracked = new Map();
  for (const key of N8AO_NESTED_QUAD_KEYS) {
    const material = pass[key]?.material;
    if (!material) continue;
    const entry = { disposed: false };
    material.addEventListener('dispose', () => { entry.disposed = true; });
    tracked.set(key, entry);
  }
  return tracked;
}

// Mirrors what unmounting <N8AO> now does: React detaches the cleanup ref
// (nested materials), then the library's useDispose calls pass.dispose().
function unmountPass(pass) {
  disposeN8AONestedMaterials(pass);
  pass.dispose();
}

test('production AO settings instantiate every quad the cleanup list names', () => {
  const pass = mountPass();
  const tracked = trackNestedMaterials(pass);
  assert.deepEqual(
    [...tracked.keys()].sort(),
    [...N8AO_NESTED_QUAD_KEYS].sort(),
    'a key the list names but the pass lacks means n8ao renamed an internal — update the list',
  );
  unmountPass(pass);
});

test('library dispose alone still leaks the nested materials (the bug being patched)', () => {
  const pass = mountPass();
  const tracked = trackNestedMaterials(pass);
  pass.dispose();
  const leaked = [...tracked].filter(([, entry]) => !entry.disposed).map(([key]) => key);
  assert.ok(leaked.length > 0, 'upstream now disposes nested materials itself — the app-side cleanup can be retired');
  assert.equal(disposeN8AONestedMaterials(pass), tracked.size, 'cleanup must release exactly the leaked set');
});

test('lifecycle: mount → downgrade/unmount → remount, repeated — no material leaks accumulate', () => {
  const leaks = [];
  for (let round = 1; round <= 3; round++) {
    const pass = mountPass(); // remount creates a fresh pass each round
    const tracked = trackNestedMaterials(pass);
    unmountPass(pass); // high → balanced downgrade unmounts the chain
    for (const [key, entry] of tracked) {
      if (!entry.disposed) leaks.push(`round ${round}: ${key}`);
    }
  }
  assert.deepEqual(leaks, [], 'every round must release every nested material it created');
});

test('cleanup helper is safe on null, double dispose, and halfRes-off passes', () => {
  assert.equal(disposeN8AONestedMaterials(null), 0);
  assert.equal(disposeN8AONestedMaterials(undefined), 0);
  const pass = mountPass();
  const first = disposeN8AONestedMaterials(pass);
  assert.equal(first, N8AO_NESTED_QUAD_KEYS.length);
  assert.equal(disposeN8AONestedMaterials(pass), first, 'Material.dispose() is idempotent — re-running must not throw');
  pass.dispose();
  const noHalfRes = mountPass();
  noHalfRes.configuration.halfRes = false; // n8ao nulls depthDownsampleQuad itself
  assert.equal(disposeN8AONestedMaterials(noHalfRes), N8AO_NESTED_QUAD_KEYS.length - 1);
  noHalfRes.dispose();
});

test('the component wires the nested-material cleanup onto the N8AO pass', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/PostEffects.jsx', import.meta.url)), 'utf8');
  assert.match(source, /disposeN8AONestedMaterials/, 'component must use the shared cleanup helper');
  assert.match(source, /<N8AO ref=\{aoCleanupRef\}/, 'cleanup ref must be attached to the N8AO pass');
  assert.match(source, /lastAOPass\.current\s*!==\s*pass/, 'ref detach/swap must dispose the previous pass, not the incoming one');
});
