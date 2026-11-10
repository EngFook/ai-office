import React, { useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import RiggedAgents from './RiggedAgents.jsx'
// Deliberate module cycle with OfficeScene.jsx (which mounts this component):
// useSceneQuality is only dereferenced at render time, long after both
// modules finished evaluating, so the live ESM binding resolves fine.
import { useSceneQuality } from './OfficeScene.jsx'
import { getAgentClip } from './agent-animation-state.js'
import { useRiggedCharacters, detectRiggedFlag, createFpsGate, fpsSample } from './character-tier.js'

// V8b: chooses between the rigged characters (V8a's RiggedAgents) and the
// existing primitive figures, per character-tier.js. All degrade paths end at
// the primitives: flag off, low tier (incl. mid-session V5 downgrades, which
// re-render this component via the quality context), a character-asset load
// failure, or sustained sub-50fps bursts. The decision is pure; this wrapper
// only wires the live inputs.
export default function CharacterSwitch({ layout, meeting = null, huddle = null, onArrived, onSelect, fallback = null }) {
  const tier = useSceneQuality()
  const flag = useMemo(detectRiggedFlag, [])
  const [loadError, setLoadError] = useState(false)
  const [fpsLow, setFpsLow] = useState(false)
  const gate = useMemo(createFpsGate, [])
  useFrame((_, delta) => {
    if (fpsLow) return
    const fps = fpsSample(delta, tier.motionHz)
    if (fps !== null && gate.sample(fps, performance.now())) setFpsLow(true)
  })
  const rigged = useRiggedCharacters({ qualityTier: tier.id, flag, loadError, fps: fpsLow ? 0 : Infinity })
  if (!rigged) return fallback
  return <RiggedAgents
    agents={{ layout, meeting, huddle, onArrived }}
    getAgentClip={getAgentClip}
    onSelect={onSelect}
    onLoadError={() => setLoadError(true)}
    fallback={fallback}/>
}
