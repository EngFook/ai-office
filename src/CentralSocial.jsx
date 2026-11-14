import React from 'react'
import SceneLabel from './SceneLabel'
import { useLang } from './i18n'

export default function CentralSocial({ area, blockedTaskCount = 0, huddle, onTasks }) {
  const lang = useLang()
  const { planter, board } = area
  const count = Math.max(0, Math.floor(blockedTaskCount))
  const label = lang === 'zh' ? `受阻布告栏 · ${count} 项` : `Blocked board · ${count}`
  const open = event => { event.stopPropagation(); onTasks?.() }
  return <group>
    <group position={[planter.x, 0, planter.z]}>
      {/* Low, layered island: foliage stays inside the original walking clearance. */}
      <mesh position={[0, .14, 0]} receiveShadow><boxGeometry args={[planter.width-.24, .22, planter.depth-.24]}/><meshStandardMaterial color="#a99a7f" roughness={.7}/></mesh>
      <mesh position={[0, .49, 0]} castShadow receiveShadow><boxGeometry args={[planter.width, .55, planter.depth]}/><meshStandardMaterial color="#f1eee5" roughness={.8}/></mesh>
      <mesh position={[0, .76, 0]}><boxGeometry args={[planter.width+.02, .045, planter.depth+.02]}/><meshStandardMaterial color="#c3ad81" roughness={.45} metalness={.25}/></mesh>
      <mesh position={[0, .79, 0]} receiveShadow><boxGeometry args={[planter.width-.32, .04, planter.depth-.32]}/><meshStandardMaterial color="#b6aea0" roughness={1}/></mesh>
      {[-2.7,-1.8,-.9,0,.9,1.8,2.7].flatMap((x, i)=>[-1.25,1.25].map((z,j)=><mesh key={`stone:${i}:${j}`} position={[x,.85,z]} scale={[.2,.07,.13]}><icosahedronGeometry args={[1,1]}/><meshStandardMaterial color={i%2?'#d9d4c7':'#e8e3d7'} roughness={1}/></mesh>))}
      {[{x:-2.25,z:.05,h:1.2},{x:0,z:-.15,h:1.8},{x:2.25,z:.05,h:1.35}].map((plant,i)=><group key={i} position={[plant.x,.8,plant.z]}>
        <mesh position={[0,plant.h*.42,0]} castShadow><cylinderGeometry args={[.035,.055,plant.h*.84,6]}/><meshStandardMaterial color="#6b7750" roughness={1}/></mesh>
        {Array.from({length:7},(_,j)=>{
          const a=j*Math.PI*2/7+i*.5, h=.35+(j%3)*plant.h*.26
          return <group key={j} position={[0,h,0]} rotation={[0,a,0]}>
            <mesh position={[.28,.14,0]} rotation={[0,0,-.65]} scale={[.2,.64,.08]} castShadow><sphereGeometry args={[1,8,6]}/><meshStandardMaterial color={['#3f654d','#638260','#8a9b6d'][(i+j)%3]} roughness={.92}/></mesh>
          </group>
        })}
      </group>)}
      {[-1.1,1.1].map((x,i)=><group key={`fern:${i}`} position={[x,.85,.7]}>
        {Array.from({length:5},(_,j)=><mesh key={j} rotation={[.3,j*1.26,.55]} position={[Math.sin(j*1.26)*.2,.25,Math.cos(j*1.26)*.2]} scale={[.16,.48,.09]} castShadow><sphereGeometry args={[1,7,5]}/><meshStandardMaterial color="#9aaa78" roughness={1}/></mesh>)}
      </group>)}
    </group>
    <group position={[board.x, 0, board.z]} onClick={open}>
      {[-1.7, 1.7].map(x => <group key={x}>
        <mesh position={[x, 1.55, 0]} castShadow><boxGeometry args={[.12, 2.95, .12]}/><meshStandardMaterial color="#66533f" roughness={.7}/></mesh>
        <mesh position={[x, .14, 0]} castShadow><boxGeometry args={[.7, .16, board.depth]}/><meshStandardMaterial color="#66533f" roughness={.7}/></mesh>
      </group>)}
      <mesh position={[0, 2.42, 0]} castShadow><boxGeometry args={[board.width, 2.4, .18]}/><meshStandardMaterial color="#aa916d" roughness={.75}/></mesh>
      <mesh position={[0, 2.42, .105]}><boxGeometry args={[board.width-.24, 2.16, .035]}/><meshStandardMaterial color="#e8e3d4" roughness={1}/></mesh>
      {Array.from({length: Math.min(6, count)}, (_, i) => <mesh key={i} position={[-1.45+(i%3)*1.45, 2.9-Math.floor(i/3)*.96, .14]}>
        <boxGeometry args={[1.1, .67, .035]}/><meshStandardMaterial color={['#e4b486','#dca79a','#e5c998'][i%3]} roughness={1}/>
      </mesh>)}
      <SceneLabel position={[0, 4.15, 0]} avoidCollisions priority={2} style={{pointerEvents:'auto'}}>
        <button type="button" className="scene-sign shared-office-sign" data-interactive="true" data-no-i18n aria-label={label} onClick={open}>{label}{huddle?.meeting?.active && <small style={{display:'block',fontSize:10,marginTop:3}}>{lang === 'zh' ? '查看受阻原因与下一步' : 'View blockers and next steps'}</small>}</button>
      </SceneLabel>
    </group>
  </group>
}
