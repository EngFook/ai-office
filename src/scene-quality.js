// Rendering quality knobs for the office scene (V1: lighting & tone).
// Environment map: Poly Haven "Lebombo" (CC0), downscaled to 256x128 Radiance HDR.
export const SCENE_ENV_URL = '/office-env-256.hdr'
export const SCENE_ENV_INTENSITY = 0.5

// Sun placement, as a multiple of the office span; the shadow frustum below is
// derived from the same offset, so keep the two together.
export const SUN_OFFSET = { x: -0.44, y: 0.7, z: -0.6 }

// Orthographic shadow-camera half-extents that just cover the office footprint
// (plus walls up to `ceiling`) when viewed along the sun direction. The floor
// rectangle is projected onto the shadow camera's right/up axes, so no texels
// are spent outside the building.
export function shadowFrustum(bounds, { margin = 4, ceiling = 6 } = {}) {
  const length = Math.hypot(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z)
  const dir = { x: -SUN_OFFSET.x / length, y: -SUN_OFFSET.y / length, z: -SUN_OFFSET.z / length }
  const flat = Math.hypot(dir.x, dir.z)
  const right = { x: dir.z / flat, z: -dir.x / flat }
  const up = { x: -dir.y * dir.x / flat, y: flat, z: -dir.y * dir.z / flat }
  const halfWidth = bounds.width / 2, halfDepth = bounds.depth / 2
  return {
    x: Math.abs(right.x) * halfWidth + Math.abs(right.z) * halfDepth + margin,
    y: Math.abs(up.x) * halfWidth + Math.abs(up.z) * halfDepth + Math.abs(up.y) * ceiling + margin,
  }
}

// Phones are recognised by a coarse pointer or a narrow screen; the same
// predicate picks the shadow-map size and the starting quality tier.
export function isHandheld({ coarsePointer = false, width = Infinity } = {}) {
  return coarsePointer || width < 700
}

// Phones keep the former 1024 shadow map; desktops get 2048 now that the
// frustum is tight. Decided once at mount: resizing a live shadow map would
// force a texture re-allocation.
export function shadowMapSize(device = {}) {
  return isHandheld(device) ? 1024 : 2048
}

function detectDevice() {
  if (typeof window === 'undefined') return null
  return {
    coarsePointer: window.matchMedia?.('(pointer: coarse)')?.matches === true,
    width: window.innerWidth,
  }
}

export function detectShadowMapSize() {
  const device = detectDevice()
  return device ? shadowMapSize(device) : 1024
}

// V5: adaptive quality tiers, ordered best-first and stepped at runtime by
// drei's <PerformanceMonitor>. `dpr` is a cap (never above the real device
// pixel ratio); `motionHz` is the ambient invalidation rate of the demand
// frameloop; `distantHz` throttles matrix updates of figures near or past the
// screen edge (Infinity = every frame); `postprocessing` gates the Mac-only
// effect pass (V7) and stays off on every phone tier; `steam` gates the V6
// coffee-machine steam, likewise reserved for the top (desktop) tier.
export const QUALITY_TIERS = [
  { id: 'high', dpr: 2, motionHz: 24, distantHz: Infinity, postprocessing: true, steam: true },
  { id: 'balanced', dpr: 1.25, motionHz: 24, distantHz: 30, postprocessing: false, steam: false },
  { id: 'low', dpr: 1, motionHz: 16, distantHz: 12, postprocessing: false, steam: false },
]

export function qualityTier(id) {
  return QUALITY_TIERS.find(tier => tier.id === id) || QUALITY_TIERS[QUALITY_TIERS.length - 1]
}

// Phones start one tier down and can never climb above it; desktops start at
// the top. The starting tier is also the recovery ceiling.
export function initialTierId(device = {}) {
  return isHandheld(device) ? 'balanced' : 'high'
}

export function detectInitialTierId() {
  const device = detectDevice()
  return device ? initialTierId(device) : 'balanced'
}

const tierIndex = id => QUALITY_TIERS.findIndex(tier => tier.id === id)

export function degradedTierId(id) {
  return QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, tierIndex(id) + 1)].id
}

export function improvedTierId(id, ceilingId) {
  return QUALITY_TIERS[Math.max(0, tierIndex(ceilingId), tierIndex(id) - 1)].id
}

// Resolution never exceeds what the panel can show (dpr 2 cap on a 1x screen
// would waste nothing, but a 1.25 cap on a 3x phone saves most of the fill).
export function tierDpr(tier, devicePixelRatio = 1) {
  return Math.min(tier.dpr, Math.max(1, devicePixelRatio))
}

// The demand frameloop idles at `motionHz`, so "full speed" is the tick rate
// itself, not the display refresh: inside the band is healthy, a sustained
// drop below ~80% degrades, and only gesture-driven bursts above the band
// (OrbitControls renders at display refresh) climb back toward the ceiling.
export function monitorBounds(motionHz) {
  return [Math.round(motionHz * 0.8), Math.round(motionHz * 1.2)]
}
