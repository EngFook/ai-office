import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCENE_ENV_URL, SCENE_ENV_INTENSITY, SUN_OFFSET, shadowFrustum, shadowMapSize, detectShadowMapSize,
  QUALITY_TIERS, qualityTier, initialTierId, detectInitialTierId, degradedTierId, improvedTierId, tierDpr, monitorBounds,
} from '../src/scene-quality.js';
import { createSharedLayout } from '../src/shared-layout.js';

const sunDirection = () => {
  const length = Math.hypot(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
  return { x: -SUN_OFFSET.x / length, y: -SUN_OFFSET.y / length, z: -SUN_OFFSET.z / length };
};

test('shadow frustum covers every corner of the office volume', () => {
  const bounds = createSharedLayout([], new Map(), {}).bounds;
  const ceiling = 6;
  const frustum = shadowFrustum(bounds, { ceiling });
  const dir = sunDirection();
  const flat = Math.hypot(dir.x, dir.z);
  const right = { x: dir.z / flat, y: 0, z: -dir.x / flat };
  const up = { x: -dir.y * dir.x / flat, y: flat, z: -dir.y * dir.z / flat };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, ceiling]) {
    const corner = { x: sx * bounds.width / 2, y, z: sz * bounds.depth / 2 };
    const alongRight = corner.x * right.x + corner.y * right.y + corner.z * right.z;
    const alongUp = corner.x * up.x + corner.y * up.y + corner.z * up.z;
    assert.ok(Math.abs(alongRight) <= frustum.x, `corner ${sx},${y},${sz} escapes horizontally`);
    assert.ok(Math.abs(alongUp) <= frustum.y, `corner ${sx},${y},${sz} escapes vertically`);
  }
});

test('shadow frustum is tighter than the old span-based square', () => {
  const bounds = createSharedLayout([], new Map(), {}).bounds;
  const frustum = shadowFrustum(bounds);
  const oldExtent = Math.max(64, bounds.width, bounds.depth) * 0.75;
  assert.ok(frustum.x * frustum.y < oldExtent * oldExtent, 'new frustum area should shrink');
  assert.ok(frustum.y < oldExtent * 0.8, 'vertical extent should tighten the most');
});

test('shadow map size: phones keep 1024, desktops get 2048', () => {
  assert.equal(shadowMapSize({ coarsePointer: true, width: 2000 }), 1024);
  assert.equal(shadowMapSize({ coarsePointer: false, width: 540 }), 1024);
  assert.equal(shadowMapSize({ coarsePointer: false, width: 1440 }), 2048);
  assert.equal(shadowMapSize(), 2048);
  assert.equal(detectShadowMapSize(), 1024, 'no window (tests/SSR) falls back to the safe tier');
});

test('quality tiers follow the approved V5 spec', () => {
  assert.deepEqual(QUALITY_TIERS.map(tier => tier.id), ['high', 'balanced', 'low']);
  const high = qualityTier('high'), balanced = qualityTier('balanced'), low = qualityTier('low');
  assert.equal(high.dpr, 2, 'Mac tier renders at dpr 2');
  assert.ok(high.postprocessing, 'postprocessing (V7) is reserved for the top tier');
  assert.equal(high.distantHz, Infinity, 'top tier animates every figure every frame');
  for (const tier of [balanced, low]) {
    assert.ok(tier.dpr >= 1 && tier.dpr <= 1.25, `phone tier ${tier.id} keeps dpr within 1–1.25`);
    assert.ok(!tier.postprocessing, `phone tier ${tier.id} disables postprocessing`);
    assert.ok(Number.isFinite(tier.distantHz), `phone tier ${tier.id} throttles distant figures`);
  }
  assert.equal(balanced.distantHz, 30, 'phones refresh distant figures at 30Hz');
  assert.equal(qualityTier('nonsense').id, 'low', 'unknown ids fall back to the safest tier');
});

test('desktops start at the top tier, phones one tier down', () => {
  assert.equal(initialTierId({ coarsePointer: false, width: 1440 }), 'high');
  assert.equal(initialTierId({ coarsePointer: true, width: 2000 }), 'balanced');
  assert.equal(initialTierId({ coarsePointer: false, width: 540 }), 'balanced');
  assert.equal(detectInitialTierId(), 'balanced', 'no window (tests/SSR) falls back to the phone tier');
});

test('tier stepping degrades one notch at a time and recovers only up to the ceiling', () => {
  assert.equal(degradedTierId('high'), 'balanced');
  assert.equal(degradedTierId('balanced'), 'low');
  assert.equal(degradedTierId('low'), 'low', 'bottom tier cannot degrade further');
  assert.equal(improvedTierId('low', 'high'), 'balanced');
  assert.equal(improvedTierId('balanced', 'high'), 'high');
  assert.equal(improvedTierId('high', 'high'), 'high', 'top tier cannot improve further');
  assert.equal(improvedTierId('low', 'balanced'), 'balanced');
  assert.equal(improvedTierId('balanced', 'balanced'), 'balanced', 'phones never climb above their start tier');
});

test('tier dpr is capped by the real device pixel ratio', () => {
  assert.equal(tierDpr(qualityTier('high'), 2), 2);
  assert.equal(tierDpr(qualityTier('high'), 1), 1, 'a 1x desktop screen stays at dpr 1');
  assert.equal(tierDpr(qualityTier('balanced'), 3), 1.25, 'a 3x phone renders at dpr 1.25');
  assert.equal(tierDpr(qualityTier('low'), 3), 1);
  assert.equal(tierDpr(qualityTier('low'), 0), 1, 'degenerate ratios clamp to 1');
});

test('monitor bounds bracket the demand-loop tick rate', () => {
  for (const tier of QUALITY_TIERS) {
    const [lower, upper] = monitorBounds(tier.motionHz);
    assert.ok(lower < tier.motionHz, `${tier.id}: steady ticking must not read as low fps`);
    assert.ok(upper > tier.motionHz, `${tier.id}: steady ticking must not read as headroom`);
    assert.ok(lower >= tier.motionHz * 0.5, `${tier.id}: a halved frame rate must trigger a decline`);
  }
});

test('OfficeScene wires the adaptive tiers into the canvas', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/OfficeScene.jsx', import.meta.url)), 'utf8');
  assert.ok(source.includes('PerformanceMonitor'), 'drei PerformanceMonitor drives the tier changes');
  assert.ok(source.includes('setDpr'), 'tier changes re-step the render resolution');
  assert.ok(source.includes('distantHz'), 'distant figures honour the tier throttle');
  assert.ok(source.includes('motionHz'), 'the ambient tick follows the tier');
});

test('bundled environment map is a parseable Radiance HDR at ~256px', async () => {
  assert.ok(SCENE_ENV_INTENSITY > 0 && SCENE_ENV_INTENSITY <= 0.6);
  const file = fileURLToPath(new URL(`../public${SCENE_ENV_URL}`, import.meta.url));
  const bytes = readFileSync(file);
  assert.ok(bytes.length < 300_000, 'environment map must stay small for phone loads');
  const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
  const texture = new HDRLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(texture.width, 256);
  assert.equal(texture.height, 128);
  assert.ok(texture.data.length > 0);
});
