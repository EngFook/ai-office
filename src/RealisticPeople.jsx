// V8a prototype renderer (feature flag, default OFF — see figure-vat.js):
// replaces the 7-batch primitive crowd of People with one skinned Quaternius
// character per figure, all drawn by a single VAT InstancedMesh (plus the
// shared blob-shadow batch), so the whole crowd costs 2 draw calls. Movement,
// walking routes, meeting attendance, arrival reporting and click-to-select
// are byte-for-byte the same semantics as People; only the rendering differs.
// Loaded lazily from OfficeScene so the GLB and this chunk never download
// while the flag is off.
import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useSceneQuality } from './OfficeScene'
import { createMovement } from './movement'
import { residentFigures } from './office-resident-layout.js'
import { sharedSeatForAgent, OFFICE_PROVIDERS } from './shared-layout'
import { personAppearance, shadowHeightFor, hashIndex } from './person-appearance'
import { FIGURE_GLB_URL, clipIdForFigure, vatFrameFor } from './figure-vat'
import { bakeFigureVat, patchFigureMaterial } from './figure-vat-bake'

const PEOPLE_CAP = 160

function makeBlobTexture() {
  const size = 64, canvas = document.createElement('canvas'); canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(0,0,0,.5)'); gradient.addColorStop(.55, 'rgba(0,0,0,.3)'); gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

export default function RealisticPeople({ layout, meeting, huddle, onArrived, onSelectAgent, onSelectProvider, residents = [], ambient = true }) {
  const gltf = useGLTF(FIGURE_GLB_URL)
  const baked = useMemo(() => bakeFigureVat(gltf), [gltf])
  const { material, depthMaterial } = useMemo(() => ({
    material: patchFigureMaterial(new THREE.MeshStandardMaterial({ roughness: .85, vertexColors: true, flatShading: true }), baked.texture),
    depthMaterial: patchFigureMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), baked.texture),
  }), [baked])
  // Per-instance fractional VAT row, rewritten every animation frame. An
  // InstancedBufferAttribute on the shared geometry is honoured (divisor 1)
  // because the object drawing it is an InstancedMesh.
  const frames = useMemo(() => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(PEOPLE_CAP), 1)
    attribute.setUsage(THREE.DynamicDrawUsage)
    baked.geometry.setAttribute('aVatFrame', attribute)
    return attribute
  }, [baked])
  useEffect(() => () => { baked.texture.dispose(); baked.geometry.dispose(); material.dispose(); depthMaterial.dispose() }, [baked, material, depthMaterial])

  const movement = useMemo(() => createMovement({ lounge: layout.lounge, commons: layout.commons }), [])
  const first = useRef(true), figuresRef = useRef([]), arrivedKey = useRef('')
  const meshRef = useRef(), blobRef = useRef(), blobTexture = useMemo(makeBlobTexture, [])
  const dummy = useMemo(() => new THREE.Object3D(), []), color = useMemo(() => new THREE.Color(), [])
  const { distantHz } = useSceneQuality()
  const distantGate = useRef(0), projected = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const working = layout.agents.map(agent => { const desk = sharedSeatForAgent(agent, layout); return desk && { id: agent.id, agent, provider: ({ 'Claude Code': 'claude', Codex: 'codex', Grok: 'grok', Gemini: 'gemini', 'Local Qwen': 'local-qwen' })[agent.provider] || desk.provider, desk } }).filter(Boolean)
    figuresRef.current = [...residentFigures(residents), ...movement.sync({ working, meeting, huddle, ambient, now: performance.now(), initial: first.current })]
    first.current = false
  }, [layout, meeting, huddle, movement, ambient, residents])

  useFrame(({ clock, camera }) => {
    const now = performance.now(), figures = [...residentFigures(residents), ...movement.step(now)]
    figuresRef.current = figures
    const arrived = figures.filter(f => f.agent && !f.walking && !f.queue.length && f.spot?.id?.startsWith('desk:')).map(f => f.id).sort().join('|')
    if (arrived !== arrivedKey.current) { arrivedKey.current = arrived; onArrived?.(new Set(arrived ? arrived.split('|') : [])) }
    let skipDistant = false
    if (Number.isFinite(distantHz)) {
      if (now - distantGate.current >= 1000 / distantHz) distantGate.current = now
      else skipDistant = true
    }
    const t = clock.elapsedTime
    figures.slice(0, PEOPLE_CAP).forEach((f, i) => {
      if (skipDistant) {
        projected.set(f.x, 1.2, f.z).project(camera)
        if (Math.abs(projected.x) > .72 || Math.abs(projected.y) > .72) return
      }
      const h = hashIndex(f.id), provider = OFFICE_PROVIDERS[f.provider] || OFFICE_PROVIDERS.grok
      const look = personAppearance(f.id, provider.color)
      const s = look.height * baked.scale
      dummy.position.set(f.x, 0, f.z)
      dummy.rotation.set(0, f.angle, 0); dummy.scale.setScalar(s); dummy.updateMatrix()
      meshRef.current?.setMatrixAt(i, dummy.matrix)
      meshRef.current?.setColorAt(i, color.set(look.shirt))
      frames.setX(i, vatFrameFor(baked.layout[clipIdForFigure(f)], t, h))
      dummy.position.set(f.x, shadowHeightFor(f), f.z)
      dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.setScalar(look.height); dummy.updateMatrix()
      blobRef.current?.setMatrixAt(i, dummy.matrix)
    })
    const count = Math.min(PEOPLE_CAP, figures.length)
    frames.needsUpdate = true
    for (const ref of [meshRef, blobRef]) {
      if (!ref.current) continue
      ref.current.count = count
      ref.current.instanceMatrix.needsUpdate = true
      if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
    }
  })

  const click = event => { event.stopPropagation(); const f = figuresRef.current[event.instanceId]; if (f?.resident) onSelectProvider?.(f.resident.provider); else if (f?.agent) onSelectAgent?.(f.agent) }
  return <group>
    <instancedMesh ref={meshRef} args={[baked.geometry, material, PEOPLE_CAP]} frustumCulled={false} castShadow
      customDepthMaterial={depthMaterial} onClick={click}/>
    {/* Soft blob shadow under every figure, same batch as the default renderer. */}
    <instancedMesh ref={blobRef} args={[null, null, PEOPLE_CAP]} frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[.95, .95]}/>
      <meshBasicMaterial map={blobTexture} transparent depthWrite={false} toneMapped={false} color="#000000"/>
    </instancedMesh>
  </group>
}

useGLTF.preload(FIGURE_GLB_URL)
