import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'

// A repeating 8 × 4 unit oak panel. Plank seams, grain and relief share the
// same coordinates, keeping this large floor to one draw call and two maps.
function oakTextures() {
  const size = 1024
  const colour = new Uint8Array(size * size * 4)
  const height = new Uint8Array(size * size * 4)
  const hash = (a, b) => {
    let n = Math.imul(a + 137, 374761393) ^ Math.imul(b + 311, 668265263)
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)))
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / (size / 8))
    const across = (y % (size / 8)) / (size / 8)
    const stagger = [0, .37, .72, .19, .56, .87, .29, .65][row]
    for (let x = 0; x < size; x++) {
      const u = x / size
      const along = (u * 2 + stagger) % 1
      const plank = Math.floor((u * 2 + stagger) % 2)
      const tint = (hash(row, plank) - .5) * 13
      const phase = row * 1.73
      const drift = .017 * Math.sin(u * Math.PI * 2 + phase)
        + .008 * Math.sin(u * Math.PI * 6 - phase)
      const grain = Math.sin((across + drift) * 109 + phase)
        + .45 * Math.sin((across + drift * .4) * 243 + phase)
      const broadGrain = Math.sin((across + drift) * 24 + phase) * 2.1
      const pores = (hash(x, y) - .5) * 2.6
      const edgeDistance = Math.min(across, 1 - across)
      const jointDistance = Math.min(along, 1 - along)
      // Narrow, soft grooves read as joinery without a high-contrast grid.
      const seam = Math.max(Math.max(0, 1 - edgeDistance / .012),
        Math.max(0, 1 - jointDistance / .0038))
      const shade = tint + grain * 1.7 + broadGrain + pores - seam * 34
      const i = (y * size + x) * 4
      colour[i] = clamp(184 + shade)
      colour[i + 1] = clamp(148 + shade * .85)
      colour[i + 2] = clamp(108 + shade * .66)
      colour[i + 3] = 255
      const relief = clamp(146 + grain * 2 + pores - seam * 67)
      height[i] = height[i + 1] = height[i + 2] = relief
      height[i + 3] = 255
    }
  }
  const makeTexture = (data, srgb = false) => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.generateMipmaps = true
    texture.anisotropy = 4
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    return texture
  }
  return { colour: makeTexture(colour, true), height: makeTexture(height) }
}

export default function WoodFloor({ bounds }) {
  const textures = useMemo(oakTextures, [])
  useLayoutEffect(() => {
    for (const texture of Object.values(textures)) {
      texture.repeat.set((bounds.width - .12) / 8, (bounds.depth - .12) / 4)
    }
  }, [textures, bounds.width, bounds.depth])
  useEffect(() => () => {
    for (const texture of Object.values(textures)) texture.dispose()
  }, [textures])
  return <group>
    <mesh position={[bounds.x, .017, bounds.z]} receiveShadow>
      <boxGeometry args={[bounds.width - .12, .045, bounds.depth - .12]}/>
      <meshStandardMaterial color="#947554" roughness={.75}/>
    </mesh>
    <mesh position={[bounds.x, .041, bounds.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[bounds.width - .12, bounds.depth - .12]}/>
      <meshStandardMaterial map={textures.colour} bumpMap={textures.height}
        bumpScale={.022} roughness={.67} metalness={0}/>
    </mesh>
  </group>
}
