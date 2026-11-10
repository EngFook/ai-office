import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SKINS, HAIR, TROUSERS, HEIGHT_JITTER,
  personAppearance, shadeColor, hashIndex,
  SHADOW_FLOOR_Y, SHADOW_SPOT_Y, shadowHeightFor,
} from '../src/person-appearance.js';

const ids = Array.from({ length: 60 }, (_, i) => `agent-${i}-${(i * 2654435761 >>> 0).toString(36)}`);

test('appearance is deterministic for the same id and team colour', () => {
  for (const id of ids.slice(0, 10)) {
    assert.deepEqual(personAppearance(id, '#d97757'), personAppearance(id, '#d97757'));
  }
});

test('skin, hair and trousers come from the fixed palettes', () => {
  for (const id of ids) {
    const look = personAppearance(id, '#d97757');
    assert.ok(SKINS.includes(look.skin), `unknown skin ${look.skin}`);
    assert.ok(HAIR.includes(look.hair), `unknown hair ${look.hair}`);
    assert.ok(TROUSERS.includes(look.trousers), `unknown trousers ${look.trousers}`);
  }
});

test('a crowd actually varies in skin, hair and height', () => {
  const looks = ids.map(id => personAppearance(id, '#d97757'));
  assert.ok(new Set(looks.map(l => l.skin)).size >= 4, 'too few skin tones');
  assert.ok(new Set(looks.map(l => l.hair)).size >= 3, 'too few hair colours');
  assert.ok(new Set(looks.map(l => l.height)).size >= 8, 'too few heights');
  assert.ok(new Set(looks.map(l => l.shirt)).size >= 3, 'too few shirt shades');
});

test('height jitter stays within ±8%', () => {
  for (const id of ids) {
    const { height } = personAppearance(id, '#d97757');
    assert.ok(height >= 1 - HEIGHT_JITTER - 1e-9 && height <= 1 + HEIGHT_JITTER + 1e-9, `height ${height} out of range`);
  }
});

test('shirts stay recognisably in the team colour', () => {
  for (const id of ids) {
    const { shirt } = personAppearance(id, '#d97757');
    assert.match(shirt, /^#[0-9a-f]{6}$/);
    // Same hue family: channel ratios of the team colour are preserved by a pure shade.
    const [r, g, b] = [1, 3, 5].map(i => parseInt(shirt.slice(i, i + 2), 16));
    const [tr, tg, tb] = [1, 3, 5].map(i => parseInt('#d97757'.slice(i, i + 2), 16));
    assert.ok(Math.abs(r / tr - b / tb) < 0.1 && Math.abs(r / tr - g / tg) < 0.1, `shirt ${shirt} drifted off the team hue`);
  }
});

test('shadeColor scales channels and clamps at 255', () => {
  assert.equal(shadeColor('#808080', 1), '#808080');
  assert.equal(shadeColor('#808080', 0.5), '#404040');
  assert.equal(shadeColor('#f0f0f0', 2), '#ffffff');
  assert.equal(shadeColor('#000000', 3), '#000000');
});

test('hashIndex is a stable unsigned integer', () => {
  for (const id of ids.slice(0, 10)) {
    const h = hashIndex(id);
    assert.equal(h, hashIndex(id));
    assert.ok(Number.isInteger(h) && h >= 0);
  }
});

test('blob shadow height follows the platform under the figure', () => {
  assert.equal(shadowHeightFor({ walking: true, spot: { kind: 'desk' } }), SHADOW_FLOOR_Y);
  assert.equal(shadowHeightFor({ walking: false, spot: { kind: 'desk' } }), SHADOW_SPOT_Y.desk);
  assert.equal(shadowHeightFor({ walking: false, spot: { kind: 'lounge' } }), SHADOW_SPOT_Y.lounge);
  assert.equal(shadowHeightFor({ walking: false, spot: { kind: 'meeting' } }), SHADOW_SPOT_Y.meeting);
  assert.equal(shadowHeightFor({ walking: false, spot: { kind: 'report' } }), SHADOW_SPOT_Y.report);
  assert.equal(shadowHeightFor({ walking: false }), SHADOW_FLOOR_Y);
  // Every platform height clears the main floor planks (top ≈ 0.0425) and sits above its rug/pod.
  for (const y of [SHADOW_FLOOR_Y, ...Object.values(SHADOW_SPOT_Y)]) assert.ok(y > 0.0425);
  assert.ok(SHADOW_SPOT_Y.desk > 0.1175, 'desk shadow must clear the pod platform');
});
