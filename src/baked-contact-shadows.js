import React from 'react'

// drei's <ContactShadows> keeps its frames=1 bake counter in the render body
// and lists the scale array in the deps of the useMemo that allocates both
// render targets, so any rerender that reaches it rebakes (one depth pass plus
// four blur passes) and a fresh inline scale array reallocates the targets.
// This memo boundary therefore accepts only scalar bounds and memoises the
// position/scale arrays it derives: unchanged polls and focus updates bail out
// before drei's component runs at all.
export const SHADOW_LIFT = .044, SHADOW_MARGIN = 6

export const createBakedContactShadows = Shadows => React.memo(function BakedContactShadows({ x, z, width, depth }) {
  const position = React.useMemo(() => [x, SHADOW_LIFT, z], [x, z])
  const scale = React.useMemo(() => [width + SHADOW_MARGIN, depth + SHADOW_MARGIN], [width, depth])
  return React.createElement(Shadows, { frames: 1, position, scale, far: 3, resolution: 512, blur: 1.6, opacity: .35, color: '#1d150e' })
})
