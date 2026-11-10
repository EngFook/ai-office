import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPING_SWING, TORSO_BOB, BREATH_BOB, WALK_LEAN, HIP_SWAY, ARM_SWING, STEP_LIFT,
  REST_DURATION, REST_PERIOD_MIN, REST_PERIOD_SPAN,
  HEAD_YAW_LIMIT, HEAD_BEHIND, GLANCE_DURATION,
  BLINK_DURATION, BLINK_PERIOD_MIN, BLINK_PERIOD_SPAN, BLINK_MIN_SCALE,
  NOD_DURATION, NOD_PERIOD_MIN, NOD_PITCH, NOD_HZ, HEAD_DAMP_RATE,
  CHAT_DURATION, CHAT_PERIOD_MIN,
  restEvent, seatedMotion, walkMotion,
  normalizeAngle, relativeYaw, clampHeadYaw, dampAngle, stepHeadYaw, isGlancing,
  blinkScale, nodMotion, isChatting,
} from '../src/person-motion.js';
import { hashIndex } from '../src/person-appearance.js';
import { createSharedLayout } from '../src/shared-layout.js';
import { createMovement, REPORT_DWELL_MS } from '../src/movement.js';

const hashes = Array.from({ length: 24 }, (_, i) => hashIndex(`agent-${i}-${(i * 2654435761 >>> 0).toString(36)}`));
const times = Array.from({ length: 400 }, (_, i) => i * 0.25); // 100 s at 4 Hz

test('motion curves are deterministic for the same time and person', () => {
  for (const h of hashes.slice(0, 5)) {
    assert.deepEqual(seatedMotion(12.34, h, true), seatedMotion(12.34, h, true));
    assert.deepEqual(walkMotion(12.34, h), walkMotion(12.34, h));
    assert.deepEqual(restEvent(12.34, h), restEvent(12.34, h));
    assert.equal(isGlancing(12.34, h), isGlancing(12.34, h));
  }
});

test('rest events are occasional, bounded, eased and of both kinds', () => {
  let active = 0, total = 0;
  const kinds = new Set();
  for (const h of hashes) for (const t of times) {
    const { amount, kind } = restEvent(t, h);
    assert.ok(amount >= 0 && amount <= 1, `amount ${amount} out of range`);
    if (amount > 0) { assert.ok(kind === 'stretch' || kind === 'lean'); active++; kinds.add(kind); }
    total++;
  }
  // REST_DURATION out of every 12..19 s period: a minority of the time.
  assert.ok(active / total < REST_DURATION / REST_PERIOD_MIN + 0.05, 'resting too often');
  assert.ok(active / total > 0.02, 'resting never happens');
  assert.deepEqual([...kinds].sort(), ['lean', 'stretch']);
  // The ease never jumps: neighbouring samples at 60 Hz stay close.
  for (const h of hashes.slice(0, 4)) for (let t = 0; t < 40; t += 1 / 60) {
    const step = Math.abs(restEvent(t + 1 / 60, h).amount - restEvent(t, h).amount);
    assert.ok(step < 0.05, `rest amount jumped by ${step}`);
  }
});

test('rest cycles differ between people', () => {
  const signatures = new Set(hashes.map(h => times.map(t => restEvent(t, h).amount > 0 ? 1 : 0).join('')));
  assert.ok(signatures.size >= hashes.length / 2, 'rest timing too uniform across the crowd');
});

test('seated typing swings arms and bobs the torso, within bounds', () => {
  for (const h of hashes.slice(0, 8)) {
    let typingSeen = 0, bobMax = 0;
    for (const t of times) {
      const m = seatedMotion(t, h, true);
      assert.ok(Math.abs(m.typing) <= TYPING_SWING + 1e-9);
      assert.ok(Math.abs(m.bob) <= TORSO_BOB + BREATH_BOB + 1e-9);
      typingSeen = Math.max(typingSeen, Math.abs(m.typing));
      bobMax = Math.max(bobMax, Math.abs(m.bob));
    }
    assert.ok(typingSeen > TYPING_SWING * 0.8, 'arms barely move while typing');
    assert.ok(bobMax > BREATH_BOB, 'torso never bobs');
  }
});

test('typing pauses during a rest event; non-agents never type but still breathe', () => {
  const h = hashes[0];
  // Find the middle of a rest event (full amount).
  const peak = times.find(t => restEvent(t, h).amount > 0.99);
  assert.ok(peak !== undefined, 'no fully eased-in rest event found');
  const resting = seatedMotion(peak, h, true);
  assert.ok(Math.abs(resting.typing) < 1e-9, 'still typing mid-stretch');
  assert.ok(Math.max(resting.stretch, resting.lean) > 0.99);
  for (const t of times.slice(0, 50)) {
    const idle = seatedMotion(t, h, false);
    assert.ok(idle.typing === 0, `non-agent typing ${idle.typing}`);
    assert.ok(Math.abs(idle.bob) <= BREATH_BOB + 1e-9 && Math.abs(idle.bob) >= 0);
  }
});

test('walking adds a constant forward lean and a bounded hip sway', () => {
  for (const h of hashes.slice(0, 8)) {
    let swayMax = 0;
    for (const t of times) {
      const m = walkMotion(t, h);
      assert.equal(m.lean, WALK_LEAN);
      assert.ok(Math.abs(m.sway) <= HIP_SWAY + 1e-9);
      assert.ok(Math.abs(m.swing) <= ARM_SWING + 1e-9);
      assert.ok(m.lift >= 0 && m.lift <= STEP_LIFT + 1e-9);
      swayMax = Math.max(swayMax, Math.abs(m.sway));
    }
    assert.ok(swayMax > HIP_SWAY * 0.9, 'hips never sway');
  }
});

test('a figure dwelling at the report point keeps a neutral standing pose', () => {
  // Drive the real movement system to the report dwell: an agent finishes
  // work, walks to the report spot and stands there for REPORT_DWELL_MS.
  const layout = createSharedLayout([]);
  const m = createMovement({ lounge: layout.lounge, commons: layout.commons });
  const desk = layout.desks.find(d => d.zone === 'claude');
  m.sync({ working: [{ id: 'w', provider: 'claude', desk }], now: 0, initial: true });
  m.sync({ working: [], now: 10 });
  let arrivedAt = null;
  for (let t = 10; t < 200000 && arrivedAt === null; t += 100) {
    m.step(t);
    const f = m.figures.get('w');
    if (f?.spot?.kind === 'report' && !f.walking) arrivedAt = t;
  }
  assert.ok(arrivedAt !== null, 'figure never reached the report point');
  m.step(arrivedAt + REPORT_DWELL_MS / 2);
  const fig = m.figures.get('w');
  assert.equal(fig.spot.kind, 'report');
  assert.equal(fig.walking, false, 'mid-dwell the figure stands still');
  assert.equal(fig.sitting, false, 'the report spot is a standing spot');
  // The scene feeds f.walking into walkMotion: during the dwell every gait
  // driver is neutral at any time, so legs and arms never march in place...
  const neutral = { swing: 0, lift: 0, lean: 0, sway: 0 };
  for (const t of [0, 0.42, 7.3, 123.4]) {
    assert.deepEqual(walkMotion(t, hashes[0], fig.walking), neutral);
    assert.deepEqual(walkMotion(t, hashes[1], false), neutral);
  }
  // ...while a really walking figure keeps the full (default) gait.
  assert.notDeepEqual(walkMotion(0.42, hashes[0], true), neutral);
  assert.deepEqual(walkMotion(0.42, hashes[0], true), walkMotion(0.42, hashes[0]));
});

test('head damping stays frame-rate independent across the distant throttle', () => {
  const target = clampHeadYaw(0.6);
  // Simulate one second of rendering at `fps` with the V5 distant gate at
  // `gateHz` (gated frames skip the figure entirely, like the scene does),
  // then compare the damped yaw at the same real time t=1 s.
  const run = (fps, gateHz) => {
    const states = new Map();
    stepHeadYaw(states, 'p', target, 0); // first sighting: registers the clock
    let gateAt = 0;
    for (let frame = 1; frame / fps < 1; frame++) {
      const t = frame / fps;
      if (gateHz && t - gateAt < 1 / gateHz) continue; // throttled: no update
      gateAt = t;
      stepHeadYaw(states, 'p', target, t);
    }
    return stepHeadYaw(states, 'p', target, 1);
  };
  const expected = target * (1 - Math.exp(-HEAD_DAMP_RATE * 1)); // 1 s of damping
  for (const gate of [null, 12]) {
    const at60 = run(60, gate), at144 = run(144, gate);
    assert.ok(Math.abs(at60 - expected) < 1e-9, `60 fps, gate ${gate}: ${at60} != ${expected}`);
    assert.ok(Math.abs(at144 - expected) < 1e-9, `144 fps, gate ${gate}: ${at144} != ${expected}`);
    assert.ok(Math.abs(at60 - at144) < 1e-12, 'render rate must not change the damping');
  }
  // The state map records per-figure yaw and time, as the scene relies on.
  const states = new Map();
  stepHeadYaw(states, 'p', target, 2);
  const mid = stepHeadYaw(states, 'p', target, 2.5);
  assert.ok(Math.abs(mid - dampAngle(0, target, 0.5)) < 1e-12);
  assert.deepEqual(states.get('p'), { yaw: mid, t: 2.5 });
});

test('relativeYaw matches the movement.js heading convention', () => {
  assert.ok(Math.abs(relativeYaw(0, 0, 0, 0, 5)) < 1e-9); // dead ahead (+z)
  assert.ok(Math.abs(relativeYaw(0, 0, 0, 5, 0) - Math.PI / 2) < 1e-9); // to the right (+x)
  assert.ok(Math.abs(relativeYaw(0, 0, Math.PI / 2, 5, 0)) < 1e-9); // facing +x already
  // Wrap-around stays in [-pi, pi].
  const wrapped = relativeYaw(0, 0, Math.PI * 0.9, 0, -5);
  assert.ok(Math.abs(wrapped) <= Math.PI + 1e-9 && Math.abs(normalizeAngle(wrapped)) - Math.abs(wrapped) < 1e-9);
});

test('head yaw is clamped to the neck range and ignores rear targets', () => {
  assert.equal(clampHeadYaw(0.3), 0.3);
  assert.equal(clampHeadYaw(1.2), HEAD_YAW_LIMIT);
  assert.equal(clampHeadYaw(-1.2), -HEAD_YAW_LIMIT);
  assert.equal(clampHeadYaw(HEAD_BEHIND + 0.1), 0);
  assert.equal(clampHeadYaw(-(HEAD_BEHIND + 0.1)), 0);
  assert.equal(clampHeadYaw(NaN), 0);
});

test('dampAngle converges smoothly and is frame-rate independent at the limit', () => {
  let yaw = 0;
  const target = 0.5;
  for (let i = 0; i < 60; i++) {
    const next = dampAngle(yaw, target, 1 / 60);
    assert.ok(Math.abs(target - next) < Math.abs(target - yaw), 'not converging');
    yaw = next;
  }
  assert.ok(Math.abs(yaw - target) < 0.05, `still ${Math.abs(yaw - target)} away after 1 s`);
  assert.equal(dampAngle(0.4, 0.4, 0.016), 0.4); // at target: stays
  assert.equal(dampAngle(0.1, 0.5, 0), 0.1); // zero dt: unchanged
  assert.ok(Math.abs(dampAngle(0, target, 10) - target) < 1e-9, 'huge dt overshoots'); // long idle frame lands on target
});

test('blinks are quick, bounded dips on personal rhythms', () => {
  // Dense sampling so no ~120 ms blink falls between samples.
  const dense = Array.from({ length: 3000 }, (_, i) => i * 0.01); // 30 s at 100 Hz
  for (const h of hashes.slice(0, 8)) {
    let closed = 0, fullyClosed = false;
    for (const t of dense) {
      const lid = blinkScale(t, h);
      assert.ok(lid >= BLINK_MIN_SCALE - 1e-9 && lid <= 1, `lid ${lid} out of range`);
      assert.equal(lid, blinkScale(t, h)); // deterministic
      if (lid < 1) closed++;
      // 10 ms samples land within 5 ms of the triangle's tip: nearly closed.
      if (lid <= BLINK_MIN_SCALE + 0.09) fullyClosed = true;
    }
    // Eyes are open the vast majority of the time but do blink and do close.
    const maxClosedShare = BLINK_DURATION / BLINK_PERIOD_MIN + 0.01;
    assert.ok(closed / dense.length < maxClosedShare, `eyes shut ${closed / dense.length} of the time`);
    assert.ok(closed > 0, 'never blinks');
    assert.ok(fullyClosed, 'blink never reaches the closed lid scale');
  }
  // Blink phase/period differ across the crowd: no synchronized blinking.
  const signatures = new Set(hashes.map(h => dense.slice(0, 1000).map(t => blinkScale(t, h) < 1 ? 1 : 0).join('')));
  assert.ok(signatures.size >= hashes.length / 2, 'blink timing too uniform');
  // A blink window itself lasts about BLINK_DURATION, not longer.
  const h = hashes[0];
  const start = dense.find(t => blinkScale(t, h) < 1);
  let end = start;
  while (blinkScale(end, h) < 1) end += 0.005;
  assert.ok(end - start <= BLINK_DURATION + 0.02, `blink lasted ${end - start} s`);
  // Period bounds hold: at least one blink every BLINK_PERIOD span.
  assert.ok(BLINK_PERIOD_MIN + BLINK_PERIOD_SPAN < 6.1);
});

test('meeting nods come in eased occasional bursts within pitch bounds', () => {
  let active = 0, total = 0;
  for (const h of hashes) for (const t of times) {
    const nod = nodMotion(t, h);
    assert.ok(nod >= 0 && nod <= NOD_PITCH + 1e-9, `nod ${nod} out of range`);
    assert.equal(nod, nodMotion(t, h));
    if (nod > 0) active++;
    total++;
  }
  assert.ok(active / total < NOD_DURATION / NOD_PERIOD_MIN + 0.05, 'nodding too often');
  assert.ok(active / total > 0.02, 'never nodding');
  // Dense sampling (the 4 Hz grid aliases against the 2.1 Hz oscillator):
  // mid-burst the head reaches close to the full nod pitch.
  let peak = 0;
  for (const h of hashes.slice(0, 4)) for (let t = 0; t < 30; t += 0.01) peak = Math.max(peak, nodMotion(t, h));
  assert.ok(peak > NOD_PITCH * 0.85, 'nods barely move the head');
  // The envelope eases: 60 Hz neighbours stay close (no head snapping).
  for (const h of hashes.slice(0, 4)) for (let t = 0; t < 30; t += 1 / 60) {
    const step = Math.abs(nodMotion(t + 1 / 60, h) - nodMotion(t, h));
    assert.ok(step < NOD_PITCH * 0.35, `nod pitch jumped by ${step}`);
  }
  const signatures = new Set(hashes.map(h => times.map(t => nodMotion(t, h) > 0 ? 1 : 0).join('')));
  assert.ok(signatures.size >= hashes.length / 2, 'nod timing too uniform');
});

test('nod peaks inside a burst are spaced at ~1/NOD_HZ, not double rate', () => {
  const step = 0.0005;
  for (const h of hashes.slice(0, 6)) {
    // Strict local maxima of the real curve; the height threshold keeps only
    // well-formed peaks (the burst's fading tail peak is far lower and gets
    // pulled off-beat by the envelope slope).
    const peaks = [];
    for (let t = step; t < 40; t += step) {
      const prev = nodMotion(t - step, h), cur = nodMotion(t, h), next = nodMotion(t + step, h);
      if (cur > prev && cur >= next && cur > NOD_PITCH * 0.6) peaks.push(t);
    }
    assert.ok(peaks.length >= 3, `only ${peaks.length} nod peaks in 40 s`);
    const gaps = peaks.slice(1).map((t, i) => t - peaks[i]).filter(gap => gap < NOD_DURATION);
    assert.ok(gaps.length >= 2, 'bursts never contain consecutive down-nods');
    for (const gap of gaps) {
      assert.ok(Math.abs(gap - 1 / NOD_HZ) < 0.06,
        `nod spacing ${gap.toFixed(4)} s is off the ${(1 / NOD_HZ).toFixed(4)} s cycle (abs(sin) would halve it)`);
    }
  }
});

test('lounge chat windows are longer and more frequent than desk glances', () => {
  assert.ok(CHAT_DURATION > GLANCE_DURATION);
  assert.ok(CHAT_PERIOD_MIN < 9); // glance periods start at 9 s
  let chatting = 0, total = 0;
  for (const h of hashes) for (const t of times) { if (isChatting(t, h)) chatting++; total++; }
  assert.ok(chatting / total < CHAT_DURATION / CHAT_PERIOD_MIN + 0.05, 'chatting too often');
  assert.ok(chatting / total > 0.15, 'lounge conversations barely happen');
  const signatures = new Set(hashes.map(h => times.slice(0, 200).map(t => isChatting(t, h) ? 1 : 0).join('')));
  assert.ok(signatures.size >= hashes.length / 2, 'chat timing too uniform');
});

test('glances are occasional windows that differ between people', () => {
  let glancing = 0, total = 0;
  for (const h of hashes) for (const t of times) { if (isGlancing(t, h)) glancing++; total++; }
  assert.ok(glancing / total < GLANCE_DURATION / 9 + 0.05, 'glancing too often');
  assert.ok(glancing / total > 0.05, 'never glancing');
  const signatures = new Set(hashes.map(h => times.slice(0, 200).map(t => isGlancing(t, h) ? 1 : 0).join('')));
  assert.ok(signatures.size >= hashes.length / 2, 'glance timing too uniform');
});
