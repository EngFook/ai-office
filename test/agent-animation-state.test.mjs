import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIP_WALK, CLIP_IDLE, CLIP_SIT_TYPING, CLIP_LOUNGE_SIT, CLIP_NAMES, CLIP_FADE_MS,
  clipForFigure, clipStartedAt, getAgentClip,
} from '../src/agent-animation-state.js';
import { createSharedLayout } from '../src/shared-layout.js';
import { createMovement, REPORT_DWELL_MS } from '../src/movement.js';

const seated = (kind, agent = null) => ({ walking: false, sitting: true, agent, spot: { kind, sit: true } });

test('every behaviour state maps to a clip from the V8a set', () => {
  assert.equal(clipForFigure({ walking: true, sitting: false, walk: { start: 5 } }), CLIP_WALK);
  assert.equal(clipForFigure(seated('desk', { id: 'a' })), CLIP_SIT_TYPING);
  assert.equal(clipForFigure(seated('review', { id: 'a' })), CLIP_SIT_TYPING);
  assert.equal(clipForFigure(seated('research', { id: 'a' })), CLIP_SIT_TYPING);
  assert.equal(clipForFigure(seated('lounge')), CLIP_LOUNGE_SIT);
  assert.equal(clipForFigure(seated('meeting')), CLIP_LOUNGE_SIT);
  // A seated figure without an agent never types (same rule as seatedMotion).
  assert.equal(clipForFigure(seated('desk')), CLIP_LOUNGE_SIT);
  // The report-point dwell: standing, neither walking nor sitting.
  assert.equal(clipForFigure({ walking: false, sitting: false, spot: { kind: 'report', sit: false } }), CLIP_IDLE);
  assert.equal(clipForFigure(null), CLIP_IDLE);
  for (const figure of [
    { walking: true }, seated('desk', { id: 'a' }), seated('lounge'), seated('meeting'), { walking: false, sitting: false },
  ]) assert.ok(CLIP_NAMES.includes(clipForFigure(figure)), 'clip outside the shipped set');
});

test('every clip has a positive crossfade and walking fades fastest', () => {
  for (const clip of CLIP_NAMES) assert.ok(CLIP_FADE_MS[clip] > 0, `${clip} has no fade`);
  for (const clip of [CLIP_IDLE, CLIP_SIT_TYPING, CLIP_LOUNGE_SIT]) {
    assert.ok(CLIP_FADE_MS[CLIP_WALK] < CLIP_FADE_MS[clip], 'standing up must not lag the walk start');
  }
});

test('weight ramps 0 -> 1 over fadeMs from the state-change timestamp', () => {
  const start = 10000;
  const fig = { walking: true, walk: { start, to: null, points: [] } };
  assert.equal(clipStartedAt(fig), start);
  const fade = CLIP_FADE_MS[CLIP_WALK];
  assert.deepEqual(getAgentClip(fig, start), { clip: CLIP_WALK, weight: 0, fadeMs: fade });
  assert.equal(getAgentClip(fig, start + fade / 2).weight, 0.5);
  assert.equal(getAgentClip(fig, start + fade).weight, 1);
  assert.equal(getAgentClip(fig, start + fade * 9).weight, 1, 'weight must clamp at 1');
  assert.equal(getAgentClip(fig, start - 50).weight, 0, 'weight must clamp at 0');
  // Seated figures ramp from their arrival timestamp instead.
  const sat = { ...seated('desk', { id: 'a' }), arrivedAt: start };
  assert.equal(clipStartedAt(sat), start);
  assert.equal(getAgentClip(sat, start + CLIP_FADE_MS[CLIP_SIT_TYPING] / 4).weight, 0.25);
});

test('initial placement (no timestamp) is fully faded in and the call is pure', () => {
  for (const fig of [seated('lounge'), { ...seated('desk', { id: 'a' }), arrivedAt: 0 }, { walking: false, sitting: false }]) {
    assert.equal(getAgentClip(fig, 123456).weight, 1);
  }
  const fig = { ...seated('meeting'), arrivedAt: 400 };
  assert.deepEqual(getAgentClip(fig, 600), getAgentClip(fig, 600), 'same input, same output');
});

test('the real movement system drives walk -> sitTyping -> idle dwell -> loungeSit', () => {
  const layout = createSharedLayout([]);
  const m = createMovement({ lounge: layout.lounge, commons: layout.commons });
  const desk = layout.desks.find(d => d.zone === 'claude');
  // Not initial: the new worker spawns on a lounge seat and walks to the desk.
  m.sync({ working: [{ id: 'w', provider: 'claude', desk, agent: { id: 'w' } }], now: 0, initial: false });
  m.step(50);
  const fig = m.figures.get('w');
  assert.equal(fig.walking, true, 'the worker should start by walking to its desk');
  const walking = getAgentClip(fig, 50);
  assert.equal(walking.clip, CLIP_WALK);
  assert.ok(walking.weight >= 0 && walking.weight <= 1);
  // Walk to arrival: seated at the desk with an agent => typing.
  let seatedAt = null;
  for (let t = 50; t < 200000 && seatedAt === null; t += 100) {
    m.step(t);
    if (m.figures.get('w').sitting) seatedAt = t;
  }
  assert.ok(seatedAt !== null, 'never sat down at the desk');
  assert.equal(getAgentClip(m.figures.get('w'), seatedAt).clip, CLIP_SIT_TYPING);
  // Work ends: the figure walks to the report point and stands idle there.
  m.sync({ working: [], now: seatedAt + 100 });
  let dwellAt = null;
  for (let t = seatedAt + 100; t < seatedAt + 300000 && dwellAt === null; t += 100) {
    m.step(t);
    const f = m.figures.get('w');
    if (f.spot?.kind === 'report' && !f.walking) dwellAt = t;
  }
  assert.ok(dwellAt !== null, 'never reached the report point');
  const dwell = getAgentClip(m.figures.get('w'), dwellAt + REPORT_DWELL_MS / 2);
  assert.equal(dwell.clip, CLIP_IDLE, 'the report dwell is a standing idle');
  // After the dwell the figure rests on a sofa: loungeSit.
  let restingAt = null;
  for (let t = dwellAt + REPORT_DWELL_MS; t < dwellAt + 400000 && restingAt === null; t += 100) {
    m.step(t);
    const f = m.figures.get('w');
    if (f.spot?.kind === 'lounge' && f.sitting) restingAt = t;
  }
  assert.ok(restingAt !== null, 'never reached a lounge seat');
  assert.equal(getAgentClip(m.figures.get('w'), restingAt).clip, CLIP_LOUNGE_SIT);
});
