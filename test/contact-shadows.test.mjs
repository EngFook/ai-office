import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createBakedContactShadows, SHADOW_LIFT, SHADOW_MARGIN } from '../src/baked-contact-shadows.js';

// Minimal hook harness: drives the memoised component function with a useMemo
// dispatcher that follows React's semantics (per-slot cache, Object.is deps
// comparison), so rerenders can be replayed outside a real reconciler.
function mountForTest(Memoized) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  const dispatcher = {
    useMemo(create, deps) {
      const slot = cursor++;
      const previous = hooks[slot];
      if (previous && deps && previous.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.value;
      hooks[slot] = { deps, value: create() };
      return hooks[slot].value;
    },
  };
  return props => {
    const outer = internals.H;
    internals.H = dispatcher;
    cursor = 0;
    try { return Memoized.type(props); } finally { internals.H = outer; }
  };
}

// React only re-invokes a memo component when a shallow prop comparison fails,
// mirroring what the reconciler does for components without a custom compare.
const shallowEqual = (a, b) => Object.keys({ ...a, ...b }).every(key => Object.is(a[key], b[key]));

test('shadow subtree is a default-compare memo boundary over scalar bounds', () => {
  const probe = () => null;
  const Shadows = createBakedContactShadows(probe);
  assert.equal(Shadows.$$typeof, Symbol.for('react.memo'));
  assert.equal(Shadows.compare, null);
  const bounds = { x: 4, z: -2, width: 30, depth: 22 };
  // Fresh props objects from an unchanged poll/focus rerender compare equal, so
  // React bails out and the inner frames=1 counter is never reset.
  assert.equal(shallowEqual(bounds, { x: 4, z: -2, width: 30, depth: 22 }), true);
  assert.equal(shallowEqual(bounds, { x: 4, z: -2, width: 31, depth: 22 }), false);
});

test('unchanged rerenders keep the position and scale arrays reference-stable', () => {
  const Shadows = createBakedContactShadows(props => props);
  const render = mountForTest(Shadows);
  const first = render({ x: 4, z: -2, width: 30, depth: 22 });
  const second = render({ x: 4, z: -2, width: 30, depth: 22 });
  // Same array identities mean drei's render-target useMemo deps are unchanged:
  // no WebGLRenderTarget reallocation even if a rerender slipped through.
  assert.equal(second.props.scale, first.props.scale);
  assert.equal(second.props.position, first.props.position);
  assert.deepEqual(first.props.position, [4, SHADOW_LIFT, -2]);
  assert.deepEqual(first.props.scale, [30 + SHADOW_MARGIN, 22 + SHADOW_MARGIN]);
});

test('changed bounds rebuild the arrays so a real layout change still rebakes', () => {
  const Shadows = createBakedContactShadows(props => props);
  const render = mountForTest(Shadows);
  const before = render({ x: 4, z: -2, width: 30, depth: 22 });
  const after = render({ x: 4, z: -2, width: 36, depth: 22 });
  assert.notEqual(after.props.scale, before.props.scale);
  assert.deepEqual(after.props.scale, [42, 28]);
  assert.equal(after.props.position, before.props.position);
});

test('bake settings from V1 are preserved on the inner drei component', () => {
  const Shadows = createBakedContactShadows(props => props);
  const element = mountForTest(Shadows)({ x: 0, z: 0, width: 10, depth: 10 });
  assert.equal(element.props.frames, 1);
  assert.equal(element.props.resolution, 512);
  assert.equal(element.props.far, 3);
  assert.equal(element.props.blur, 1.6);
  assert.equal(element.props.opacity, .35);
  assert.equal(element.props.color, '#1d150e');
});

test('OfficeScene feeds the memo boundary scalars instead of inline ContactShadows arrays', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/OfficeScene.jsx', import.meta.url)), 'utf8');
  assert.match(source, /<BakedContactShadows x=\{layout\.bounds\.x\} z=\{layout\.bounds\.z\} width=\{layout\.bounds\.width\} depth=\{layout\.bounds\.depth\}\/>/);
  assert.match(source, /createBakedContactShadows\(ContactShadows\)/);
  assert.doesNotMatch(source, /<ContactShadows/);
});
