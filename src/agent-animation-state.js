// V8b: pure mapping from a movement.js figure (the existing behaviour state:
// walking / idle standing / working at a desk / lounge sitting / meeting) to
// the rigged character clip set V8a ships with the Quaternius model. The
// renderer (RiggedAgents.jsx) calls getAgentClip(figure, now) once per figure
// per frame and drives its AnimationMixer from the result; nothing here keeps
// state, so the mapping is reproducible on any demand-frameloop tick.

export const CLIP_WALK = 'walk'
export const CLIP_IDLE = 'idle'
export const CLIP_SIT_TYPING = 'sitTyping'
export const CLIP_LOUNGE_SIT = 'loungeSit'
export const CLIP_NAMES = [CLIP_WALK, CLIP_IDLE, CLIP_SIT_TYPING, CLIP_LOUNGE_SIT]

// Crossfade durations per *incoming* clip, in ms. Walking starts quickly so a
// figure leaving its chair never slides while still seated; settling into a
// chair is slower and the sofa slouch slowest, matching the unhurried lounge.
export const CLIP_FADE_MS = {
  [CLIP_WALK]: 160,
  [CLIP_IDLE]: 220,
  [CLIP_SIT_TYPING]: 300,
  [CLIP_LOUNGE_SIT]: 380,
}

// Which clip a figure's behaviour state calls for. Spot kinds come from
// movement.js: desk/review/research are workstations, meeting and lounge are
// seated non-typing spots, report is the standing dwell. A seated figure
// without an agent (e.g. a meeting representative briefly parked on a chair)
// never types - same rule as seatedMotion(t, h, !!f.agent) in person-motion.
export function clipForFigure(figure) {
  if (!figure) return CLIP_IDLE
  if (figure.walking) return CLIP_WALK
  if (figure.sitting) {
    const kind = figure.spot?.kind
    if (kind === 'lounge' || kind === 'meeting') return CLIP_LOUNGE_SIT
    return figure.agent ? CLIP_SIT_TYPING : CLIP_LOUNGE_SIT
  }
  return CLIP_IDLE
}

// When the current clip began, on the movement clock (performance.now() ms):
// a walk starts at walk.start, everything else at the arrival timestamp the
// movement system records. 0 / missing means "always been here" (initial
// placement), which getAgentClip treats as fully faded in.
export function clipStartedAt(figure) {
  if (figure?.walking) return figure.walk?.start ?? 0
  return figure?.arrivedAt ?? 0
}

const clamp01 = value => value <= 0 ? 0 : value >= 1 ? 1 : value

// The stable V8a/V8b interface: {clip, weight, fadeMs}. `weight` is the
// incoming clip's crossfade ramp (0 -> 1 over fadeMs after the state change);
// the mixer plays the previous clip at 1 - weight, so poses never snap. `now`
// must be on the same clock the movement system was stepped with.
export function getAgentClip(figure, now) {
  const clip = clipForFigure(figure)
  const fadeMs = CLIP_FADE_MS[clip]
  const since = clipStartedAt(figure)
  const weight = !Number.isFinite(since) || since <= 0 || !Number.isFinite(now)
    ? 1
    : clamp01((now - since) / fadeMs)
  return { clip, weight, fadeMs }
}
