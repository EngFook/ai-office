import React, { useEffect, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'

const labelLayers = new WeakMap()
const overlaps = (a, b) => a.left < b.right + 7 && a.right > b.left - 7 && a.top < b.bottom + 7 && a.bottom > b.top - 7

// Lay out the entire layer once per frame, so live worker labels can avoid
// room signs and one another without hiding any worker from the scene.
function positionLabels(layer, { camera, size, clock }) {
  if (layer.frame === clock.elapsedTime) return
  layer.frame = clock.elapsedTime
  const occupied = []
  const labels = [...layer.labels].sort((a, b) => Number(a.avoidCollisions) - Number(b.avoidCollisions) || b.priority - a.priority)
  for (const label of labels) {
    const { element, point, group } = label
    if (!group.current) continue
    group.current.getWorldPosition(point).project(camera)
    const shown = label.visible && point.z >= -1 && point.z <= 1 && Math.abs(point.x) < 1.2 && Math.abs(point.y) < 1.2
    element.style.display = shown ? 'block' : 'none'
    if (!shown) continue
    const anchorX = (point.x + 1) * size.width / 2, anchorY = (1 - point.y) * size.height / 2
    const width = element.offsetWidth || 170, height = element.offsetHeight || 45
    let x = anchorX, y = anchorY
    const rectAt = (cx, cy) => ({ left: cx - width / 2, right: cx + width / 2, top: cy - height / 2, bottom: cy + height / 2 })
    if (label.avoidCollisions) {
      const clampX = value => Math.max(width / 2 + 8, Math.min(size.width - width / 2 - 8, value))
      const clampY = value => Math.max(height / 2 + 60, Math.min(size.height - height / 2 - 64, value))
      const candidates = [[0, 0]]
      for (let row = 1; row <= Math.ceil(size.height / (height + 8)); row++) {
        candidates.push([0, -row * (height + 8)], [0, row * (height + 8)])
        for (const direction of [-1, 1]) candidates.push([direction * (width + 10), -(row - 1) * (height + 8)], [direction * (width + 10), (row - 1) * (height + 8)])
      }
      let best = null
      for (const [dx, dy] of candidates) {
        const cx = clampX(anchorX + dx), cy = clampY(anchorY + dy), rect = rectAt(cx, cy)
        const collisions = occupied.filter(other => overlaps(rect, other)).length
        if (!best || collisions < best.collisions) best = { x: cx, y: cy, collisions }
        if (!collisions) break
      }
      x = best.x
      y = best.y
    }
    const dx = anchorX - x, dy = anchorY - y, displacement = Math.hypot(dx, dy)
    element.className = label.avoidCollisions && displacement > 15 ? 'scene-label--leader' : ''
    element.style.setProperty('--leader-length', `${displacement}px`)
    element.style.setProperty('--leader-angle', `${Math.atan2(dy, dx)}rad`)
    element.style.transform = `translate3d(${x}px,${y}px,0)`
    element.style.zIndex = String(label.zIndexRange[0] + label.priority)
    occupied.push(rectAt(x, y))
  }
}

// Project a small DOM label over the scene. Defer DOM-root disposal so React
// never unmounts a second root during the Three renderer's commit.
export default function SceneLabel({ position, children, style = {}, visible = true, zIndexRange = [20,0], avoidCollisions = false, priority = 0 }) {
  const group = useRef(), root = useRef(), layerRef = useRef()
  const { gl } = useThree()
  const element = useMemo(()=>document.createElement('div'),[])
  const point = useMemo(()=>new Vector3(),[])
  const label = useMemo(()=>({element, point, group}),[element,point])
  Object.assign(label, { visible, zIndexRange, avoidCollisions, priority })
  useEffect(()=>{
    element.style.cssText='position:absolute;top:0;left:0;pointer-events:none;'
    const parent = gl.domElement.parentElement
    parent.appendChild(element)
    let layer = labelLayers.get(parent)
    if (!layer) {
      layer = { labels: new Set(), frame: null }
      labelLayers.set(parent, layer)
    }
    layer.labels.add(label)
    layerRef.current = layer
    const labelRoot=createRoot(element)
    root.current=labelRoot
    return ()=>{
      layer.labels.delete(label)
      layerRef.current=null
      element.remove()
      root.current=null
      queueMicrotask(()=>labelRoot.unmount())
    }
  },[element,gl,label])
  useEffect(()=>{
    root.current?.render(<div style={{transform:'translate(-50%,-50%)',...style}}>{children}</div>)
  },[children,style])
  useFrame(state=>{
    if (layerRef.current) positionLabels(layerRef.current,state)
  })
  return <group ref={group} position={position}/>
}
