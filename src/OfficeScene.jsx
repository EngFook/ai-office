import React, { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import SceneLabel from './SceneLabel'
import { ZONES, seatForIndex, agentPosition, sharedLocations, focusArea } from './office-layout'

const COUNT = 200
const SKINS = ['#e1b59a', '#c68d70', '#a9694d', '#e5c1a3', '#875a48', '#d6a080']
const HAIR = ['#312822', '#483329', '#231f20', '#75503b', '#51443b']
const SHIRTS = ['#87a79a', '#c79d83', '#8193a2', '#a799ad', '#d0b59b', '#7d9290', '#b58e83']

// `floor` below is always the layout style (1, 2 or 3); `info` carries the configurable floor details.
function getAgent(info, index) {
  const department = info.departments[Math.floor(index / 50)]
  const number = String(index + 1).padStart(3, '0')
  return { id: `floor-${info.id}-agent-${number}`, index, name: `${info.name} ${number}`, role: department, department, provider: info.name, floor: info.id }
}

function Block({ position, size, color, ...props }) {
  return <mesh position={position} receiveShadow {...props}><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={0.9} /></mesh>
}

// Each body part is instanced, keeping stable, individually clickable IDs.
function Crowd({ floor, info, onSelectAgent, activeSet }) {
  const refs = Array.from({ length: 9 }, () => useRef())
  const person = useMemo(() => new THREE.Object3D(), [])
  const color = useMemo(() => new THREE.Color(), [])
  const agents = useMemo(() => Array.from({ length: COUNT }, (_, i) => {
    const zone = Math.floor(i / 50)
    const idle = agentPosition(floor, i, false)
    return {
      seat: seatForIndex(floor, i),
      idleX: idle.x, idleZ: idle.z, idleAngle: idle.angle,
      phase: i * 2.37, skin: SKINS[(i * 7 + zone) % SKINS.length], hair: HAIR[(i * 11 + zone) % HAIR.length], shirt: SHIRTS[(i * 13 + floor * 3) % SHIRTS.length]
    }
  }), [floor])

  useLayoutEffect(() => {
    agents.forEach((a, i) => {
      const colors = [a.shirt, a.skin, a.hair, a.shirt, a.shirt, '#666a70', '#666a70', '#666a70', '#666a70']
      refs.forEach((ref, part) => ref.current?.setColorAt(i, color.set(colors[part])))
    })
    refs.forEach(ref => {
      if (ref.current?.instanceColor) ref.current.instanceColor.needsUpdate = true
      if (ref.current) ref.current.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 120)
    })
  }, [agents, color])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    agents.forEach((a, i) => {
      const working = activeSet.has(i)
      const x = working ? a.seat.chairX : a.idleX
      const z = working ? a.seat.chairZ : a.idleZ
      const angle = working ? a.seat.angle : a.idleAngle
      const motion = Math.sin(t * (working ? 3 : .7) + a.phase)
      const parts = [
        [0, working ? 1.1 : 1.22, 0, 0, 1], [0, working ? 1.74 : 1.86, 0, 0, 1], [0, working ? 1.92 : 2.04, 0, 0, 1],
        [-.34, working ? 1.08 : 1.2, 0, working ? -.8 + motion * .12 : 0, 1], [.34, working ? 1.08 : 1.2, 0, working ? -.8 - motion * .12 : 0, 1],
        [-.15, working ? .72 : .48, working ? .27 : 0, working ? Math.PI / 2 : 0, 1], [.15, working ? .72 : .48, working ? .27 : 0, working ? Math.PI / 2 : 0, 1],
        [-.15, .36, .56, 0, working ? 1 : 0], [.15, .36, .56, 0, working ? 1 : 0],
      ]
      parts.forEach(([px, py, pz, rx, visible], part) => {
        const c = Math.cos(angle), s = Math.sin(angle)
        person.position.set(x + px * c + pz * s, py + (working ? 0 : motion * .012), z - px * s + pz * c)
        person.rotation.set(rx, angle, 0)
        person.scale.set(visible, visible, visible)
        person.updateMatrix()
        refs[part].current?.setMatrixAt(i, person.matrix)
      })
    })
    refs.forEach(ref => { if (ref.current) ref.current.instanceMatrix.needsUpdate = true })
  })
  const click = event => {
    event.stopPropagation()
    if (event.instanceId !== undefined) onSelectAgent?.(getAgent(info, event.instanceId))
  }
  const hover = () => { document.body.style.cursor = 'pointer' }
  const unhover = () => { document.body.style.cursor = 'auto' }
  const props = { args: [null, null, COUNT], frustumCulled: false, onClick: click, onPointerOver: hover, onPointerOut: unhover }
  return <group>
    <instancedMesh ref={refs[0]} {...props}><capsuleGeometry args={[.24,.42,4,8]} /><meshStandardMaterial roughness={.85} /></instancedMesh>
    <instancedMesh ref={refs[1]} {...props}><sphereGeometry args={[.205,10,8]} /><meshStandardMaterial roughness={.85} /></instancedMesh>
    <instancedMesh ref={refs[2]} {...props}><sphereGeometry args={[.208,10,7,0,Math.PI*2,0,Math.PI*.52]} /><meshStandardMaterial roughness={1} /></instancedMesh>
    {[3,4].map(n => <instancedMesh key={n} ref={refs[n]} {...props}><capsuleGeometry args={[.075,.42,3,6]} /><meshStandardMaterial roughness={.9} /></instancedMesh>)}
    {[5,6].map(n => <instancedMesh key={n} ref={refs[n]} {...props}><capsuleGeometry args={[.1,.55,3,6]} /><meshStandardMaterial roughness={.9} /></instancedMesh>)}
    {[7,8].map(n => <instancedMesh key={n} ref={refs[n]} {...props}><capsuleGeometry args={[.09,.38,3,6]} /><meshStandardMaterial roughness={.9} /></instancedMesh>)}
  </group>
}

function InstancedBoxes({ items, size, color }) {
  const ref = useRef()
  useLayoutEffect(() => {
    const dummy = new THREE.Object3D()
    items.forEach(([x,y,z,angle = 0], i) => { dummy.position.set(x,y,z); dummy.rotation.set(0,angle,0); dummy.updateMatrix(); ref.current.setMatrixAt(i, dummy.matrix) })
    ref.current.instanceMatrix.needsUpdate = true
  }, [items])
  return <instancedMesh ref={ref} args={[null, null, items.length]} receiveShadow frustumCulled={false}><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={.85}/></instancedMesh>
}

function Furniture({ floor }) {
  // One permanent workstation per agent, including when every agent is active.
  const desks = useMemo(() => Array.from({ length: COUNT }, (_, index) => seatForIndex(floor, index)), [floor])
  const nooks = useMemo(() => ZONES.flatMap(cx => Array.from({length:5},(_,pod) => Array.from({length:5},(_,col) => [cx + (col-2)*3.6, .082, -10.8 + pod*6.3])).flat()), [])
  const at = (y, forward=0) => desks.map(({x,z,dx,dz,angle}) => [x + dx*forward,y,z + dz*forward,angle])
  const chairs = (y, forward=0) => desks.map(({chairX,chairZ,dx,dz,angle}) => [chairX + dx*forward,y,chairZ + dz*forward,angle])
  const deskWidth = floor === 3 ? 1.35 : 2.3
  return <>
    {floor === 2 && <>
      <InstancedBoxes items={nooks} size={[3.3,.012,4.8]} color="#dce3d8" />
      <InstancedBoxes items={nooks.flatMap(([x,,z])=>[[x,.46,z-2.23],[x,.46,z+2.23]])} size={[3.3,.75,.1]} color="#a3b6a3" />
    </>}
    <InstancedBoxes items={at(.92)} size={[deskWidth,.12,floor === 3 ? .9 : 1.25]} color={floor === 2 ? '#d4c2a5' : floor === 3 ? '#ddb38c' : '#e0bc98'} />
    <InstancedBoxes items={at(.48)} size={[deskWidth*.86,.9,.08]} color="#9b7962" />
    <InstancedBoxes items={at(1.27,.32)} size={[.72,.46,.07]} color="#354c49" />
    <InstancedBoxes items={at(1.27,.26)} size={[.64,.36,.02]} color="#88b4a6" />
    <InstancedBoxes items={at(1.02,.32)} size={[.08,.16,.08]} color="#4f665c" />
    <InstancedBoxes items={at(1.01,-.3)} size={[.65,.035,.24]} color="#eae3d5" />
    <InstancedBoxes items={chairs(.52)} size={[.72,.14,.68]} color="#546e64" />
    <InstancedBoxes items={chairs(.9,-.33)} size={[.72,.72,.12]} color="#657f72" />
    <InstancedBoxes items={chairs(.27)} size={[.09,.48,.09]} color="#60726a" />
    {ZONES.map((x,i) => <group key={i}>
      {[-8.1,8.1].map(dx => <Plant key={dx} x={x+dx} z={20.6} />)}
      <Plant x={x-8.1} z={4.2} />
      <Plant x={x+8.1} z={-7} />
      {Array.from({length:5},(_,pod)=>floor === 1 ? <group key={pod}>
        <Block position={[x,.083,-10.8+pod*6.3]} size={[13.2,.012,4.5]} color={['#cfe0cc','#ecd2bb','#c9dfe0','#ddd0e2'][i]} />
        <Block position={[x,1.1,-10.8+pod*6.3]} size={[12.3,.35,.12]} color={['#8cae94','#c4987d','#8db1b2','#aa9bbd'][i]} />
      </group> : floor === 3 ? <mesh key={pod} position={[x,.09,-10.8+pod*6.3]} rotation={[-Math.PI/2,0,0]} scale={[6.7,2.7,1]}><circleGeometry args={[1,32]}/><meshStandardMaterial color={['#cfe0cc','#ecd2bb','#c9dfe0','#ddd0e2'][i]}/></mesh> : null)}
      {/* Small shelves add useful visual landmarks between work areas. */}
      <Block position={[x+8.05,.58,9]} size={[1.1,1.1,1.6]} color="#987760" />
      <Block position={[x+8.05,1.16,9]} size={[1.15,.08,1.65]} color="#dfc4a2" />
      <Block position={[x+8.05,1.34,9]} size={[.5,.3,.7]} color={['#608b79','#b97e67','#6d92a1','#9484a8'][i]} />
    </group>)}
  </>
}

function Plant({ x, z }) {
  return <group position={[x,0,z]}>
    <mesh position={[0,.32,0]}><cylinderGeometry args={[.35,.26,.64,8]}/><meshStandardMaterial color="#cbbba8"/></mesh>
    <mesh position={[0,1.2,0]}><sphereGeometry args={[.75,8,7]}/><meshStandardMaterial color="#809f7e"/></mesh>
    <mesh position={[-.35,.95,.1]}><sphereGeometry args={[.48,8,7]}/><meshStandardMaterial color="#6e926f"/></mesh>
    <mesh position={[.35,1.05,-.1]}><sphereGeometry args={[.48,8,7]}/><meshStandardMaterial color="#739573"/></mesh>
  </group>
}

function Sign({ position, children, accent = false, onClick, selected = false, visible = true }) {
  return <SceneLabel position={position} visible={visible} style={{pointerEvents:onClick ? 'auto' : 'none',userSelect:'none'}}>
    <button type="button" className={`scene-sign${accent ? ' scene-sign--accent' : ''}${selected ? ' scene-sign--selected' : ''}`} data-interactive={!!onClick} onClick={onClick} tabIndex={onClick ? 0 : -1}>{children}</button>
  </SceneLabel>
}

function SharedAreas({ accent, onSelectArea, floor, focus, onFocus }) {
  const locations = sharedLocations(floor)
  const shift = (target, original) => [target[0]-original[0],0,target[1]-original[1]]
  return <group>
    {/* Reception and shared circulation */}
    <group position={shift(locations.reception,[-27,27.1])}>
    <Block position={[-27,.075,27.1]} size={[18,.04,8]} color="#b5c9ba" />
    <Block position={[-27,.7,27.1]} size={[7.5,1.35,1.35]} color="#81664f" />
    <Block position={[-27,1.4,27.1]} size={[7.8,.12,1.7]} color="#f6f0e6" />
    <Block position={[-27,1.01,27.79]} size={[3.8,.36,.03]} color={accent} />
    {[-33,-21].map(x=><group key={x}>
      <Block position={[x,.45,25.1]} size={[3,.65,1.15]} color="#69897b" />
      <Block position={[x,.94,24.55]} size={[3,.8,.18]} color="#789b8a" />
      <Block position={[x,.82,25.1]} size={[2.75,.12,1.05]} color="#91afa0" />
    </group>)}
    <Plant x={-34} z={28.6} />
    <Plant x={-20} z={28.6} />
    {floor === 2 && [-36,-18].map(x=><group key={x}>
      <Block position={[x,1.15,29.5]} size={[2.2,2.2,.65]} color="#876a53" />
      {[.55,1.05,1.55].map((y,i)=><Block key={y} position={[x,y,29.85]} size={[1.8,.27,.08]} color={['#a5bfad','#c9967b','#cbb77f'][i]} />)}
    </group>)}
    {floor === 3 && [-36,-18].map(x=><group key={x}>
      <Block position={[x,1.3,29.5]} size={[2.4,2.35,.12]} color="#f2e5d0" />
      {[0,1,2].map(i=><Block key={i} position={[x-.65+i*.65,1.4+(i%2)*.35,29.59]} size={[.44,.38,.03]} color={['#d9957c','#a3c0ae','#b1a1c9'][i]} />)}
    </group>)}
    <Sign position={[-27,3.6,27]} accent onClick={()=>onFocus("reception")} selected={focus==="reception"} visible={focus==="overview" || focus==="reception"}>RECEPTION ↗</Sign>
    </group>

    {/* Enclosed meeting room with a large table, eight chairs, and an open doorway. */}
    <group position={shift(locations.meeting,[0,27])}>
    <Block position={[0,.075,27]} size={[20,.04,8.2]} color="#709789" />
    <Block position={[0,.66,22.9]} size={[20,1.3,.18]} color="#58776c" />
    <Block position={[-10,.66,27]} size={[.18,1.3,8.2]} color="#58776c" />
    <Block position={[10,.66,27]} size={[.18,1.3,8.2]} color="#58776c" />
    {[-6.25,6.25].map(x=><Block key={x} position={[x,.66,31.1]} size={[7.5,1.3,.18]} color="#58776c" />)}
    <Block position={[0,1.34,22.9]} size={[20,.08,.28]} color="#f5f3e9" />
    <Block position={[-10,1.34,27]} size={[.28,.08,8.2]} color="#f5f3e9" />
    <Block position={[10,1.34,27]} size={[.28,.08,8.2]} color="#f5f3e9" />
    {/* Glass above the low walls keeps the room enclosed without hiding the table. */}
    {[-10,10].map(x=><group key={x}>
      <mesh position={[x,2.15,27]}><boxGeometry args={[.06,1.55,8.2]}/><meshStandardMaterial color="#b5d8cb" transparent opacity={.16} depthWrite={false} roughness={.1}/></mesh>
      <Block position={[x,2.97,27]} size={[.1,.08,8.2]} color="#c5d6c9"/>
      {[23,27,31].map(z=><Block key={z} position={[x,2.15,z]} size={[.08,1.65,.08]} color="#a1b8ac"/>)}
    </group>)}
    <Block position={[0,2.2,22.9]} size={[20,1.65,.16]} color="#6d8a7b" />
    <Block position={[0,2.28,23.02]} size={[5.5,2.45,.16]} color="#233f3d" />
    <Block position={[0,2.28,23.13]} size={[5.15,2.12,.04]} color="#344f53" />
    {[-1.4,-.7,0,.7,1.4].map((x,i)=><Block key={x} position={[x,2.1,23.17]} size={[.36,.4+i*.22,.02]} color={i%2 ? '#c7b191' : '#9cbdaf'} />)}
    <Block position={[-6.7,2.22,23.06]} size={[3.8,2.1,.12]} color="#f0e7d5" />
    {[-7.7,-6.7,-5.7].map((x,i)=><Block key={x} position={[x,2.4,23.14]} size={[.55,.55,.02]} color={['#d7a27e','#a6bd9e','#b2a5c6'][i]}/>)}
    <Plant x={8.6} z={24.1}/>
    {floor === 3 ? <>
      <mesh position={[0,.82,27]}><cylinderGeometry args={[2.25,2.25,.2,32]}/><meshStandardMaterial color="#ecc293"/></mesh>
      <Block position={[0,.4,27]} size={[.5,.8,.5]} color="#8e7c69" />
      {Array.from({length:8},(_,i)=>{const a=i*Math.PI/4; return <group key={i} position={[Math.cos(a)*3.1,0,27+Math.sin(a)*3.1]} rotation={[0,-a,0]}>
        <Block position={[0,.5,0]} size={[1.2,.2,1]} color="#bf795d" />
        <Block position={[.48,.94,0]} size={[.16,.8,1.2]} color="#bf795d" />
      </group>})}
    </> : <>
      <Block position={[0,.82,27]} size={[10,.2,2.5]} color="#ecc293" />
      {[-4,4].map(x=><Block key={x} position={[x,.4,27]} size={[.18,.8,1.8]} color="#8e7c69" />)}
      {[-3.75,-1.25,1.25,3.75].flatMap(x=>[-1.85,1.85].map(z=><group key={`${x}-${z}`}>
        <Block position={[x,.5,27+z]} size={[1.2,.2,1]} color="#bf795d" />
        <Block position={[x,.94,27+z+(z<0?-.42:.42)]} size={[1.2,.8,.16]} color="#bf795d" />
      </group>))}
    </>}
    <Block position={[0,.93,27]} size={[1.8,.06,.8]} color="#f7f1e4" />
    <Block position={[0,.98,27]} size={[.8,.05,.45]} color={accent} />
    {[-1.5,1.5].map(x=><group key={x}>
      <Block position={[x,.95,27.35]} size={[.82,.06,.58]} color="#c0c8c3"/>
      <Block position={[x,1.23,27.64]} size={[.82,.52,.05]} color="#3d5656"/>
      <mesh position={[x+.6,1.07,27.35]}><cylinderGeometry args={[.12,.1,.26,12]}/><meshStandardMaterial color="#f7eee0"/></mesh>
    </group>)}
    <Sign position={[0,4.3,22.9]} accent onClick={()=>onFocus("meeting")} selected={focus==="meeting"} visible={focus==="overview" || focus==="meeting"}>MEETING ROOM <small>· 8 SEATS ↗</small></Sign>
    </group>

    {/* Reports and project progress remain accessible from the scene. */}
    <group position={shift(locations.reports,[27,27.1])}>
    <Block position={[27,.075,27.1]} size={[18,.04,8]} color="#b5c9ba" />
    {[-2,0,2].map((x,i)=><group key={x}>
      <Block position={[27+x,.8,27.1]} size={[1.7,1.5,1]} color={i===1 ? '#aec4b6' : '#d6c7b5'} />
      {[.42,.85,1.25].map(y=><Block key={y} position={[27+x,y,27.62]} size={[1.35,.025,.02]} color="#a99b8e" />)}
    </group>)}
    <Plant x={34} z={28.6} />
    <Sign visible={focus==="overview"} position={[27,3.6,27.1]} accent onClick={()=>onFocus("reports")}>REPORTS & PROGRESS ↗</Sign>
    <Sign visible={focus==="reports"} position={[27,3.6,25]} accent onClick={() => onSelectArea?.('reports')}>OPEN REPORTS ↗</Sign>
    <Sign visible={focus==="reports"} position={[27,3.6,29.3]} accent onClick={() => onSelectArea?.('projects')}>VIEW PROGRESS ↗</Sign>
    </group>
  </group>
}

function FrontCommons({ floor, focus }) {
  if (floor === 1) return null
  const colors = floor === 2 ? ['#cadbc8','#d8e3d2','#c6d9ce','#dce4d4'] : ['#dbc7b3','#d2b9c8','#c8d6d0','#d9c9df']
  return <group>
    {ZONES.map((x,i)=><group key={x}>
      <Block position={[x,.075,27.1]} size={[16.4,.04,7.4]} color={colors[i]} />
      {[-4.4,4.4].map(dx=><group key={dx}>
        <Block position={[x+dx,.47,27.1]} size={[2.8,.7,1.3]} color={floor===2 ? '#6f8f80' : '#b67f6b'} />
        <Block position={[x+dx,.98,26.5]} size={[2.8,.72,.16]} color={floor===2 ? '#86a594' : '#c99a85'} />
      </group>)}
      <Block position={[x,.46,27.1]} size={[2.4,.12,1.25]} color="#d6b28e" />
      <Block position={[x,.54,27.1]} size={[.65,.04,.42]} color={floor===2 ? '#789b85' : '#aa91b2'} />
      <Plant x={x-7.1} z={29.2} />
    </group>)}
    <Sign visible={focus==="overview"} position={[0,3.4,27.1]} accent>{floor===2 ? 'READING LOUNGES' : 'CREATIVE LOUNGES'}</Sign>
  </group>
}

function Office({ floor, info, onSelectAgent, onSelectArea, activeSet, focus, onFocus }) {
  const data = { accent: info.color, departments: info.departments }
  return <group>
    {/* A 79 × 58 footprint is approximately twice the previous floor area. */}
    <Block position={[0,-.18,4]} size={[79,.35,58]} color="#85664e" />
    <Block position={[0,.015,4]} size={[78.5,.06,57.5]} color="#bd916b" />
    {Array.from({ length: 39 }, (_, i) => <Block key={i} position={[-38+i*2,.052,4]} size={[.025,.006,57.4]} color="#a67654" />)}
    {floor !== 1 && <group>
      <Block position={[floor===2 ? -51 : 51,-.18,0]} size={[23,.35,48]} color="#85664e" />
      <Block position={[floor===2 ? -51 : 51,.015,0]} size={[23,.06,47.5]} color="#bd916b" />
      {Array.from({length:12},(_,i)=><Block key={i} position={[(floor===2 ? -62 : 40)+i*2,.052,0]} size={[.025,.006,47.4]} color="#a67654" />)}
    </group>}
    <Block position={[0,.065,22]} size={[77,.03,3.1]} color="#ae805f" />
    {/* Department partitions stop at the shared corridor. */}
    {[-38.2,-19.1,0,19.1,38.2].map(x=>{
      const opensToWing = (floor===2 && x===-38.2) || (floor===3 && x===38.2)
      const pieces = !opensToWing ? [[-1.2,46.2]] : floor===2 ? [[-21.5,5.6],[-8.5,13.6],[8.5,13.6],[20.3,3.2]] : [[-22,4.6],[-11.5,9.6],[6,18.6],[20.3,3.2]]
      return <group key={x}>{pieces.map(([z,length])=><group key={z}>
        <Block position={[x,.58,z]} size={[.2,1.12,length]} color="#98aa9d" />
        <Block position={[x,1.16,z]} size={[.27,.07,length]} color="#e8d4bb" />
      </group>)}</group>
    })}
    {ZONES.map((x,i)=>{
      const atDesk = Array.from(activeSet).filter(n => Math.floor(n / 50) === i).length
      return <group key={x}>
        <Block position={[x,.06,-19.5]} size={[18.5,.025,9.8]} color={['#84ae97','#c79981','#86aaac','#a999bb'][i]} />
        <Block position={[x,.06,3.85]} size={[17.3,.025,35.9]} color={['#bbd1bd','#dfc5ad','#b7cfd1','#cec1d6'][i]} />
        {[-8.25,8.25].map(dx=><group key={dx}>
          <Block position={[x+dx,.42,-19.3]} size={[1.05,.75,3.6]} color={['#527b68','#966754','#557d83','#796e8e'][i]} />
          <Block position={[x+dx,.88,-19.3]} size={[1.05,.18,3.6]} color={['#739b83','#bd8a72','#769da0','#9b8daa'][i]} />
        </group>)}
        {[-5.8,5.8].map(dx=><group key={dx}>
          <Block position={[x+dx,.56,-14.5]} size={[7,1.08,.18]} color="#839c8d" />
          <Block position={[x+dx,1.12,-14.5]} size={[7,.06,.25]} color="#ead6bb" />
        </group>)}
        <Block position={[x,.08,-24.25]} size={[17.2,.04,.24]} color={data.accent} />
        <Sign position={[x,3.6,-22.8]} onClick={()=>onFocus(`idle-${i}`)} selected={focus===`idle-${i}`} visible={focus==="overview" || focus===`department-${i}` || focus===`idle-${i}`}>IDLE ROOM <small>· {50-atDesk} ↗</small></Sign>
        <Sign position={[x,3.6,-10.7]} onClick={()=>onFocus(`department-${i}`)} selected={focus===`department-${i}`} visible={focus==="overview" || focus===`department-${i}` || focus===`idle-${i}`}>{data.departments[i].toUpperCase()} <small>· {atDesk} AT DESKS ↗</small></Sign>
      </group>
    })}
    {/* Low sill and translucent windows bring daylight to the back of each room. */}
    <Block position={[0,.45,-24.7]} size={[78.5,.9,.2]} color="#d5d5c8" />
    {Array.from({length: 8}, (_, i)=><group key={i}>
      <mesh position={[-34.2+i*9.75,2.1,-24.7]}><boxGeometry args={[9.35,2.45,.08]} /><meshStandardMaterial color="#b7d4d0" transparent opacity={.55} depthWrite={false} /></mesh>
      <Block position={[-38.95+i*9.75,2.1,-24.7]} size={[.12,2.55,.2]} color="#f3f2e9" />
    </group>)}
    <Block position={[0,3.37,-24.7]} size={[78.5,.12,.2]} color="#f3f2e9" />
    {floor!==2 && <Block position={[-39.2,.44,4]} size={[.18,.85,57.3]} color="#d4d8cb" />}
    {floor!==3 && <Block position={[39.2,.44,4]} size={[.18,.85,57.3]} color="#d4d8cb" />}
    {floor!==1 && <>
      <Block position={[floor===2 ? -62.4 : 62.4,.44,0]} size={[.18,.85,48]} color="#d4d8cb" />
      <Block position={[floor===2 ? -51 : 51,.44,-24]} size={[23,.85,.18]} color="#d4d8cb" />
      <Block position={[floor===2 ? -51 : 51,.44,24]} size={[23,.85,.18]} color="#d4d8cb" />
    </>}
    <Furniture floor={floor} />
    <FrontCommons floor={floor} focus={focus} />
    <SharedAreas accent={data.accent} onSelectArea={onSelectArea} floor={floor} focus={focus} onFocus={onFocus} />
    <LocationMarker floor={floor} info={info} focus={focus} activeSet={activeSet} />
    <Crowd floor={floor} info={info} onSelectAgent={onSelectAgent} activeSet={activeSet} />
  </group>
}

function LocationMarker({ floor, info, focus, activeSet }) {
  const area = focusArea(floor, focus, activeSet)
  if (area.type === 'overview') return null
  if (area.type === 'agent') {
    const agent = getAgent(info, area.index)
    return <group position={[area.x,0,area.z]}>
      <mesh position={[0,.12,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.65,.86,40]}/><meshBasicMaterial color="#ffe4a0" side={THREE.DoubleSide}/></mesh>
      <mesh position={[0,3.5,0]}><coneGeometry args={[.22,.48,8]}/><meshBasicMaterial color="#ffe4a0"/></mesh>
      <SceneLabel position={[0,4.8,0]} zIndexRange={[25,0]}><div className="agent-beacon"><i/><span>{agent.name}<small>{activeSet.has(area.index) ? 'At assigned desk' : 'In idle room'} · {agent.department}</small></span></div></SceneLabel>
    </group>
  }
  const w = area.width - .5, d = area.depth - .5
  return <group position={[area.x,.12,area.z]}>
    {[-1,1].map(sign=><group key={sign}>
      <Block position={[0,0,sign*d/2]} size={[w,.03,.12]} color="#e7f1c5"/>
      <Block position={[sign*w/2,0,0]} size={[.12,.03,d]} color="#e7f1c5"/>
    </group>)}
  </group>
}

function CameraRig({ floor, focus, mode, revision, activeSet }) {
  const { camera, size } = useThree()
  const controls = useRef()
  const flight = useRef(null)
  const initialized = useRef(false)
  const area = focusArea(floor, focus, activeSet)
  useEffect(() => {
    const target = new THREE.Vector3(area.x, 0, area.z)
    const direction = mode === 'plan' ? new THREE.Vector3(0,1,.001).normalize() : new THREE.Vector3(.65,.95,1).normalize()
    const position = target.clone().addScaledVector(direction, 120)
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), direction).normalize()
    const up = new THREE.Vector3().crossVectors(direction, right).normalize()
    const width = Math.abs(right.x)*area.width + Math.abs(right.z)*area.depth
    const height = Math.abs(up.x)*area.width + Math.abs(up.z)*area.depth + Math.abs(up.y)*5
    const zoom = Math.max(.5, Math.min(80, (size.width-48)/width, (size.height-110)/height))
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!initialized.current || reducedMotion) {
      camera.position.copy(position)
      camera.zoom = zoom
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      controls.current?.target.copy(target)
      controls.current?.update()
      flight.current = null
      initialized.current = true
    } else flight.current = { target, position, zoom }
  }, [camera, floor, mode, focus, revision, size.width, size.height, area.x, area.z, area.width, area.depth])

  useFrame((_, delta) => {
    if (!flight.current || !controls.current) return
    const destination = flight.current
    const amount = 1 - Math.exp(-7*Math.min(delta,.1))
    camera.position.lerp(destination.position, amount)
    controls.current.target.lerp(destination.target, amount)
    camera.zoom = THREE.MathUtils.lerp(camera.zoom, destination.zoom, amount)
    camera.updateProjectionMatrix()
    controls.current.update()
    if (camera.position.distanceTo(destination.position)<.01 && Math.abs(camera.zoom-destination.zoom)<.01) {
      camera.position.copy(destination.position)
      controls.current.target.copy(destination.target)
      camera.zoom = destination.zoom
      controls.current.update()
      camera.updateProjectionMatrix()
      flight.current = null
    }
  })
  return <OrbitControls ref={controls} makeDefault enablePan enableZoom enableRotate={mode!=='plan'} enableDamping dampingFactor={.12} minZoom={.5} maxZoom={100} maxPolarAngle={Math.PI/2.08} minPolarAngle={.0005} screenSpacePanning onStart={()=>{flight.current=null}} />
}

export default function OfficeScene({ info, layout = 1, onSelectAgent, onSelectArea, activeAgentIndices = [], focus = 'overview', onFocus, cameraMode = '3d', cameraRevision = 0 }) {
  const activeSet = useMemo(() => new Set(activeAgentIndices.filter(index => Number.isInteger(index) && index >= 0 && index < COUNT)), [activeAgentIndices])
  return <Canvas orthographic camera={{ position: [68, 74, 88], zoom: 10, near: .1, far: 500 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}>
    <ambientLight intensity={1.25} />
    <hemisphereLight args={['#fff6df', '#657d75', .65]} />
    <directionalLight position={[20, 40, 25]} intensity={1.65} />
    <Suspense fallback={null}><Office floor={Number(layout)} info={info} onSelectAgent={onSelectAgent} onSelectArea={onSelectArea} activeSet={activeSet} focus={focus} onFocus={onFocus} /></Suspense>
    <CameraRig floor={Number(layout)} focus={focus} mode={cameraMode} revision={cameraRevision} activeSet={activeSet}/>
  </Canvas>
}
