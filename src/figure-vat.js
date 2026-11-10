// V8a prototype (feature flag, default OFF): every figure is one Quaternius
// CC0 rigged character (assets/quaternius/README.md), drawn as a single
// InstancedMesh whose vertices are animated by a vertex-animation texture
// (VAT) baked at load time in src/figure-vat-bake.js. This module holds the
// pure, render-free logic: the feature flag, the clip plan and texture
// layout, per-figure clip selection and the per-frame row lookup.

export const FIGURE_GLB_URL = '/figure-v8a.glb'

// The character is chibi-proportioned, 3.37 model units tall without the
// dropped ears; FIGURE_HEIGHT matches the primitive figures' ~2.3 world
// units so the crowd scale stays the same under either renderer.
export const FIGURE_HEIGHT = 2.3
// World Y of the pelvis in the two seated clips: a compromise over the desk
// chair (0.66), sofa cushion (0.71) and meeting chair (0.81) seat tops.
export const SEAT_PELVIS_Y = 0.72
// Bunny ears are not office attire; dropping the mesh also saves 240 tris.
export const DROPPED_MESHES = new Set(['Ears'])
// Vertices of these materials are re-dyed with the per-instance team colour
// (the V2 shirt rule); all other materials keep their baked flat colour.
export const TINTED_MATERIALS = new Set(['Main'])

export const VAT_FPS = 15

// walk/idle come from the GLB's embedded Quaternius clips; the two seated
// clips are posed procedurally on the same rig during the bake (the pack has
// no sitting animation). Durations of sourced clips are read from the GLB at
// bake time; the values here are the layout defaults and the test fixture.
export const FIGURE_CLIPS = [
  { id: 'idle', source: 'CharacterArmature|Idle', duration: 2.08 },
  { id: 'walk', source: 'CharacterArmature|Walk', duration: 1.25 },
  { id: 'sitTyping', duration: 2.0 },
  { id: 'sitLounge', duration: 3.2 },
]

// --- Feature flag -----------------------------------------------------------
// URL ?figures=v8a wins (any other value forces the flag off for the visit);
// otherwise localStorage "office.figuresV8a" = "1" keeps it on.
export const FIGURE_FLAG_PARAM = 'figures'
export const FIGURE_FLAG_VALUE = 'v8a'
export const FIGURE_FLAG_KEY = 'office.figuresV8a'

export function figuresV8aEnabled({ search = '', storage = null } = {}) {
  let param = null
  try { param = new URLSearchParams(search).get(FIGURE_FLAG_PARAM) } catch { /* malformed search */ }
  if (param !== null) return param === FIGURE_FLAG_VALUE
  try { return storage?.getItem(FIGURE_FLAG_KEY) === '1' } catch { return false }
}

// --- VAT layout --------------------------------------------------------------
// One texture row per baked frame. Every clip stores frames+1 rows: the extra
// row repeats frame 0, so the shader can always lerp row f -> f+1 without
// bleeding into the next clip at the loop seam.
export function vatLayout(clips = FIGURE_CLIPS, fps = VAT_FPS) {
  let row = 0
  return clips.map(clip => {
    const frames = Math.max(2, Math.round(clip.duration * fps))
    const range = { id: clip.id, source: clip.source || null, duration: clip.duration, start: row, frames }
    row += frames + 1
    return range
  })
}

export const vatRows = layout => {
  const last = layout[layout.length - 1]
  return last.start + last.frames + 1
}

// --- Per-figure clip & frame -------------------------------------------------
// Keeps the existing movement semantics: desk work types, every other seat
// (lounge sofa, meeting chair) rests; the report-point dwell stands idle.
export function clipIdForFigure(figure) {
  if (figure.sitting) return figure.spot?.kind === 'desk' ? 'sitTyping' : 'sitLounge'
  return figure.walking ? 'walk' : 'idle'
}

// Fractional texture row for a clip at elapsed time t. The per-person hash
// offsets the phase so the crowd never types or steps in unison. The result
// is always inside [start, start + frames), so row floor(f)+1 (the wrap row
// at the end of the clip) is a valid lerp partner.
export function vatFrameFor(range, t, h = 0, fps = VAT_FPS) {
  const phase = (t * fps + h % 61) % range.frames
  return range.start + phase
}
