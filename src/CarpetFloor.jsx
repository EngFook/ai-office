import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'

// A seamless, small woven tile: shared colour and height data give the white
// carpet a soft pile without thousands of strands or an external asset fetch.
function carpetTexture() {
  const size = 256, data = new Uint8Array(size * size * 4)
  let state = 731
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const weave = Math.sin(x * Math.PI / 2) * 3 + Math.cos(y * Math.PI / 4) * 2
    const pile = 230 + random() * 23 + weave
    const i = (y * size + x) * 4
    data[i] = data[i + 1] = data[i + 2] = Math.min(255, pile)
    data[i + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

export default function CarpetFloor({ bounds }) {
  const texture = useMemo(carpetTexture, [])
  useLayoutEffect(() => { texture.repeat.set(bounds.width / 3, bounds.depth / 3) }, [texture, bounds.width, bounds.depth])
  useEffect(() => () => texture.dispose(), [texture])
  return <group>
    <mesh position={[bounds.x, .017, bounds.z]} receiveShadow>
      <boxGeometry args={[bounds.width - .12, .045, bounds.depth - .12]}/>
      <meshStandardMaterial color="#e7e5df" roughness={1} metalness={0}/>
    </mesh>
    <mesh position={[bounds.x, .041, bounds.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[bounds.width - .12, bounds.depth - .12]}/>
      <meshStandardMaterial color="#ffffff" map={texture} bumpMap={texture} bumpScale={.035} roughness={1} metalness={0} emissive="#f4f3ef" emissiveIntensity={.12}/>
    </mesh>
  </group>
}
