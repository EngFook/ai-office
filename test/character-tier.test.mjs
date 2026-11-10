import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUALITY_TIERS, qualityTier, initialTierId, degradedTierId } from '../src/scene-quality.js';
import {
  RIGGED_FLAG_DEFAULT, RIGGED_MIN_FPS, RIGGED_FPS_SUSTAIN_MS, RIGGED_TIER_IDS,
  parseRiggedFlag, useRiggedCharacters, fpsSample, createFpsGate,
} from '../src/character-tier.js';

test('the rigged flag defaults ON and only the URL kill-switch turns it off', () => {
  assert.equal(RIGGED_FLAG_DEFAULT, true);
  assert.equal(parseRiggedFlag(''), true);
  assert.equal(parseRiggedFlag('?foo=1&bar=2'), true);
  for (const off of ['?rigged=0', 'rigged=off', '?rigged=false', '?a=1&rigged=no']) {
    assert.equal(parseRiggedFlag(off), false, `${off} should disable`);
  }
  for (const on of ['?rigged=1', 'rigged=on', '?rigged=true']) {
    assert.equal(parseRiggedFlag(on), true, `${on} should enable`);
  }
});

test('rigged characters run on high and balanced, never on the low tier', () => {
  assert.deepEqual(RIGGED_TIER_IDS, ['high', 'balanced'], 'tier allowlist drifted from V5');
  assert.equal(useRiggedCharacters({ qualityTier: 'high' }), true);
  assert.equal(useRiggedCharacters({ qualityTier: 'balanced' }), true);
  assert.equal(useRiggedCharacters({ qualityTier: 'low' }), false);
  // Tier objects (what useSceneQuality returns) work too; unknown ids fall back.
  assert.equal(useRiggedCharacters({ qualityTier: qualityTier('high') }), true);
  assert.equal(useRiggedCharacters({ qualityTier: qualityTier('nonsense') }), false, 'unknown tier resolves to low');
  assert.equal(useRiggedCharacters({ qualityTier: 'ultra' }), false);
  assert.equal(useRiggedCharacters({}), false);
  // Phones start on balanced (rigged OK) and degrade to low (primitives).
  const phoneStart = initialTierId({ coarsePointer: true, width: 390 });
  assert.equal(useRiggedCharacters({ qualityTier: phoneStart }), true);
  assert.equal(useRiggedCharacters({ qualityTier: degradedTierId(phoneStart) }), false);
});

test('flag off, load error and sustained low fps each force the primitives', () => {
  const ok = { qualityTier: 'high', flag: true, loadError: false, fps: Infinity };
  assert.equal(useRiggedCharacters(ok), true);
  assert.equal(useRiggedCharacters({ ...ok, flag: false }), false);
  assert.equal(useRiggedCharacters({ ...ok, loadError: true }), false);
  assert.equal(useRiggedCharacters({ ...ok, loadError: new Error('404') }), false);
  assert.equal(useRiggedCharacters({ ...ok, fps: RIGGED_MIN_FPS - 0.1 }), false);
  assert.equal(useRiggedCharacters({ ...ok, fps: RIGGED_MIN_FPS }), true, 'the threshold itself still qualifies');
  assert.equal(useRiggedCharacters({ ...ok, fps: 0 }), false);
  assert.equal(useRiggedCharacters({ qualityTier: 'high' }), true, 'defaults: flag on, no error, no fps reading');
});

test('fps samples near the demand-loop ambient tick are rejected as meaningless', () => {
  for (const { motionHz } of QUALITY_TIERS) {
    assert.equal(fpsSample(1 / motionHz, motionHz), null, `idle tick at ${motionHz}Hz is not a slow frame`);
    assert.equal(fpsSample(2 / motionHz, motionHz), null, 'skipped ticks are not slow frames either');
  }
  // Real gesture bursts measure real frame rate.
  assert.ok(Math.abs(fpsSample(1 / 60, 24) - 60) < 1e-9);
  assert.ok(Math.abs(fpsSample(1 / 30, 24) - 30) < 1e-9, 'a sub-50fps burst is a valid low sample');
  assert.equal(fpsSample(0, 24), null);
  assert.equal(fpsSample(-1, 24), null);
  assert.equal(fpsSample(NaN, 24), null);
});

test('the fps gate needs sustained low samples, resets on recovery, and latches', () => {
  const gate = createFpsGate();
  assert.equal(gate.sample(30, 0), false, 'one low sample must not trip');
  assert.equal(gate.sample(30, RIGGED_FPS_SUSTAIN_MS - 1), false, 'still inside the sustain window');
  assert.equal(gate.sample(60, RIGGED_FPS_SUSTAIN_MS), false, 'recovery resets the window');
  assert.equal(gate.sample(30, RIGGED_FPS_SUSTAIN_MS + 1), false, 'the window restarts after recovery');
  assert.equal(gate.sample(30, RIGGED_FPS_SUSTAIN_MS * 2), false);
  assert.equal(gate.sample(30, RIGGED_FPS_SUSTAIN_MS * 2 + 2), true, 'sustained low fps trips the gate');
  assert.equal(gate.tripped, true);
  assert.equal(gate.sample(120, RIGGED_FPS_SUSTAIN_MS * 3), true, 'the gate latches: no flip-flopping reloads');
  const custom = createFpsGate({ threshold: 40, sustainMs: 100 });
  assert.equal(custom.sample(45, 0), false);
  assert.equal(custom.sample(39, 0), false);
  assert.equal(custom.sample(39, 100), true);
});

test('CharacterSwitch wires the decision and OfficeScene mounts it once around People', () => {
  const read = name => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');
  const wrapper = read('CharacterSwitch.jsx');
  for (const needle of ['useRiggedCharacters', 'detectRiggedFlag', 'createFpsGate', 'fpsSample', 'getAgentClip', 'onLoadError', 'RiggedAgents']) {
    assert.ok(wrapper.includes(needle), `CharacterSwitch should wire ${needle}`);
  }
  const scene = read('OfficeScene.jsx');
  assert.equal(scene.match(/<CharacterSwitch\b/g)?.length, 1, 'exactly one mount point');
  assert.match(scene, /<CharacterSwitch[^\n]*fallback=\{<People /, 'the primitives stay as the inline fallback');
  const stub = read('RiggedAgents.jsx');
  assert.ok(stub.includes('STUB'), 'the placeholder must stay marked STUB until V8a lands');
});
