// V7: Mac-only post-processing — EffectComposer + N8AO (half-resolution
// ambient occlusion) + a subtle Bloom. The pass chain mounts only when the
// active quality tier carries the `postprocessing` flag, which exists solely
// on the top desktop tier: phones start one tier down and can never climb
// above their starting ceiling (see scene-quality.js), so they never pay a
// single composer pass. Licenses: @react-three/postprocessing MIT, n8ao ISC,
// postprocessing Zlib — all free, no paid assets, no keys.

export function postEffectsEnabled(tier = {}) {
  return tier.postprocessing === true
}

// N8AO works with the orthographic camera (depth-reconstructed positions) and
// the instanced furniture. World-space radius sized to the furniture scale
// (desks span ~2 units, people ~1.9): big enough to ground objects, small
// enough not to dim whole rooms. `halfRes` per the approved spec plus the
// 'performance' preset keep the pass cheap on integrated Apple GPUs.
export const AO_SETTINGS = {
  halfRes: true,
  depthAwareUpsampling: true,
  quality: 'performance',
  aoRadius: 1.8,
  distanceFalloff: 1,
  intensity: 2.2,
  color: '#120d08', // warm-dark occlusion to match the office palette
}

// Subtle bloom for the bright end only: sunlit highlights, the emissive lamp
// shades and glowing work screens. The threshold sits just under diffuse
// white so ordinary surfaces stay untouched; smoothing feathers the cutoff.
export const BLOOM_SETTINGS = {
  mipmapBlur: true,
  intensity: 0.36,
  luminanceThreshold: 0.9,
  luminanceSmoothing: 0.25,
}

// While the composer is mounted it bypasses the canvas MSAA and forces the
// renderer to NoToneMapping, so the chain supplies both again: 4x multisample
// render targets for edges, and a final AgX tone-mapping effect so the graded
// look matches the composer-less (phone) path exactly.
export const COMPOSER_MULTISAMPLING = 4

// N8AOPostPass builds its passes as fullscreen-triangle quads that hold their
// ShaderMaterial one level down (quad._mesh.material). The inherited
// postprocessing Pass.dispose() only scans top-level properties, so none of
// these six materials ever fire their 'dispose' event, and three's shader
// cache keeps them (and their uniforms) alive. On an adaptive-quality
// downgrade (high → balanced) the chain unmounts and each recovery remounts a
// fresh pass, leaking another set per round. depthDownsampleQuad exists only
// while halfRes is on and depthCopyPass only when the scene has transparent
// materials (our glass/steam always trigger it); both may be null.
export const N8AO_NESTED_QUAD_KEYS = Object.freeze([
  'effectShaderQuad',
  'effectCompositerQuad',
  'copyQuad',
  'accumulationQuad',
  'depthDownsampleQuad',
  'depthCopyPass',
])

// Dispose only the nested materials — never the quads' own dispose(), which
// would also dispose the fullscreen geometry n8ao shares across every quad.
// Top-level resources (render targets, standardDenoiseMaterial, textures) are
// already covered by Pass.dispose(), so this stays strictly complementary.
// Returns how many materials it released, so tests can assert coverage.
export function disposeN8AONestedMaterials(pass) {
  if (!pass) return 0
  let disposed = 0
  for (const key of N8AO_NESTED_QUAD_KEYS) {
    const material = pass[key]?.material
    if (material && typeof material.dispose === 'function') {
      material.dispose()
      disposed += 1
    }
  }
  return disposed
}
