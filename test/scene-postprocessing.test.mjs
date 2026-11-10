import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  postEffectsEnabled, AO_SETTINGS, BLOOM_SETTINGS, COMPOSER_MULTISAMPLING,
} from '../src/scene-postprocessing.js';
import {
  QUALITY_TIERS, qualityTier, initialTierId, degradedTierId, improvedTierId,
} from '../src/scene-quality.js';

test('post effects follow the tier flag and default off', () => {
  assert.equal(postEffectsEnabled(qualityTier('high')), true);
  assert.equal(postEffectsEnabled(qualityTier('balanced')), false);
  assert.equal(postEffectsEnabled(qualityTier('low')), false);
  assert.equal(postEffectsEnabled({}), false);
  assert.equal(postEffectsEnabled(), false);
  assert.equal(postEffectsEnabled({ postprocessing: 'yes' }), false, 'flag must be strictly boolean');
});

test('only the single top desktop tier carries the postprocessing flag', () => {
  const flagged = QUALITY_TIERS.filter(tier => tier.postprocessing);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, QUALITY_TIERS[0].id);
});

test('no tier reachable from a handheld start ever enables post effects', () => {
  const ceiling = initialTierId({ coarsePointer: true, width: 390 });
  const reachable = new Set([ceiling]);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...reachable]) {
      for (const next of [degradedTierId(id), improvedTierId(id, ceiling)]) {
        if (!reachable.has(next)) { reachable.add(next); changed = true; }
      }
    }
  }
  for (const id of reachable) {
    assert.equal(postEffectsEnabled(qualityTier(id)), false, `tier ${id} must stay composer-free on phones`);
  }
});

test('desktops start on the post-effects tier and recover back to it', () => {
  const desktop = initialTierId({ coarsePointer: false, width: 1512 });
  assert.equal(postEffectsEnabled(qualityTier(desktop)), true);
  assert.equal(improvedTierId(degradedTierId(desktop), desktop), desktop);
});

test('AO runs half-res with a furniture-scale radius, per the approved spec', () => {
  assert.equal(AO_SETTINGS.halfRes, true);
  assert.equal(AO_SETTINGS.depthAwareUpsampling, true, 'half-res AO needs depth-aware upsampling to avoid edge halos');
  assert.ok(['performance', 'low', 'medium'].includes(AO_SETTINGS.quality), 'quality preset must stay in the cheap range');
  assert.ok(AO_SETTINGS.aoRadius > 0.5 && AO_SETTINGS.aoRadius < 4, 'radius should match desk/person scale, not whole rooms');
  assert.ok(AO_SETTINGS.intensity > 0 && AO_SETTINGS.intensity <= 3);
  assert.ok(AO_SETTINGS.distanceFalloff > 0);
});

test('bloom stays subtle: thresholded near white, low intensity, mipmap blur', () => {
  assert.equal(BLOOM_SETTINGS.mipmapBlur, true);
  assert.ok(BLOOM_SETTINGS.intensity > 0 && BLOOM_SETTINGS.intensity <= 0.5, 'bloom must stay 轻微');
  assert.ok(BLOOM_SETTINGS.luminanceThreshold >= 0.7, 'ordinary surfaces must not bloom');
  assert.ok(BLOOM_SETTINGS.luminanceSmoothing > 0 && BLOOM_SETTINGS.luminanceSmoothing <= 0.5);
});

test('composer multisampling is a small power of two', () => {
  assert.ok(Number.isInteger(COMPOSER_MULTISAMPLING));
  assert.ok(COMPOSER_MULTISAMPLING >= 2 && COMPOSER_MULTISAMPLING <= 8);
  assert.equal(COMPOSER_MULTISAMPLING & (COMPOSER_MULTISAMPLING - 1), 0);
});

test('the scene mounts the chain behind the tier gate with AgX restored last', () => {
  const read = file => readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
  const scene = read('OfficeScene.jsx');
  assert.match(scene, /postEffectsEnabled\(tier\)/, 'composer must consult the live tier');
  assert.match(scene, /<PostEffects\/>/, 'chain must be mounted in the canvas');
  assert.match(scene, /lazy\(\(\)=>import\('\.\/PostEffects\.jsx'\)\)/, 'phone tiers must not download the composer chunk');
  const chain = read('PostEffects.jsx').match(/<EffectComposer[\s\S]*?<\/EffectComposer>/)?.[0];
  assert.ok(chain, 'EffectComposer block present');
  const order = ['<N8AO', '<Bloom', '<ToneMapping'].map(tag => chain.indexOf(tag));
  assert.ok(order.every(index => index >= 0), 'chain holds N8AO, Bloom and ToneMapping');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'tone mapping must be the final effect');
  assert.match(chain, /ToneMappingMode\.AGX/, 'must restore the AgX grade the composer bypasses');
});
