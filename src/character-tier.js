// V8b: the pure decision of whether to render the rigged Quaternius
// characters (V8a) or keep the primitive instanced figures. Reuses the V5
// quality-tier ids read-only; the fallback must stay cheap and certain, so
// every ambiguous input resolves to the primitives.

import { QUALITY_TIERS } from './scene-quality.js'

// The rigged flag defaults ON for V8b; `?rigged=0` (or off/false/no) in the
// URL forces the primitive figures for A/B checks without a rebuild.
export const RIGGED_FLAG_DEFAULT = true
export const RIGGED_MIN_FPS = 50
export const RIGGED_FPS_SUSTAIN_MS = 4000

// Tiers that may carry skinned meshes: the top desktop tier and the phone
// starting tier. The 'low' tier (where phones land when struggling, and the
// recovery floor of every device) always falls back to primitives.
export const RIGGED_TIER_IDS = QUALITY_TIERS.filter(tier => tier.id !== 'low').map(tier => tier.id)

export function parseRiggedFlag(search = '') {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('rigged')
  if (value === null) return RIGGED_FLAG_DEFAULT
  return !['0', 'off', 'false', 'no'].includes(value.toLowerCase())
}

export function detectRiggedFlag() {
  if (typeof window === 'undefined') return RIGGED_FLAG_DEFAULT
  return parseRiggedFlag(window.location.search)
}

// useRiggedCharacters({qualityTier, flag, loadError, fps}) -> boolean.
// `qualityTier` is a V5 tier id or tier object; `flag` defaults ON;
// `loadError` is any asset-load failure reported by the rigged renderer;
// `fps` is a *sustained* frame-rate estimate (see createFpsGate below) -
// pass Infinity / omit it while no trustworthy measurement exists.
export function useRiggedCharacters({ qualityTier, flag = RIGGED_FLAG_DEFAULT, loadError = false, fps = Infinity } = {}) {
  if (flag === false || loadError) return false
  const tierId = typeof qualityTier === 'string' ? qualityTier : qualityTier?.id
  if (!RIGGED_TIER_IDS.includes(tierId)) return false
  if (Number.isFinite(fps) && fps < RIGGED_MIN_FPS) return false
  return true
}

// The scene runs a demand frameloop that idles at motionHz ticks (24/16 Hz),
// so a frame delta at or below that cadence says nothing about render speed -
// it is usually the scheduler, not the GPU. Only burst frames (continuous
// invalidation: camera gestures, flights) measure real frame rate, so only
// deltas clearly faster than the ambient tick are valid fps samples. A
// machine too slow to ever burst past the tick rate is caught by the V5
// PerformanceMonitor instead, which degrades the tier to 'low' and thereby
// also switches the characters to primitives.
export function fpsSample(deltaSeconds, motionHz) {
  if (!(deltaSeconds > 0)) return null
  const fps = 1 / deltaSeconds
  if (Number.isFinite(motionHz) && fps <= motionHz * 1.1) return null
  return fps
}

// Sustained-low-fps gate: trips only after `sustainMs` of uninterrupted
// samples under `threshold`, and latches once tripped - flipping back and
// forth would re-upload skinned meshes on every recovery, the worst of both
// worlds. `now` is on the caller's clock (ms), same as the samples' spacing.
export function createFpsGate({ threshold = RIGGED_MIN_FPS, sustainMs = RIGGED_FPS_SUSTAIN_MS } = {}) {
  let lowSince = null, tripped = false
  return {
    sample(fps, now) {
      if (tripped) return true
      if (!(fps < threshold)) { lowSince = null; return false }
      if (lowSince === null) lowSince = now
      if (now - lowSince >= sustainMs) tripped = true
      return tripped
    },
    get tripped() { return tripped },
  }
}
