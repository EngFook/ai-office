// V3/V4 liveliness: pure, deterministic motion curves for the instanced figures.
// Every pose is a function of (elapsed time, per-person hash), so a figure's
// animation is reproducible on any demand-frameloop tick without stored
// keyframes; only the damped head yaw keeps one number of state per person.
// These feed the 7-part instance matrices plus one shared eye batch (V4), so
// the whole crowd still costs a fixed handful of draw calls.

export const TYPING_HZ = 3 // rad/s of the arm oscillator (pre-V3 feel kept)
export const TYPING_SWING = 0.09 // rad of arm pitch while typing
export const TORSO_BOB = 0.016 // units of torso rise, synced with typing
export const BREATH_BOB = 0.008 // ever-present slow breathing
export const WALK_HZ = 9
export const ARM_SWING = 0.55
export const STEP_LIFT = 0.06
export const WALK_LEAN = 0.12 // constant forward torso pitch while walking
export const HIP_SWAY = 0.055 // rad of torso/shoulder yaw per step
export const REST_DURATION = 2.4 // s, one stretch or lean-back
export const REST_PERIOD_MIN = 12, REST_PERIOD_SPAN = 8 // every 12..19 s
export const HEAD_YAW_LIMIT = 0.6 // rad, the neck never turns further
export const HEAD_BEHIND = 2.1 // rad, a target this far around is ignored
export const HEAD_DAMP_RATE = 6 // 1/s exponential damping of the head yaw
export const GLANCE_RADIUS = 7 // world units to the figure being glanced at
export const GLANCE_DURATION = 1.6 // s per glance window

const smooth = v => v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v)

// Occasional rest events while seated: a stretch (arms up) or a lean-back,
// one per personal cycle, with smooth ease-in/out so the pose never snaps.
export function restEvent(t, h) {
  const period = REST_PERIOD_MIN + h % REST_PERIOD_SPAN
  const shifted = t + (h >>> 4) % period
  const local = shifted % period
  if (local >= REST_DURATION) return { amount: 0, kind: null }
  const kind = ((h ^ Math.imul(Math.floor(shifted / period), 2654435761)) >>> 0) % 2 ? 'stretch' : 'lean'
  return { amount: smooth(Math.min(local / 0.5, (REST_DURATION - local) / 0.6)), kind }
}

// Seated pose drivers. Typing (and its bob) fades out while a rest event is
// active; breathing never stops. Non-agents (lounge, meeting) don't type.
export function seatedMotion(t, h, typingAgent = true) {
  const rest = restEvent(t, h)
  const active = (typingAgent ? 1 : 0) * (1 - rest.amount)
  const phase = t * TYPING_HZ + h
  return {
    typing: Math.sin(phase) * TYPING_SWING * active,
    bob: Math.abs(Math.sin(phase)) * TORSO_BOB * active + Math.sin(t * 0.9 + h) * BREATH_BOB,
    stretch: rest.kind === 'stretch' ? rest.amount : 0,
    lean: rest.kind === 'lean' ? rest.amount : 0,
  }
}

// Walking pose drivers: the pre-V3 arm swing and step lift, plus a constant
// forward torso lean and a hip/shoulder yaw sway at step rate. Standing
// figures that are not walking (the report-point dwell: walking=false,
// sitting=false) hold a neutral pose instead of marching in place.
export function walkMotion(t, h, walking = true) {
  if (!walking) return { swing: 0, lift: 0, lean: 0, sway: 0 }
  const phase = t * WALK_HZ + h
  return {
    swing: Math.sin(phase) * ARM_SWING,
    lift: Math.abs(Math.sin(phase)) * STEP_LIFT,
    lean: WALK_LEAN,
    sway: Math.sin(phase) * HIP_SWAY,
  }
}

export const normalizeAngle = a => Math.atan2(Math.sin(a), Math.cos(a))

// Yaw from a figure at (x, z) facing `angle` to a world target, in the
// figure's own frame (0 = straight ahead), using the movement.js convention
// atan2(dx, dz).
export function relativeYaw(x, z, angle, targetX, targetZ) {
  return normalizeAngle(Math.atan2(targetX - x, targetZ - z) - angle)
}

// Clamp a head yaw to the neck's range; targets behind the figure (or NaN)
// fall back to looking straight ahead at the monitor / walking direction.
export function clampHeadYaw(yaw) {
  if (!Number.isFinite(yaw) || Math.abs(yaw) > HEAD_BEHIND) return 0
  return Math.max(-HEAD_YAW_LIMIT, Math.min(HEAD_YAW_LIMIT, yaw))
}

// Frame-rate-independent exponential damping toward a target angle.
export function dampAngle(current, target, dt, rate = HEAD_DAMP_RATE) {
  return current + (target - current) * (1 - Math.exp(-rate * Math.max(0, dt)))
}

// Per-figure damped head yaw keyed by id in `states`: each entry records the
// clock time of its own last update, so frames skipped by the distant-figure
// throttle contribute their elapsed time on the next update instead of being
// lost. Exponential damping composes exactly over split intervals, which
// keeps the yaw frame-rate independent under any render/throttle cadence.
export function stepHeadYaw(states, id, target, t, rate = HEAD_DAMP_RATE) {
  const prev = states.get(id)
  const yaw = prev ? dampAngle(prev.yaw, target, t - prev.t, rate) : 0
  states.set(id, { yaw, t })
  return yaw
}

// Personal glance windows: every 9..14 s the figure looks at the nearest
// neighbour for GLANCE_DURATION, then the damped yaw returns to the monitor.
export function isGlancing(t, h) {
  const period = 9 + (h >>> 2) % 6
  return (t + (h >>> 5) % period) % period < GLANCE_DURATION
}

// --- V4: blinking, meeting nods, lounge chat ---

export const BLINK_DURATION = 0.12 // s, one lid close-and-open
export const BLINK_PERIOD_MIN = 2.6, BLINK_PERIOD_SPAN = 3.2 // every 2.6..5.8 s
export const BLINK_MIN_SCALE = 0.12 // the lid never collapses to zero thickness
export const NOD_DURATION = 1.3 // s, one agreeing nod burst in a meeting
export const NOD_PERIOD_MIN = 6, NOD_PERIOD_SPAN = 7 // every 6..13 s
export const NOD_HZ = 2.1 // nod cycles per second inside a burst
export const NOD_PITCH = 0.11 // rad of extra head pitch at full nod
export const CHAT_DURATION = 3.4 // s, one lounge conversation turn
export const CHAT_PERIOD_MIN = 7, CHAT_PERIOD_SPAN = 6 // every 7..12 s
export const CHAT_NOD = 0.03 // rad of gentle talking nod while chatting

// Eye Y scale over time: 1 when open, dipping to BLINK_MIN_SCALE mid-blink on
// a triangle curve. Period and phase both come from the hash, so the crowd
// never blinks in unison.
export function blinkScale(t, h) {
  const period = BLINK_PERIOD_MIN + (h >>> 8) % 29 / 28 * BLINK_PERIOD_SPAN
  const local = (t + (h >>> 3) % 97 / 97 * period) % period
  if (local >= BLINK_DURATION) return 1
  const closed = 1 - Math.abs(2 * local / BLINK_DURATION - 1)
  return 1 - closed * (1 - BLINK_MIN_SCALE)
}

// Meeting nod: occasional eased bursts of pitch oscillation at NOD_HZ, as if
// agreeing with the speaker. Returns extra head pitch in radians (0 outside
// a burst); positive pitches the chin down, matching the seated headPitch.
// The raised-cosine curve dips once per 1/NOD_HZ (non-negative, so the chin
// only ever goes down); an abs(sin) here would double the nod frequency.
export function nodMotion(t, h) {
  const period = NOD_PERIOD_MIN + (h >>> 6) % NOD_PERIOD_SPAN
  const local = (t + (h >>> 9) % period) % period
  if (local >= NOD_DURATION) return 0
  const envelope = smooth(Math.min(local / 0.3, (NOD_DURATION - local) / 0.3, 1))
  return (1 - Math.cos(local * Math.PI * 2 * NOD_HZ)) / 2 * NOD_PITCH * envelope
}

// Lounge chat windows: like glances but longer and more frequent — resting
// figures keep turning toward a sofa neighbour as the conversation goes on.
export function isChatting(t, h) {
  const period = CHAT_PERIOD_MIN + (h >>> 7) % CHAT_PERIOD_SPAN
  return (t + (h >>> 4) % period) % period < CHAT_DURATION
}
