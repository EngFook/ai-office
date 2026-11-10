import React, { Suspense, createContext, lazy, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls, PerformanceMonitor } from '@react-three/drei'
import SceneLabel from './SceneLabel'
import { SCENE_ENV_URL, SCENE_ENV_INTENSITY, SUN_OFFSET, shadowFrustum, detectShadowMapSize, qualityTier, detectInitialTierId, degradedTierId, improvedTierId, tierDpr, monitorBounds } from './scene-quality'
import { postEffectsEnabled } from './scene-postprocessing'
import { codexWorkerIdentity } from './codex-office'
import { claudeWorkerIdentity } from './claude-office'
import { createMovement } from './movement'
import { createSharedLayout, sharedSeatForAgent, sharedFocusArea, OFFICE_PROVIDERS, WORKSTATION_GEOMETRY } from './shared-layout'
import { officeAgentLabel, officeRoleLabel } from './unified-office'
import { t } from './i18n'
import { personAppearance, shadowHeightFor, hashIndex } from './person-appearance'
import { seatedMotion, walkMotion, isGlancing, clampHeadYaw, relativeYaw, stepHeadYaw, GLANCE_RADIUS, blinkScale, nodMotion, isChatting, CHAT_NOD } from './person-motion'
import { createBakedContactShadows } from './baked-contact-shadows'
import { figuresV8aEnabled } from './figure-vat'
import { PROP_PALETTE } from './desk-prop-data'
import { propPlacements, buildPropGeometry, propPickHandler, CODE_W, CODE_H, CODE_LINE, CODE_BG, drawCodeLine, shouldStepCode, steamParticle, STEAM_COUNT } from './desk-props'
import CharacterSwitch from './CharacterSwitch.jsx'
import WoodFloor from './WoodFloor.jsx'
import { StudioEnvelope, ZonePlatforms, StudioDataScreen, StudioSoftFurnishings } from './StudioDesign.jsx'
import CentralSocial from './CentralSocial.jsx'
import { residentFigures } from './office-resident-layout.js'
import ResidentLabels from './ResidentLabels.jsx'
import OptionalSceneEffects from './OptionalSceneEffects.jsx'
import './studio-beauty.css'

const BakedContactShadows = createBakedContactShadows(ContactShadows)

const WOOD = '#634536', BRASS = '#b99a64', INK = '#272525'
const { chairOffsetZ, monitorZ, screenZ } = WORKSTATION_GEOMETRY
const workingRuntimeFor = agent => agent.runtimeAgents.find(worker => worker.status === 'working' && worker.observed !== false)
const identityFor = agent => agent.provider === 'Codex' ? codexWorkerIdentity(workingRuntimeFor(agent)) : claudeWorkerIdentity(workingRuntimeFor(agent))
const providerKeyFor = value => ({ 'Claude Code': 'claude', Codex: 'codex', Grok: 'grok', Gemini: 'gemini', 'Local Qwen': 'local-qwen' })[value] || (OFFICE_PROVIDERS[value] ? value : null)
const providerFor = item => OFFICE_PROVIDERS[providerKeyFor(item.provider) || providerKeyFor(item.officeZone) || providerKeyFor(item.zone)] || OFFICE_PROVIDERS.grok
const box = (x,y,z,w,h,d,color,angle=0) => ({x,y,z,w,h,d,color,angle})
const localBox = (seat, item) => ({...item, x:seat.x+item.x*Math.cos(seat.angle)+item.z*Math.sin(seat.angle), z:seat.z-item.x*Math.sin(seat.angle)+item.z*Math.cos(seat.angle), angle:seat.angle, seat})

// One geometry and draw call per batch, including all desk and chair details.
function Boxes({ items, onClick, unlit = false, shadows = true, opacity = 1, map = null, glow = 1, rounded = false }) {
  const ref=useRef()
  const roundedGeometry=useMemo(()=>rounded?new RoundedBoxGeometry(1,1,1,2,.08):null,[rounded])
  useEffect(()=>()=>roundedGeometry?.dispose(),[roundedGeometry])
  useLayoutEffect(()=>{
    const object=new THREE.Object3D(),color=new THREE.Color()
    items.forEach((item,index)=>{
      object.position.set(item.x,item.y,item.z); object.rotation.set(0,item.angle || 0,0); object.scale.set(item.w,item.h,item.d); object.updateMatrix()
      ref.current.setMatrixAt(index,object.matrix); ref.current.setColorAt(index,color.set(item.color))
    })
    ref.current.count=items.length
    ref.current.instanceMatrix.needsUpdate=true
    if(ref.current.instanceColor)ref.current.instanceColor.needsUpdate=true
  },[items])
  return <instancedMesh ref={ref} args={[null,null,Math.max(1,items.length)]} frustumCulled={false} castShadow={shadows} receiveShadow={!unlit} onClick={onClick ? event=>{event.stopPropagation();onClick(items[event.instanceId])} : undefined}>
    {rounded ? <primitive object={roundedGeometry} attach="geometry"/> : <boxGeometry args={[1,1,1]}/>}
    {unlit ? <meshBasicMaterial toneMapped={false} map={map} color={[glow,glow,glow]} transparent={opacity<1} opacity={opacity} depthWrite={opacity===1}/> : <meshStandardMaterial roughness={opacity<1?.16:.78} metalness={.08} transparent={opacity<1} opacity={opacity} depthWrite={opacity===1}/>}
  </instancedMesh>
}

function Sign({ position, children, caption, onClick, selected = false, visible = true, quietOnMobile = false }) {
  const compact=useThree(state=>state.size.width<600)
  return <SceneLabel position={position} visible={visible&&(!quietOnMobile||!compact||selected)} avoidCollisions priority={selected ? 4 : 1} style={{pointerEvents: onClick ? 'auto' : 'none'}}>
    <button type="button" className={`scene-sign shared-office-sign${selected ? ' scene-sign--selected' : ''}`} onClick={onClick} tabIndex={onClick ? 0 : -1} data-interactive={!!onClick}>{children}{caption && <small>{caption}</small>}</button>
  </SceneLabel>
}

function Plant({ x, z, tall = false }) {
  return <group position={[x,0,z]}>
    <mesh position={[0,.36,0]} castShadow><cylinderGeometry args={[.43,.32,.72,10]}/><meshStandardMaterial color="#a18b70" roughness={.9}/></mesh>
    <mesh position={[0,tall ? 1.7 : 1.1,0]} scale={[.72,tall ? 1.35 : .8,.72]} castShadow><icosahedronGeometry args={[1,1]}/><meshStandardMaterial color="#536f4b" roughness={1}/></mesh>
    <mesh position={[-.4,tall ? 1.3 : .95,.25]} scale={[.55,.7,.5]} castShadow><icosahedronGeometry args={[1,0]}/><meshStandardMaterial color="#7b8d5d" roughness={1}/></mesh>
  </group>
}

function FloorLamp({ x, z }) {
  return <group position={[x,0,z]}>
    <mesh position={[0,.11,0]}><cylinderGeometry args={[.48,.5,.12,12]}/><meshStandardMaterial color={INK}/></mesh>
    <mesh position={[0,1.55,0]}><cylinderGeometry args={[.035,.035,2.9,6]}/><meshStandardMaterial color={BRASS} metalness={.5} roughness={.4}/></mesh>
    <mesh position={[0,2.85,0]} castShadow><cylinderGeometry args={[.45,.72,.65,12,1,true]}/><meshStandardMaterial color="#e4cfaa" emissive="#e6ac62" emissiveIntensity={.28} side={THREE.DoubleSide}/></mesh>
  </group>
}

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// V6 scrolling "code" for every workstation screen: one tiny shared canvas,
// shifted up one line at CODE_HZ, multiplied by each screen's instance colour
// (provider tint while working, dark when idle). Zero extra draw calls - the
// texture rides the existing screens batch. Frozen under reduced motion.
function useCodeTexture() {
  const {texture, ctx}=useMemo(()=>{
    const canvas=document.createElement('canvas'); canvas.width=CODE_W; canvas.height=CODE_H
    const ctx=canvas.getContext('2d'); ctx.fillStyle=CODE_BG; ctx.fillRect(0,0,CODE_W,CODE_H)
    for(let y=0;y<CODE_H;y+=CODE_LINE)drawCodeLine(ctx,CODE_W,y,CODE_LINE)
    const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace
    return {texture, ctx}
  },[])
  const last=useRef(0), frozen=useMemo(prefersReducedMotion,[])
  useFrame(()=>{
    const now=performance.now()
    if(frozen||!shouldStepCode(now,last.current))return
    last.current=now
    ctx.drawImage(ctx.canvas,0,-CODE_LINE)
    ctx.fillStyle=CODE_BG; ctx.fillRect(0,CODE_H-CODE_LINE,CODE_W,CODE_LINE)
    drawCodeLine(ctx,CODE_W,CODE_H-CODE_LINE,CODE_LINE)
    texture.needsUpdate=true
  })
  return texture
}

// One InstancedMesh of static matrices per prop type; all four share one
// material and the 1xN palette texture, so the V6 props cost 4 draw calls.
function PropBatch({ geometry, material, items, onPick }) {
  const ref=useRef(), dummy=useMemo(()=>new THREE.Object3D(),[])
  useLayoutEffect(()=>{
    items.forEach((item,i)=>{
      dummy.position.set(item.x,item.y,item.z); dummy.rotation.set(0,item.yaw,0); dummy.scale.setScalar(item.scale); dummy.updateMatrix()
      ref.current.setMatrixAt(i,dummy.matrix)
    })
    ref.current.count=items.length
    ref.current.instanceMatrix.needsUpdate=true
  },[items,dummy])
  return <instancedMesh ref={ref} args={[geometry,material,Math.max(1,items.length)]} frustumCulled={false} receiveShadow
    onClick={onPick ? propPickHandler(items,onPick) : undefined}/>
}

// Billboarded steam puffs over the espresso machine; a pure (time, index)
// loop, rendered only on the top quality tier and never under reduced motion.
function CoffeeSteam({ origin }) {
  const {steam}=useSceneQuality()
  const reduced=useMemo(prefersReducedMotion,[])
  const ref=useRef(), dummy=useMemo(()=>new THREE.Object3D(),[]), tint=useMemo(()=>new THREE.Color(),[])
  const texture=useMemo(()=>{
    const size=64, canvas=document.createElement('canvas'); canvas.width=canvas.height=size
    const ctx=canvas.getContext('2d')
    const gradient=ctx.createRadialGradient(size/2,size/2,2,size/2,size/2,size/2)
    gradient.addColorStop(0,'rgba(255,255,255,.85)'); gradient.addColorStop(.5,'rgba(255,255,255,.35)'); gradient.addColorStop(1,'rgba(255,255,255,0)')
    ctx.fillStyle=gradient; ctx.fillRect(0,0,size,size)
    return new THREE.CanvasTexture(canvas)
  },[])
  useFrame(({clock,camera})=>{
    if(!ref.current)return
    const t=clock.elapsedTime
    for(let i=0;i<STEAM_COUNT;i++){
      const puff=steamParticle(t,i)
      dummy.position.set(origin.x+puff.drift,origin.y+puff.y,origin.z+puff.sway)
      dummy.quaternion.copy(camera.quaternion); dummy.scale.setScalar(puff.scale); dummy.updateMatrix()
      ref.current.setMatrixAt(i,dummy.matrix)
      ref.current.setColorAt(i,tint.setScalar(puff.fade*.5))
    }
    ref.current.instanceMatrix.needsUpdate=true
    if(ref.current.instanceColor)ref.current.instanceColor.needsUpdate=true
  })
  if(!steam||reduced)return null
  return <instancedMesh ref={ref} args={[null,null,STEAM_COUNT]} frustumCulled={false} raycast={()=>null} renderOrder={2}>
    <planeGeometry args={[1,1]}/>
    <meshBasicMaterial map={texture} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false}/>
  </instancedMesh>
}

// V6 desk props (no furniture/layout change): CC0 Kenney keyboards, side
// monitors, coffee cups and small plants on existing surfaces, deterministic
// per desk hash. Clicking a desk prop selects its seat like the desk itself.
function DeskProps({ layout, onPick }) {
  const placements=useMemo(()=>propPlacements(layout),[layout])
  const material=useMemo(()=>{
    const cell=8, canvas=document.createElement('canvas')
    canvas.width=PROP_PALETTE.length*cell; canvas.height=cell
    const ctx=canvas.getContext('2d')
    PROP_PALETTE.forEach((color,i)=>{ctx.fillStyle=color;ctx.fillRect(i*cell,0,cell,cell)})
    const palette=new THREE.CanvasTexture(canvas)
    palette.colorSpace=THREE.SRGBColorSpace; palette.magFilter=palette.minFilter=THREE.NearestFilter; palette.generateMipmaps=false
    return new THREE.MeshStandardMaterial({map:palette,roughness:.82,metalness:.05})
  },[])
  const geometries=useMemo(()=>({
    keyboard:buildPropGeometry('keyboard'), monitor:buildPropGeometry('monitor'),
    cup:buildPropGeometry('cup'), plant:buildPropGeometry('plant'),
  }),[])
  return <group>
    <PropBatch geometry={geometries.keyboard} material={material} items={placements.keyboards} onPick={onPick}/>
    <PropBatch geometry={geometries.monitor} material={material} items={placements.monitors} onPick={onPick}/>
    <PropBatch geometry={geometries.cup} material={material} items={placements.cups} onPick={onPick}/>
    <PropBatch geometry={geometries.plant} material={material} items={placements.plants} onPick={onPick}/>
    <CoffeeSteam origin={placements.steam}/>
  </group>
}

function Workstations({ layout, focus, onFocus, onSelectAgent, onSelectArea }) {
  const items=useMemo(()=>layout.desks.flatMap(seat=>{
    const provider=providerKeyFor(seat.provider) || providerKeyFor(seat.zone) || 'grok'
    const accent=providerFor(seat).color
    const fabric={claude:'#685247',codex:'#465c50',grok:'#575060',gemini:'#52657b','local-qwen':'#655d40'}[provider]
    return [
      box(0,1.45,monitorZ,1.45,.8,.065,INK),box(0,1.1,monitorZ,.08,.3,.08,BRASS),box(0,1.05,monitorZ-.05,.5,.04,.3,INK),
      // V6: the flat keyboard box was replaced by the instanced Kenney keyboard.
      box(0,1.05,-.35,1.35,.025,.56,'#343b36'),
      box(.72,1.08,-.32,.13,.04,.21,'#b8ad96'),box(-1.65,1.06,-.1,.48,.04,.62,accent),
      ...(!seat.roundTable ? [box(1.7,.55,.1,.68,.85,1.35,'#503a30'),box(1.7,.76,-.59,.28,.025,.03,BRASS)] : []),
      box(0,.57,chairOffsetZ,.95,.18,.85,fabric),box(0,1.06,chairOffsetZ-.37,.94,.86,.15,fabric),
      ...[-1,1].map(side=>box(side*.48,.81,chairOffsetZ,.09,.07,.65,INK)),
      box(0,.3,chairOffsetZ,.09,.5,.09,BRASS),box(0,.12,chairOffsetZ,.9,.06,.1,INK),box(0,.12,chairOffsetZ,.1,.06,.9,INK),
      // A small shaded task lamp: emissive shade, no extra real-time light.
      box(-1.72,1.06,.5,.34,.035,.26,BRASS),box(-1.72,1.38,.5,.035,.65,.035,BRASS),box(-1.62,1.72,.43,.52,.06,.28,'#d9c49d'),
    ].map(item=>localBox(seat,item))
  }),[layout])
  const benches=useMemo(()=>layout.benches.flatMap(bench=>[
    box(bench.x,.97,bench.z,bench.width,.12,bench.depth,'#977653'),
    box(bench.x,.9,bench.z-bench.depth/2,bench.width,.04,.04,BRASS),
    ...[-1,1].map(side=>box(bench.x+side*(bench.width/2-.4),.48,bench.z,.16,.9,bench.depth-.3,INK)),
    ...(bench.width>10?[box(bench.x,.48,bench.z,.16,.9,bench.depth-.3,INK)]:[]),
  ]),[layout])
  const screens=useMemo(()=>layout.desks.map(seat=>localBox(seat,box(0,1.45,screenZ,1.32,.68,.012,seat.occupant?.liveStatus==='working' ? providerFor(seat).color : '#34403e'))),[layout])
  const codeTexture=useCodeTexture()
  const choose=seat=>{
    if(seat?.occupant)onSelectAgent?.(seat.occupant)
    else if(seat)onFocus?.(`department-${layout.zones.findIndex(zone=>zone.id===seat.zone)}`)
  }
  return <group>
    <Boxes items={benches}/>
    {layout.roundTables.map(table=><group key={table.id}>
      <RoundTable {...table} height={.97} centerpiece onClick={()=>onFocus?.('department-0')}/>
    </group>)}
    <Boxes items={items} onClick={item=>choose(item?.seat)}/>
    <Boxes items={screens} unlit shadows={false} map={codeTexture} onClick={item=>choose(item?.seat)}/>
    <DeskProps layout={layout} onPick={choose}/>
    {/* Desk name tags removed: info shows only when a character/desk is clicked */}
  </group>
}

// Real work controls active counts; a bounded decorative idle pool adds traffic.
// Every person on the floor (working, reviewing, researching, meeting, reporting, resting)
// is drawn here and walks along the aisles whenever its state changes.
const PEOPLE_CAP = 160
// V4 eye placement in the head's local frame (head sphere radius .205): the
// beads sit on the face surface just below the hair-cap rim (the cap reaches
// theta .52*PI, i.e. y ~ -.013), so they read on the face, not in the hair.
const EYE_X = .075, EYE_Y = -.045, EYE_Z = .185
// Radial-gradient alpha disc shared by every blob shadow (one draw call for all feet).
function makeBlobTexture() {
  const size=64, canvas=document.createElement('canvas'); canvas.width=canvas.height=size
  const ctx=canvas.getContext('2d')
  const gradient=ctx.createRadialGradient(size/2,size/2,2,size/2,size/2,size/2)
  gradient.addColorStop(0,'rgba(0,0,0,.5)'); gradient.addColorStop(.55,'rgba(0,0,0,.3)'); gradient.addColorStop(1,'rgba(0,0,0,0)')
  ctx.fillStyle=gradient; ctx.fillRect(0,0,size,size)
  return new THREE.CanvasTexture(canvas)
}
function People({ layout, meeting, onArrived, onSelectAgent, residents = [], onSelectProvider, ambient = true }) {
  const movement=useMemo(()=>createMovement({ lounge: layout.lounge, commons: layout.commons }),[])
  const first=useRef(true), figuresRef=useRef([]), arrivedKey=useRef('')
  const refs=[useRef(),useRef(),useRef(),useRef(),useRef(),useRef(),useRef()]
  const blobRef=useRef(), blobTexture=useMemo(makeBlobTexture,[])
  // V4: both eyes of every figure share one instanced mesh; a blink is a Y
  // scale dip on the pair, so the whole crowd's eyes stay a single draw call.
  const eyeRef=useRef(), eye=useMemo(()=>new THREE.Object3D(),[]), eyeOffset=useMemo(()=>new THREE.Vector3(),[])
  const looks=useMemo(()=>new Map(),[])
  // V3: one damped head-yaw state per figure (the only motion state kept):
  // {yaw, t}, timestamped so throttled frames keep their elapsed time.
  const headYaws=useMemo(()=>new Map(),[])
  const dummy=useMemo(()=>new THREE.Object3D(),[]), color=useMemo(()=>new THREE.Color(),[])
  // V5: on phone tiers, figures near or past the screen edge refresh their
  // matrices at distantHz instead of every rendered frame (one shared gate).
  const {distantHz}=useSceneQuality()
  const distantGate=useRef(0), projected=useMemo(()=>new THREE.Vector3(),[])
  useEffect(()=>{
    const working=layout.agents.map(agent=>{ const desk=sharedSeatForAgent(agent,layout); return desk && { id: agent.id, agent, provider: providerKeyFor(agent.provider) || desk.provider, desk } }).filter(Boolean)
    figuresRef.current=[...residentFigures(residents), ...movement.sync({ working, meeting, ambient, now: performance.now(), initial: first.current })]
    first.current=false
  },[layout,meeting,movement,ambient,residents])
  useFrame(({clock,camera})=>{
    const now=performance.now(), figures=[...residentFigures(residents), ...movement.step(now)]
    figuresRef.current=figures
    const arrived=figures.filter(f=>f.agent&&!f.walking&&!f.queue.length&&f.spot?.id?.startsWith('desk:')).map(f=>f.id).sort().join('|')
    if(arrived!==arrivedKey.current){arrivedKey.current=arrived;onArrived?.(new Set(arrived?arrived.split('|'):[]))}
    let skipDistant=false
    if(Number.isFinite(distantHz)){
      if(now-distantGate.current>=1000/distantHz)distantGate.current=now
      else skipDistant=true
    }
    const t=clock.elapsedTime
    if(headYaws.size>PEOPLE_CAP*2)headYaws.clear()
    figures.slice(0,PEOPLE_CAP).forEach((f,i)=>{
      // A throttled figure keeps last frame's matrices for at most 1/distantHz.
      if(skipDistant){
        projected.set(f.x,1.2,f.z).project(camera)
        if(Math.abs(projected.x)>.72||Math.abs(projected.y)>.72)return
      }
      const h=hashIndex(f.id), provider=OFFICE_PROVIDERS[f.provider]||OFFICE_PROVIDERS.grok
      const lookKey=`${f.id}|${provider.color}`
      let look=looks.get(lookKey); if(!look){look=personAppearance(f.id,provider.color);looks.set(lookKey,look)}
      const colors=[look.shirt,look.skin,look.hair,look.shirt,look.shirt,look.trousers,look.trousers]
      refs.forEach((ref,part)=>ref.current?.setColorAt(i,color.set(colors[part])))
      // V3 head look-at: during a glance window the head turns (damped, neck
      // clamped, rear targets ignored) toward the nearest figure; otherwise it
      // settles back to the monitor / the walking direction.
      // V4 lounge chat: resting figures turn toward a sofa neighbour in longer,
      // more frequent windows than the desk glances, as if mid-conversation.
      const chatting=f.sitting&&f.spot?.kind==='lounge'&&isChatting(t,h)
      let target=0
      if(chatting||(f.sitting&&isGlancing(t,h))){
        let best=null,bestD=GLANCE_RADIUS*GLANCE_RADIUS
        for(const other of figures){ if(other===f)continue; if(chatting&&other.spot?.kind!=='lounge')continue; const dx=other.x-f.x,dz=other.z-f.z,d=dx*dx+dz*dz; if(d<bestD){bestD=d;best=other} }
        if(best)target=clampHeadYaw(relativeYaw(f.x,f.z,f.angle,best.x,best.z))
      }
      // stepHeadYaw damps over the time since this figure's own last update,
      // so frames skipped by the distant throttle above don't slow the head.
      const headYaw=stepHeadYaw(headYaws,f.id,target,t)
      let parts
      if(f.sitting){
        const {typing,bob,stretch,lean}=seatedMotion(t,h,!!f.agent)
        const rest=stretch+lean, armBase=f.agent?-.8:-.2
        // Head/hair pitch reads on the hair cap: down at the keyboard while
        // typing, up and back during a stretch or lean-back. V4 adds agreeing
        // nod bursts in meetings and a gentle talking nod while chatting.
        const nod=(f.spot?.kind==='meeting'?nodMotion(t,h):0)+(chatting?(Math.sin(t*5+h)+1)*.5*CHAT_NOD:0)
        const headPitch=(f.agent?.12:.04)*(1-rest)-lean*.35-stretch*.15+nod
        const headX=Math.sin(headYaw)*.06
        parts=[
          [0,1.1+bob,0,(f.agent?.05:0)*(1-rest)-lean*.3-stretch*.08],
          [headX,1.74+bob+stretch*.03,-lean*.2,headPitch,headYaw],
          [headX,1.92+bob+stretch*.03,-lean*.2,headPitch,headYaw],
          [-.34-stretch*.06,1.1*(1-rest)+1.04*lean+1.66*stretch+bob,.12*(1-rest)-.04*lean-.02*stretch,(armBase+typing)*(1-rest)-.15*lean-.05*stretch],
          [.34+stretch*.06,1.1*(1-rest)+1.04*lean+1.66*stretch+bob,.12*(1-rest)-.04*lean-.02*stretch,(armBase-typing)*(1-rest)-.15*lean-.05*stretch],
          [-.15,.64,.2+lean*.15,Math.PI/2-lean*.2],
          [.15,.64,.2+lean*.15,Math.PI/2-lean*.2],
        ]
      }else{
        // Only real walkers get the gait; a figure standing still (e.g. the
        // report-point dwell) holds a neutral pose via the walking guard.
        const {swing,lift,lean,sway}=walkMotion(t,h,f.walking)
        // Torso and arms lean forward and sway at step rate (hip sway); the
        // head counter-rotates half the sway so the gaze stays steady.
        parts=[
          [0,1.42+lift,0,lean,sway],
          [0,2.06+lift,.08,lean*.4,headYaw-sway*.5],
          [0,2.24+lift,.08,lean*.4,headYaw-sway*.5],
          [-.34,1.4+lift,0,swing+lean,sway],
          [.34,1.4+lift,0,-swing+lean,sway],
          [-.15,.55,0,-swing,sway*.6],
          [.15,.55,0,swing,sway*.6],
        ]
      }
      const s=look.height
      parts.forEach(([x,y,z,rx,ry=0],part)=>{
        dummy.position.set(f.x+(x*Math.cos(f.angle)+z*Math.sin(f.angle))*s,y*s,f.z+(-x*Math.sin(f.angle)+z*Math.cos(f.angle))*s)
        dummy.rotation.set(rx,f.angle+ry,0,'YXZ'); dummy.scale.setScalar(s); dummy.updateMatrix()
        refs[part].current?.setMatrixAt(i,dummy.matrix)
        if(part!==1)return
        // V4 eyes ride the head transform (dummy still holds it): two beads on
        // the face, blinking by squashing their Y scale on a personal rhythm.
        const lid=blinkScale(t,h)
        for(let side=0;side<2;side++){
          eyeOffset.set(side?EYE_X:-EYE_X,EYE_Y,EYE_Z).multiplyScalar(s).applyQuaternion(dummy.quaternion)
          eye.position.copy(dummy.position).add(eyeOffset)
          eye.quaternion.copy(dummy.quaternion)
          eye.scale.set(s,s*lid,s); eye.updateMatrix()
          eyeRef.current?.setMatrixAt(i*2+side,eye.matrix)
        }
      })
      dummy.position.set(f.x,shadowHeightFor(f),f.z)
      dummy.rotation.set(-Math.PI/2,0,0,'YXZ'); dummy.scale.setScalar(s); dummy.updateMatrix()
      blobRef.current?.setMatrixAt(i,dummy.matrix)
    })
    ;[...refs,blobRef].forEach(ref=>{ if(!ref.current)return; ref.current.count=Math.min(PEOPLE_CAP,figures.length); ref.current.instanceMatrix.needsUpdate=true; if(ref.current.instanceColor)ref.current.instanceColor.needsUpdate=true })
    if(eyeRef.current){ eyeRef.current.count=Math.min(PEOPLE_CAP,figures.length)*2; eyeRef.current.instanceMatrix.needsUpdate=true }
  })
  const click=event=>{event.stopPropagation();const f=figuresRef.current[event.instanceId];if(f?.resident)onSelectProvider?.(f.resident.provider);else if(f?.agent)onSelectAgent?.(f.agent)}
  const props={args:[null,null,PEOPLE_CAP],frustumCulled:false,onClick:click,castShadow:true}
  return <group>
    <instancedMesh ref={refs[0]} {...props}><capsuleGeometry args={[.24,.42,4,8]}/><meshStandardMaterial roughness={.85}/></instancedMesh>
    <instancedMesh ref={refs[1]} {...props}><sphereGeometry args={[.205,10,8]}/><meshStandardMaterial roughness={.85}/></instancedMesh>
    <instancedMesh ref={refs[2]} {...props}><sphereGeometry args={[.208,10,7,0,Math.PI*2,0,Math.PI*.52]}/><meshStandardMaterial roughness={1}/></instancedMesh>
    {[3,4].map(part=><instancedMesh key={part} ref={refs[part]} {...props}><capsuleGeometry args={[.075,.42,3,6]}/><meshStandardMaterial roughness={.9}/></instancedMesh>)}
    {[5,6].map(part=><instancedMesh key={part} ref={refs[part]} {...props}><capsuleGeometry args={[.1,.55,3,6]}/><meshStandardMaterial roughness={.9}/></instancedMesh>)}
    {/* V4 eyes: one batch for every figure's pair; no raycast so clicks still land on the body, no shadow casting from beads this small. */}
    <instancedMesh ref={eyeRef} args={[null,null,PEOPLE_CAP*2]} frustumCulled={false} raycast={()=>null}>
      <sphereGeometry args={[.034,5,4]}/>
      <meshBasicMaterial color="#231d1a"/>
    </instancedMesh>
    {/* Soft blob shadow under every figure: one textured quad batch, no extra lights or shadow passes. */}
    <instancedMesh ref={blobRef} args={[null,null,PEOPLE_CAP]} frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[.95,.95]}/>
      <meshBasicMaterial map={blobTexture} transparent depthWrite={false} toneMapped={false} color="#000000"/>
    </instancedMesh>
  </group>
}

function WorkingPeople({ layout, focus, onSelectAgent, arrived }) {
  const [hoveredId,setHoveredId]=useState(null)
  const hoverTimer=useRef(null)
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[])
  const refs = [useRef(),useRef(),useRef(),useRef(),useRef(),useRef(),useRef()]
  const dummy = useMemo(()=>new THREE.Object3D(),[])
  const color = useMemo(()=>new THREE.Color(),[])
  // Bodies are drawn by People; this layer only adds click targets and the selected label once the person has sat down.
  const workers = useMemo(()=>layout.agents.map((agent,index)=>({agent,seat:sharedSeatForAgent(agent,layout),index})).filter(w=>w.seat&&arrived?.has(w.agent.id)),[layout,arrived])
  useLayoutEffect(()=>{
    workers.forEach(({agent},i)=>{
      const look = personAppearance(agent.id, providerFor(agent).color)
      const colors = [look.shirt,look.skin,look.hair,look.shirt,look.shirt,look.trousers,look.trousers]
      refs.forEach((ref,part)=>ref.current?.setColorAt(i,color.set(colors[part])))
    })
    refs.forEach(ref=>{if(ref.current?.instanceColor)ref.current.instanceColor.needsUpdate=true})
  },[workers,color])
  useFrame(({clock})=>{
    workers.forEach(({seat,index},i)=>{
      const motion=Math.sin(clock.elapsedTime*3+index*2.37)
      const parts=[[0,1.1,0,0],[0,1.74,0,0],[0,1.92,0,0],[-.34,1.1,.12,-.8+motion*.09],[.34,1.1,.12,-.8-motion*.09],[-.15,.64,.2,Math.PI/2],[.15,.64,.2,Math.PI/2]]
      parts.forEach(([x,y,z,rx],part)=>{
        dummy.position.set(seat.chairX+x*Math.cos(seat.angle)+z*Math.sin(seat.angle),y,seat.chairZ-x*Math.sin(seat.angle)+z*Math.cos(seat.angle))
        dummy.rotation.set(rx,seat.angle,0,'YXZ')
        dummy.updateMatrix()
        refs[part].current?.setMatrixAt(i,dummy.matrix)
      })
    })
    refs.forEach(ref=>{if(ref.current)ref.current.instanceMatrix.needsUpdate=true})
  })
  const click=event=>{event.stopPropagation();const worker=workers[event.instanceId];if(worker)onSelectAgent?.(worker.agent)}
  const hoverWorker=id=>{clearTimeout(hoverTimer.current);document.body.style.cursor='pointer';setHoveredId(id)}
  const hover=event=>{const worker=workers[event.instanceId];if(worker)hoverWorker(worker.agent.id)}
  const unhover=()=>{document.body.style.cursor='auto';clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>setHoveredId(null),150)}
  const props={args:[null,null,workers.length],frustumCulled:false,onClick:click,onPointerOver:hover,onPointerOut:unhover,castShadow:true}
  return <group>
    {workers.map(({agent,seat})=>{
      const {shortId,project}=identityFor(agent)
      const normalizedName=officeAgentLabel(agent.name), displayName=normalizedName===agent.name?agent.name:t(normalizedName)
      const selected=focus===`agent-${agent.index}`
      const showLabel=selected
      const provider=providerFor(agent)
      const select=event=>{event.stopPropagation();onSelectAgent?.(agent)}
      return <group key={agent.id} position={[seat.chairX,0,seat.chairZ]}>
        {selected && <mesh position={[0,.12,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.72,.8,32]}/><meshBasicMaterial color={provider.marker} transparent opacity={.7} side={THREE.DoubleSide}/></mesh>}
        <mesh position={[0,1.7,0]} onClick={select} onPointerOver={event=>{event.stopPropagation();hoverWorker(agent.id)}} onPointerOut={unhover}>
          <capsuleGeometry args={[.67,2,4,8]}/><meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false}/>
        </mesh>
        {showLabel&&<SceneLabel position={[0,2.85,0]} avoidCollisions priority={selected ? 6 : 2} zIndexRange={[32,0]} style={{pointerEvents:'auto'}}>
          <button type="button" data-no-i18n className={`agent-marker provider-${providerKeyFor(agent.provider) || seat.provider}${selected ? ' is-selected' : ''}`} data-runtime-id={workingRuntimeFor(agent).id} data-agent-id={agent.id} data-agent-status="running" data-provider={agent.provider} style={{'--provider-color':provider.marker}} title={`${displayName} · ${agent.provider} · ${t(officeRoleLabel(agent.role, agent.provider, workingRuntimeFor(agent)))}\n${project} · ${t('Running')}`} aria-label={t('Open {a}, {p}, agent {i}, Running, {r}').replace('{a}', displayName).replace('{p}', agent.provider).replace('{i}', shortId).replace('{r}', project)} onClick={select} onPointerEnter={()=>hoverWorker(agent.id)} onPointerLeave={unhover}><i/><code>{shortId}</code></button>
        </SceneLabel>}
      </group>
    })}
  </group>
}

function ManagerRoom({ zone, selected, onSelectArea }) {
  const back=zone.z-zone.depth/2,left=zone.x-zone.width/2,right=zone.x+zone.width/2
  const meeting=zone.meeting
  const items=useMemo(()=>[
    box(zone.x,.65,back,zone.width,1.2,.16,'#293b49'),
    box(right,.65,zone.z,.16,1.2,zone.depth,'#293b49'),
    box(left,.65,zone.z,.16,1.2,zone.depth,'#293b49'),
    ...[left,right].flatMap(x=>[box(x,2.2,back,.06,3.2,.08,BRASS),box(x,2.2,zone.front,.06,3.2,.08,BRASS),box(x,3.8,zone.z,.06,.06,zone.depth,BRASS)]),
    // One manager workstation is rendered by Workstations; this small table
    // has only two visitor chairs, with an open path through the room.
    box(zone.x,3.8,back,zone.width,.07,.08,BRASS),
    ...[-1,1].flatMap(side=>[
      box(meeting.x,.57,meeting.z+side*1.75,.95,.18,.85,'#575060'),
      box(meeting.x,1.06,meeting.z+side*2.12,.94,.86,.15,'#575060'),
      ...[-1,1].map(arm=>box(meeting.x+arm*.48,.81,meeting.z+side*1.75,.09,.07,.65,INK)),
      box(meeting.x,.3,meeting.z+side*1.75,.09,.5,.09,BRASS),
      box(meeting.x,.12,meeting.z+side*1.75,.9,.06,.1,INK),
      box(meeting.x,.12,meeting.z+side*1.75,.1,.06,.9,INK),
    ]),
  ],[zone,meeting,back,left,right])
  return <group>
    <Boxes items={items}/>
    <RoundTable x={meeting.x} z={meeting.z} radius={1.25} height={.9} onClick={()=>onSelectArea?.('management')}/>
    {[left,right].map(x=><mesh key={x} position={[x,2.25,zone.z]}><boxGeometry args={[.025,2.8,zone.depth]}/><meshStandardMaterial color="#d3c3a6" transparent opacity={.065} depthWrite={false}/></mesh>)}
    <Sign quietOnMobile selected={selected} position={[zone.x,1.6,zone.front]} onClick={()=>onSelectArea?.('management')}>Dispatch</Sign>
  </group>
}

// Room furniture shares the same instanced batches as the partitions. The warm
// fixtures are emissive, so each room has lighting without extra shadow passes.
function roomChair(x, z, angle, fabric, width = 1.5) {
  return [
    box(0,.34,0,width,.35,1.4,INK),box(0,.66,0,width,.3,1.4,fabric),
    box(0,1.15,-.62,width,1.25,.24,fabric),
    ...[-1,1].flatMap(side=>[
      box(side*(width/2+.02),.88,0,.18,.35,1.45,fabric),
      box(side*(width/2-.14),.18,0,.1,.3,1.1,BRASS),
    ]),
  ].map(item=>localBox({x,z,angle},item))
}

function RoundTable({ x, z, radius, height = 1, centerpiece = false, onClick }) {
  return <group position={[x,0,z]} onClick={event=>{event.stopPropagation();onClick?.()}}>
    <mesh position={[0,height,0]} castShadow receiveShadow><cylinderGeometry args={[radius,radius,.14,48]}/><meshStandardMaterial color="#b2936d" roughness={.7}/></mesh>
    <mesh position={[0,height/2,0]} castShadow><cylinderGeometry args={[.15,.27,height-.1,16]}/><meshStandardMaterial color={BRASS} roughness={.5}/></mesh>
    <mesh position={[0,.12,0]} receiveShadow><cylinderGeometry args={[radius*.48,radius*.52,.12,32]}/><meshStandardMaterial color={INK}/></mesh>
    <mesh position={[0,height+.17,0]}><cylinderGeometry args={[centerpiece ? .38 : .17,centerpiece ? .32 : .14,.2,16]}/><meshStandardMaterial color="#e8dcc4"/></mesh>
    {centerpiece&&<mesh position={[0,height+.43,0]} scale={[.53,.32,.53]}><icosahedronGeometry args={[1,1]}/><meshStandardMaterial color="#778762" roughness={1}/></mesh>}
  </group>
}

function Lounge({ lounge, focus, onFocus }) {
  const items=useMemo(()=>{
    const {x,z,width,depth}=lounge
    const sofa=({x,z,angle,width})=>[
      box(0,.32,0,width,.42,1.5,'#30555f'),
      box(0,.62,.12,width-.5,.18,1.1,'#43858a'),
      box(0,.95,-.6,width,.85,.32,'#30555f'),
      ...[-1,1].map(side=>box(side*(width/2-.18),.72,0,.36,.48,1.5,'#294953')),
      ...[-1,1].map(side=>box(side*(width/2-.4),.07,-.5,.12,.14,.12,INK)),
    ].map(item=>localBox({x,z,angle},item))
    return [
      ...lounge.sofas.flatMap(sofa),

    ]
  },[lounge])
  return <group>
    <Boxes items={items} rounded onClick={()=>onFocus?.('lounge')}/>
    {lounge.tables.map((table,i)=><RoundTable key={i} {...table} height={.65} onClick={()=>onFocus?.('lounge')}/>)}
    {lounge.plants.map(([px,pz],i)=><Plant key={i} x={px} z={pz} tall={i<4}/>)}
    <FloorLamp x={lounge.left+1} z={lounge.z}/>
    <Sign quietOnMobile position={[lounge.x,4.2,lounge.z]} onClick={()=>onFocus?.('lounge')} selected={focus==='lounge'} caption="Sofas · rest area">Lounge & Coffee</Sign>
  </group>
}

function Commons({ layout, focus, onFocus, onSelectArea, pendingTaskCount }) {
  const { reception:coffee, meeting, tasks, reports }=layout.commons
  const rooms=useMemo(()=>[meeting,tasks,reports],[meeting,tasks,reports])
  const shell=useMemo(()=>rooms.flatMap(room=>{
    const {x,z,width,depth,left,right,back,front,doorway,wallHeight}=room
    const doorLeft=doorway.x-doorway.width/2,doorRight=doorway.x+doorway.width/2
    return [
      // Solid screen / cabinet wall, split around a real, unobstructed doorway.
      box((left+doorLeft)/2,wallHeight/2,back,doorLeft-left,wallHeight,.18,'#293b49'),
      box((doorRight+right)/2,wallHeight/2,back,right-doorRight,wallHeight,.18,'#293b49'),
      box(doorway.x,wallHeight-.15,back,doorway.width,.3,.2,WOOD),
      ...[doorLeft,doorRight].map(dx=>box(dx,wallHeight/2,back,.1,wallHeight,.24,BRASS)),
      // Low sills and clear glazing keep the room visible from the office view.
      ...[left,right].flatMap(dx=>[
        box(dx,.38,z,.16,.7,depth,'#293b49'),
        box(dx,wallHeight,z,.07,.07,depth,BRASS),
        ...[back,z,front].map(dz=>box(dx,wallHeight/2,dz,.07,wallHeight,.07,BRASS)),
      ]),
      box(x,.38,front,width,.7,.16,'#293b49'),
      box(x,wallHeight,front,width,.07,.07,BRASS),
      box(x,wallHeight/2,front,.07,wallHeight,.07,BRASS),
      // Wall sconces stay on the solid pier, clear of the doorway.
      ...[left+1.2,right-1.2].flatMap(dx=>[
        box(dx,3.1,back+.2,.6,.7,.18,BRASS),
        box(dx,3.1,back+.34,.4,.48,.18,'#e4cfaa'),
      ]),
    ]
  }),[rooms])
  const glass=useMemo(()=>rooms.flatMap(({x,z,width,depth,left,right,front,wallHeight})=>[
    ...[left,right].map(dx=>box(dx,(wallHeight+.75)/2,z,.025,wallHeight-.75,depth,'#acdce4')),
    box(x,(wallHeight+.75)/2,front,width,wallHeight-.75,.025,'#acdce4'),
  ]),[rooms])
  const fixtures=useMemo(()=>rooms.flatMap(({left,right,back})=>[left+1.2,right-1.2].map(x=>box(x,3.1,back+.44,.33,.4,.025,'#f1d6a8'))),[rooms])
  const coffeeItems=useMemo(()=>{
    const {x,z,width,depth}=coffee
    return [
      box(x,.7,z,7,1.35,1.8,WOOD),box(x,1.42,z,width,.12,depth,'#c7b99d'),
      ...[-2.3,0,2.3].map(dx=>box(x+dx,.78,z-.92,2.15,1.05,.04,'#50392d')),
      box(x-1.8,1.88,z,1.05,.82,.75,INK),box(x-1.8,2.3,z,1.1,.06,.78,BRASS),box(x-1.8,1.75,z-.4,.7,.34,.04,'#b7a48a'),
      box(x+1,1.51,z-.1,1.4,.08,.65,'#806443'),box(x+1.4,1.68,z-.1,.22,.25,.22,'#e3d2b4'),box(x+.8,1.68,z-.1,.22,.25,.22,'#d6c6ac'),
    ]
  },[coffee])
  const meetingItems=useMemo(()=>{
    const {x,z,width,depth}=meeting.table
    return [
      box(x,1.07,z,width,.16,depth,WOOD),box(x,.96,z,width-.15,.045,depth-.15,BRASS),
      ...[-1,1].map(side=>box(x+side*3.8,.53,z,.24,1,depth-1.2,INK)),
      ...[-1,1].flatMap(side=>[-4.5,-1.5,1.5,4.5].flatMap(dx=>roomChair(x+dx,z+side*3.8,side<0?0:Math.PI,'#68715b'))),
      ...[-1,1].flatMap(side=>roomChair(x+side*7.5,z,side<0?Math.PI/2:-Math.PI/2,'#68715b')),
      box(x,1.18,z,2.4,.06,.9,'#a18b70'),
      ...[-4,4].map(dx=>box(x+dx,1.18,z,.85,.05,.65,'#c4ad87')),
      box(meeting.x+2,2.35,meeting.back+.19,10.3,2.7,.18,INK),
      box(meeting.x+2,.65,meeting.back+.55,10.8,.18,.9,WOOD),
    ]
  },[meeting])
  const screen=useMemo(()=>[
    box(meeting.x+2,2.35,meeting.back+.29,9.9,2.3,.025,'#34403e'),
    box(meeting.x-.4,2.8,meeting.back+.31,3.8,.09,.025,'#b8a27d'),
    ...[0,1,2].map(i=>box(meeting.x-.4,2.45-i*.3,meeting.back+.31,3.8-i*.7,.055,.025,'#80ad98')),
    ...[0,1,2,3].map(i=>box(meeting.x+3.4+i*.65,1.9+i*.15,meeting.back+.31,.35,.35+i*.3,.025,'#80ad98')),
  ],[meeting])
  const reportItems=useMemo(()=>{
    const shelfX=reports.x+2,shelfZ=reports.back+.85,shelfWidth=14
    return [
      box(shelfX,1.65,shelfZ-.55,shelfWidth,3.1,.16,WOOD),
      ...[-7,-2.35,2.35,7].map(dx=>box(shelfX+dx,1.65,shelfZ,.12,3.1,1.3,WOOD)),
      ...[.25,1.2,2.15,3.2].map(y=>box(shelfX,y,shelfZ,shelfWidth,.1,1.3,WOOD)),
      ...Array.from({length:27},(_,i)=>box(shelfX-6+(i%9)*1.5,.72+Math.floor(i/9)*.95,shelfZ+.05,.45+(i%3)*.1,.7,.8,['#b8a27d','#55695b','#94755b','#626271','#d4c2a5'][i%5])),
      // Low report cabinets run along the side wall, leaving the centre open.
      box(reports.right-1.1,1.05,reports.z-1,1.4,1.9,7.2,WOOD),
      ...[-3,-1,1].flatMap(dz=>[
        box(reports.right-1.82,1.05,reports.z+dz, .04,1.6,1.8,'#806443'),
        box(reports.right-1.86,1.25,reports.z+dz,.06,.08,.45,BRASS),
      ]),
      ...roomChair(reports.x+1,reports.z+2,-.2,'#7f876b',2.3),
      box(reports.x+.5,.5,reports.z+4.3,2.2,.7,1.5,'#68715b'),
      box(reports.x-3, .65,reports.z+2.2,2,.15,2,WOOD),
      box(reports.x-3,.33,reports.z+2.2,.18,.6,.18,BRASS),
      box(reports.x-3,.77,reports.z+2.2,.95,.08,.75,'#d6c09a'),
    ]
  },[reports])
  const boardItems=useMemo(()=>{
    const x=tasks.x+1.5,z=tasks.back+.25
    return [
      box(x,2.05,z,13,3.1,.2,'#4b4e40'),
      ...[.47,3.63].map(y=>box(x,y,z,13.3,.1,.24,BRASS)),
      ...[-6.6,6.6].map(dx=>box(x+dx,2.05,z,.1,3.2,.24,BRASS)),
      ...[-4.3,0,4.3].flatMap((dx,i)=>[
        box(x+dx,3.12,z+.12,3.5,.18,.025,['#c6ac79','#86a08c','#a798af'][i]),
        ...[1.25,2.2].flatMap((y,j)=>[-.85,.85].map(sx=>box(x+dx+sx,y,z+.12,1.4,.6,.025,['#c6ac79','#86a08c','#a798af'][(i+j)%3]))),
      ]),
      box(x,.43,z+.4,13.3,.12,.7,WOOD),
      // Supplies stay at the perimeter; the large central standing area is empty.
      box(tasks.right-1.3,.6,tasks.z+5,1.6,1.05,4,WOOD),
      box(tasks.right-1.3,1.17,tasks.z+5,1.8,.1,4.2,'#b8a27d'),
    ]
  },[tasks])
  return <group>
    <Boxes items={shell}/><Boxes items={glass} shadows={false} opacity={.12}/><Boxes items={fixtures} unlit shadows={false}/>
    <Boxes items={coffeeItems} onClick={()=>onFocus?.('reception')}/>
    <Boxes items={meetingItems} onClick={()=>onFocus?.('meeting')}/><Boxes items={screen} unlit shadows={false} onClick={()=>onFocus?.('meeting')}/>
    <Boxes items={reportItems} onClick={()=>onFocus?.('reports')}/><Boxes items={boardItems} onClick={()=>onSelectArea?.('tasks')}/>
    {rooms.map(room=><FloorLamp key={room.x} x={room.right-2.4} z={room.front-2.4}/>)}
    <Plant x={meeting.left+2.2} z={meeting.front-2.2}/><Plant x={reports.left+2.2} z={reports.front-2.2}/>
    <Plant x={coffee.x} z={coffee.z-4}/>
    <Sign quietOnMobile visible={focus==='reception'} position={[coffee.x,3.8,coffee.z]} onClick={()=>onFocus?.('reception')} selected={focus==='reception'}>Lounge & Coffee</Sign>
    <Sign quietOnMobile position={[meeting.x,4.4,meeting.z]} onClick={()=>onFocus?.('meeting')} selected={focus==='meeting'} caption="10 seats · wall screen">Meeting room</Sign>
    <Sign quietOnMobile position={[tasks.x,4.4,tasks.z]} onClick={()=>onSelectArea?.('tasks')} selected={focus==='tasks'} caption={`${pendingTaskCount || 0} to do`}>Task Board</Sign>
    <Sign quietOnMobile position={[reports.x,4.4,reports.z]} onClick={()=>onFocus?.('reports')} selected={focus==='reports'} caption="Reports & notes">Reports</Sign>
    {focus==='reports'&&<SceneLabel position={[reports.x,6,reports.z]} style={{pointerEvents:'auto'}}><div className="shared-hub-actions"><button onClick={()=>onSelectArea?.('projects')}>Projects</button><button onClick={()=>onSelectArea?.('reports')}>Reports</button></div></SceneLabel>}
  </group>
}

function Architecture({ layout }) {
  const {bounds}=layout, back=bounds.z-bounds.depth/2,left=bounds.x-bounds.width/2,right=bounds.x+bounds.width/2
  return <group>
    <StudioEnvelope layout={layout} Boxes={Boxes}/>
    <WoodFloor bounds={bounds}/>
    <ZonePlatforms layout={layout} Boxes={Boxes}/>
    <StudioDataScreen layout={layout} Boxes={Boxes}/>
    <StudioSoftFurnishings layout={layout} Boxes={Boxes}/>
    <Plant x={left+1.1} z={back+1.2} tall/><Plant x={right-1.1} z={back+1.2} tall/>
    <FloorLamp x={left+1.1} z={8}/><FloorLamp x={right-1.1} z={8}/>
  </group>
}

// V8a prototype (flag default off, ?figures=v8a or localStorage
// office.figuresV8a=1): swaps the primitive crowd for the VAT-skinned
// Quaternius characters. Lazy, so the chunk and the GLB only ever load with
// the flag on; the default path is untouched.
const RealisticPeopleLazy = lazy(() => import('./RealisticPeople.jsx'))

function SharedOffice({ residents, onSelectProvider, layout, focus, onFocus, onSelectAgent, onSelectArea, pendingTaskCount, geminiNeedsLogin = false, meeting = null, ambient = true }) {
  const [arrived,setArrived]=useState(()=>new Set())
  const realisticFigures=useMemo(()=>typeof window!=='undefined'&&figuresV8aEnabled({search:window.location.search,storage:window.localStorage}),[])
  return <group>
    <Architecture layout={layout}/>
    {layout.zones.map((zone,index)=><group key={zone.id}>
      <Sign quietOnMobile position={[zone.x,5.4,zone.z-zone.depth/2+2]} onClick={()=>onFocus?.(`department-${index}`)} selected={focus===`department-${index}`} caption={zone.id==='gemini'&&geminiNeedsLogin?`Sign-in needed · ${zone.deskCount} pods`:`${zone.workingCount} working · ${zone.deskCount} ${zone.deskCount===1?'pod':'pods'}`}>{zone.department}</Sign>
      {zone.id==='grok'&&<ManagerRoom zone={zone} selected={focus===`department-${index}`} onSelectArea={onSelectArea}/>}
    </group>)}
    <Workstations layout={layout} focus={focus} onFocus={onFocus} onSelectAgent={onSelectAgent} onSelectArea={onSelectArea}/>
    <CentralSocial area={layout.centralSocial} pendingTaskCount={pendingTaskCount} onTasks={()=>onSelectArea?.('tasks')}/>
    <Lounge lounge={layout.lounge} focus={focus} onFocus={onFocus}/>
    <Commons pendingTaskCount={pendingTaskCount} layout={layout} focus={focus} onFocus={onFocus} onSelectArea={onSelectArea}/>
    {realisticFigures
      ? <Suspense fallback={null}><RealisticPeopleLazy residents={residents} onSelectProvider={onSelectProvider} ambient={ambient} layout={layout} meeting={meeting} onArrived={setArrived} onSelectAgent={onSelectAgent}/></Suspense>
      : <CharacterSwitch layout={layout} meeting={meeting} onArrived={setArrived} onSelect={onSelectAgent} fallback={<People residents={residents} onSelectProvider={onSelectProvider} ambient={ambient} layout={layout} meeting={meeting} onArrived={setArrived} onSelectAgent={onSelectAgent}/>}/>}
    <ResidentLabels residents={residents} onSelectProvider={onSelectProvider}/>
    <WorkingPeople layout={layout} focus={focus} onSelectAgent={onSelectAgent} arrived={arrived}/>
  </group>
}

// V5: adaptive quality. Desktops start at the top tier (dpr 2, full motion),
// phones one tier down (dpr <=1.25, no postprocessing, distant figures
// throttled). PerformanceMonitor watches the real frame rate against the
// demand-loop tick: sustained low fps steps the tier down, sustained gesture
// headroom steps it back up, never above the device's starting ceiling.
const QualityContext=createContext(qualityTier('balanced'))
export const useSceneQuality=()=>useContext(QualityContext)
function AdaptiveQuality({ reducedMotion, children }) {
  const setDpr=useThree(state=>state.setDpr)
  const [ceiling]=useState(detectInitialTierId)
  const [tierId,setTierId]=useState(ceiling)
  const tier=qualityTier(tierId)
  useEffect(()=>{setDpr(tierDpr(tier,window.devicePixelRatio||1))},[tier,setDpr])
  const scene=<QualityContext.Provider value={tier}>{children}</QualityContext.Provider>
  // Keep the same scene parent when preferences change: remounting would reset
  // real workers and meetings. The 1Hz reduced-motion loop is not a slow device.
  return <PerformanceMonitor bounds={()=>reducedMotion?[0,Infinity]:monitorBounds(tier.motionHz)} onDecline={()=>{if(!reducedMotion)setTierId(id=>degradedTierId(id))}} onIncline={()=>{if(!reducedMotion)setTierId(id=>improvedTierId(id,ceiling))}}>{scene}</PerformanceMonitor>
}

// V7: the Mac-only post pass (see PostEffects.jsx), keyed off the live tier so
// a mid-session degrade unmounts it and no phone tier ever reaches it. The
// chunk behind the lazy import only loads once a qualifying tier mounts it.
const MacPostEffects=lazy(()=>import('./PostEffects.jsx'))
function PostEffects() {
  const tier=useSceneQuality()
  if(!postEffectsEnabled(tier))return null
  return <OptionalSceneEffects><Suspense fallback={null}><MacPostEffects/></Suspense></OptionalSceneEffects>
}

// V8a measurement aid: with ?fxstats=1 the renderer's per-frame draw-call and
// triangle counters are logged every ~2s, so the primitive crowd and the VAT
// crowd can be compared on the same device (flag off vs ?figures=v8a).
function SceneStats() {
  const enabled=useMemo(()=>{try{return new URLSearchParams(window.location.search).get('fxstats')==='1'}catch{return false}},[])
  const last=useRef(0)
  useFrame(({gl})=>{
    if(!enabled)return
    const now=performance.now()
    if(now-last.current<2000)return
    last.current=now
    console.info(`[fxstats] ${gl.info.render.calls} draw calls, ${gl.info.render.triangles} triangles`)
  })
  return null
}

// Idle rooms render only as needed; working animations have a modest frame budget.
// OrbitControls and camera flights invalidate independently for fluid gestures.
function SceneActivity({ active, reducedMotion }) {
  const invalidate=useThree(state=>state.invalidate)
  const {motionHz}=useSceneQuality()
  useEffect(()=>{
    const timer=window.setInterval(()=>{if(!document.hidden)invalidate()},active&&!reducedMotion ? 1000/motionHz : 1000)
    return ()=>window.clearInterval(timer)
  },[active,reducedMotion,motionHz,invalidate])
  return null
}

function CameraRig({ layout, focus, mode, revision }) {
  const {camera,size,invalidate}=useThree(), controls=useRef(), flight=useRef(null), initialized=useRef(false)
  const area=sharedFocusArea(focus,layout)
  useEffect(()=>{
    const target=new THREE.Vector3(area.x,0,area.z)
    const direction=mode==='plan'?new THREE.Vector3(0,1,.001).normalize():new THREE.Vector3(.55,.82,1).normalize()
    const distance=Math.max(120,Math.hypot(area.width,area.depth)+20)
    const position=target.clone().addScaledVector(direction,distance)
    camera.far=Math.max(500,distance*3)
    const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize()
    const up=new THREE.Vector3().crossVectors(direction,right).normalize()
    const width=Math.abs(right.x)*area.width+Math.abs(right.z)*area.depth
    const height=Math.abs(up.x)*area.width+Math.abs(up.z)*area.depth+Math.abs(up.y)*(area.type==='overview'?11:5)
    const compact=size.width<600
    const zoom=Math.max(.5,Math.min(80,(size.width-(compact?28:64))/width,(size.height-120)/height)*(compact?.97:area.type==='overview'?.87:.94))
    if(!initialized.current||window.matchMedia('(prefers-reduced-motion: reduce)').matches){camera.position.copy(position);camera.zoom=zoom;camera.lookAt(target);camera.updateProjectionMatrix();controls.current?.target.copy(target);controls.current?.update();flight.current=null;initialized.current=true}
    else flight.current={target,position,zoom}
    invalidate()
  },[camera,mode,focus,revision,size.width,size.height,area.x,area.z,area.width,area.depth,invalidate])
  useFrame((_,delta)=>{
    if(!flight.current||!controls.current)return
    const destination=flight.current,amount=1-Math.exp(-7*Math.min(delta,.1))
    camera.position.lerp(destination.position,amount);controls.current.target.lerp(destination.target,amount);camera.zoom=THREE.MathUtils.lerp(camera.zoom,destination.zoom,amount);camera.updateProjectionMatrix();controls.current.update()
    if(camera.position.distanceTo(destination.position)<.01&&Math.abs(camera.zoom-destination.zoom)<.01)flight.current=null
    else invalidate()
  })
  return <OrbitControls ref={controls} makeDefault enablePan enableZoom enableRotate={mode!=='plan'} enableDamping dampingFactor={.12} minZoom={.5} maxZoom={100} maxPolarAngle={Math.PI/2.08} minPolarAngle={.0005} screenSpacePanning onStart={()=>{flight.current=null}}/>
}

function OfficeLighting({ bounds }) {
  const span=Math.max(64,bounds.width,bounds.depth)
  const frustum=shadowFrustum(bounds,{ceiling:11})
  const [mapSize]=useState(detectShadowMapSize)
  const sun=useRef()
  const target=useMemo(()=>{
    const object=new THREE.Object3D()
    object.position.set(bounds.x,0,bounds.z)
    return object
  },[bounds.x,bounds.z])
  useLayoutEffect(()=>sun.current.shadow.camera.updateProjectionMatrix(),[frustum.x,frustum.y,span])
  // The HDR environment supplies part of the ambient term, so the constant
  // lights are dimmer than before it existed.
  return <>
    <primitive object={target}/>
    <ambientLight intensity={.35} color="#e7f1ff"/><hemisphereLight args={['#d5edff','#584632',.8]}/>
    <directionalLight ref={sun} target={target} position={[bounds.x+span*SUN_OFFSET.x,span*SUN_OFFSET.y,bounds.z+span*SUN_OFFSET.z]} intensity={2.1} color="#ffe2b9" castShadow shadow-bias={-.0004} shadow-normalBias={.045} shadow-mapSize={[mapSize,mapSize]} shadow-camera-left={-frustum.x} shadow-camera-right={frustum.x} shadow-camera-top={frustum.y} shadow-camera-bottom={-frustum.y} shadow-camera-far={span*3}/>
    <directionalLight position={[15,20,28]} intensity={.65} color="#bddfff"/>
  </>
}

const EMPTY_BOARD = {}
export default function OfficeScene({ residents = [], onSelectProvider, agents = [], board = EMPTY_BOARD, pendingTaskCount = 0, onSelectAgent, onSelectArea, focus = 'overview', onFocus, cameraMode = '3d', cameraRevision = 0, onDeselect }) {
  const allocations=useMemo(()=>new Map(),[])
  const layout=useMemo(()=>createSharedLayout(agents,allocations,board),[agents,board,allocations])
  // First frames already render at the tier's dpr; AdaptiveQuality only re-steps it.
  const initialDpr=useMemo(()=>tierDpr(qualityTier(detectInitialTierId()),typeof window==='undefined'?1:window.devicePixelRatio||1),[])
  const [reducedMotion,setReducedMotion]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(()=>{
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)')
    const update=()=>setReducedMotion(preference.matches)
    preference.addEventListener('change',update)
    return()=>preference.removeEventListener('change',update)
  },[])
  return <Canvas onPointerMissed={()=>onDeselect?.()} orthographic shadows="soft" frameloop="demand" camera={{position:[48,62,70],zoom:10,near:.1,far:500}} dpr={initialDpr} gl={{antialias:true,alpha:false,powerPreference:'low-power',toneMapping:THREE.AgXToneMapping}}>
    <AdaptiveQuality reducedMotion={reducedMotion}>
      <color attach="background" args={['#091522']}/>
      <OfficeLighting bounds={layout.bounds}/>
      {/* Low-res HDR environment: soft reflections and fill light, loaded once. */}
      <Suspense fallback={null}><Environment files={SCENE_ENV_URL} environmentIntensity={SCENE_ENV_INTENSITY}/></Suspense>
      <Suspense fallback={null}><SharedOffice residents={residents} onSelectProvider={onSelectProvider} ambient={!reducedMotion} meeting={board?.meeting||null} geminiNeedsLogin={board?.runtime?.providers?.gemini?.needsLogin===true} pendingTaskCount={pendingTaskCount} layout={layout} focus={focus} onFocus={onFocus} onSelectAgent={onSelectAgent} onSelectArea={onSelectArea}/></Suspense>
      {/* Baked once (frames=1): ambient ground contact under furniture, no per-frame cost.
          Sits above the carpet pile (.041). The memo
          boundary takes scalars only so poll/focus rerenders cannot rebake or realloc. */}
      <BakedContactShadows x={layout.bounds.x} z={layout.bounds.z} width={layout.bounds.width} depth={layout.bounds.depth}/>
      <CameraRig layout={layout} focus={focus} mode={cameraMode} revision={cameraRevision}/>
      <PostEffects/>
      <SceneActivity active reducedMotion={reducedMotion}/>
      <SceneStats/>
    </AdaptiveQuality>
  </Canvas>
}
