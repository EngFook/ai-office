import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'

const b = (x,y,z,w,h,d,color,angle=0) => ({x,y,z,w,h,d,color,angle})
export const STUDIO_ACCENTS = { claude:'#9955ff', codex:'#28e996', grok:'#f7a431', reviewers:'#ef4a9d', gemini:'#279cf4', 'local-qwen':'#bfc52c', overflow:'#9baeff' }

function useCanvasTexture(draw, dependencies) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1024; canvas.height = 256
    draw(canvas.getContext('2d'), canvas)
    const map = new THREE.CanvasTexture(canvas)
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4
    return map
  }, dependencies)
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

// One locally generated panorama, no network assets or additional shadow lights.
function CityPanorama({ bounds }) {
  const texture = useCanvasTexture((ctx, canvas) => {
    const sky = ctx.createLinearGradient(0,0,0,256)
    sky.addColorStop(0,'#448cb8'); sky.addColorStop(.6,'#bdd9e2'); sky.addColorStop(1,'#f1d9b4')
    ctx.fillStyle=sky; ctx.fillRect(0,0,1024,256)
    ctx.fillStyle='#fff1c5'; ctx.beginPath();ctx.arc(760,58,17,0,Math.PI*2);ctx.fill()
    for(let layer=0;layer<3;layer++) {
      for(let i=0;i<44;i++) {
        const x=i*25-10+(layer%2)*12, h=24+((i*47+layer*31)%100)*(layer===0?.7:1)
        ctx.fillStyle=['#abc6d4','#819eb4','#58778f'][layer]
        ctx.fillRect(x,256-h,18+(i%3)*5,h)
        if(layer===2) {
          for(let y=256-h+7;y<251;y+=9) for(let wx=x+4;wx<x+17;wx+=6) {
            ctx.fillStyle=(i+Math.floor(y/9))%4===0?'#f6d7a0':'#a3c7d6';ctx.fillRect(wx,y,2,3)
          }
        }
      }
    }
  }, [])
  const back=bounds.z-bounds.depth/2
  return <mesh position={[bounds.x,5.4,back-.22]} raycast={()=>null}>
    <planeGeometry args={[bounds.width,10.6]}/>
    <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false}/>
  </mesh>
}

export function StudioEnvelope({ layout, Boxes }) {
  const {bounds}=layout, back=bounds.z-bounds.depth/2, front=bounds.z+bounds.depth/2
  const left=bounds.x-bounds.width/2,right=bounds.x+bounds.width/2
  const count=Math.ceil(bounds.width/8), span=bounds.width/count
  const shell=useMemo(()=>[
    b(bounds.x,-.32,bounds.z,bounds.width,.64,bounds.depth,'#172635'),
    b(bounds.x,.32,back,bounds.width,.55,.38,'#233444'),
    b(bounds.x,10.8,back,bounds.width,.32,.42,'#233444'),
    b(bounds.x,5.5,back,bounds.width,.09,.28,'#233444'),
    ...Array.from({length:count+1},(_,i)=>b(left+i*span,5.5,back,.17,10.7,.34,'#233444')),
    // Tall feature wall remains at the far left; the viewing edges stay cut away.
    b(left,5.2,back+13,.3,10.4,26,'#293647'),
    b(left,.4,bounds.z,.24,.75,bounds.depth,'#293647'),
    b(right,.4,bounds.z,.24,.75,bounds.depth,'#293647'),
    b(bounds.x,-.1,front,bounds.width,.2,.28,'#9b8562'),
    ...Array.from({length:24},(_,i)=>b(left+.2,3.8,back+1+i*.43,.12,6.2,.14,'#8e7554')),
  ],[bounds,back,front,left,right,count,span])
  const strips=useMemo(()=>[
    b(bounds.x,.12,back+.32,bounds.width-.6,.055,.07,'#b3e1ef'),
    b(bounds.x,10.58,back+.23,bounds.width-.6,.055,.08,'#f4d4a0'),
    b(left+.24,.12,bounds.z,.06,.05,bounds.depth-.5,'#81adbb'),
    b(right-.24,.12,bounds.z,.06,.05,bounds.depth-.5,'#81adbb'),
  ],[bounds,back,left,right])
  return <group>
    <CityPanorama bounds={bounds}/><Boxes items={shell}/><Boxes items={strips} unlit glow={1.5} shadows={false}/>
    {/* Lightly tinted glazing, with a blue reflection band rather than transmission passes. */}
    <mesh position={[bounds.x,5.4,back+.04]} raycast={()=>null}>
      <planeGeometry args={[bounds.width-.3,10.4]}/>
      <meshStandardMaterial color="#b2e5f0" transparent opacity={.09} roughness={.16} metalness={.45} depthWrite={false} side={THREE.DoubleSide}/>
    </mesh>
  </group>
}

// Platforms sit at the existing floor level, so live figures, routes and contact shadows retain their height.
export function ZonePlatforms({ layout, Boxes }) {
  const {bases,edges,halos}=useMemo(()=>{
    const bases=[],edges=[]
    for(const zone of layout.zones) {
      const tint=STUDIO_ACCENTS[zone.id]||STUDIO_ACCENTS.overflow
      bases.push(b(zone.x,.039,zone.z,zone.width-.5,.009,zone.depth-.5,'#202c3e'))
      const x=zone.x,z=zone.z,w=zone.width-.65,d=zone.depth-.65
      edges.push(b(x,.065,z-d/2,w,.035,.09,tint),b(x,.065,z+d/2,w,.035,.09,tint),b(x-w/2,.065,z,.09,.035,d,tint),b(x+w/2,.065,z,.09,.035,d,tint))
      // Inset corner ticks give the platforms a finished metal trim.
      bases.push(b(x-w/2+.2,.05,z-d/2+.2,2,.015,.07,'#80919a'),b(x+w/2-.2,.05,z+d/2-.2,2,.015,.07,'#80919a'))
    }
    const halos=edges.map(edge=>({...edge,y:.05,w:edge.w<.1?.55:edge.w,d:edge.d<.1?.55:edge.d}))
    return {bases,edges,halos}
  },[layout.zones])
  return <group><Boxes items={bases} shadows={false}/><Boxes items={halos} unlit opacity={.18} shadows={false}/><Boxes items={edges} unlit glow={2.3} shadows={false}/></group>
}

export function StudioDataScreen({ layout, Boxes }) {
  const signature=layout.zones.map(z=>`${z.id}:${z.workingCount}:${z.deskCount}`).join('|')
  const texture=useCanvasTexture(ctx=>{
    ctx.fillStyle='#081723';ctx.fillRect(0,0,1024,256)
    ctx.fillStyle='#d5eaf0';ctx.font='600 30px sans-serif';ctx.fillText('STUDIO / redu',32,44)
    ctx.fillStyle='#75d9b0';ctx.font='16px monospace';ctx.fillText('LIVE WORKSPACE',780,42)
    layout.zones.forEach((zone,i)=>{
      const x=32+(i%4)*248,y=78+Math.floor(i/4)*92
      ctx.font='16px monospace';ctx.fillStyle=STUDIO_ACCENTS[zone.id]||'#9baeff';ctx.fillText(zone.id.toUpperCase(),x,y)
      ctx.fillStyle='#dfeced';ctx.font='22px monospace';ctx.fillText(`${zone.workingCount} / ${zone.deskCount}`,x,y+28)
      ctx.fillStyle='#233949';ctx.fillRect(x,y+43,208,5)
      ctx.fillStyle=STUDIO_ACCENTS[zone.id]||'#9baeff';ctx.fillRect(x,y+43,208*zone.workingCount/Math.max(1,zone.deskCount),5)
    })
  },[signature])
  const back=layout.bounds.z-layout.bounds.depth/2,x=layout.bounds.x+5
  return <group>
    <Boxes items={[b(x,6.1,back+.4,26,6.6,.32,'#17222e'),b(x,2.2,back+.5,26,.8,.8,'#314252')]}/>
    <mesh position={[x,6.1,back+.58]}>
      <planeGeometry args={[25,6.1]}/><meshBasicMaterial map={texture} toneMapped={false}/>
    </mesh>
    <Boxes items={[b(x,2.72,back+.64,25,.055,.12,'#76caeb')]} unlit glow={2} shadows={false}/>
  </group>
}

export function StudioSoftFurnishings({ layout, Boxes }) {
  const {lounge,commons:{reception:coffee,meeting,tasks,reports}}=layout
  const furniture=useMemo(()=>[
    // Chaise returns join the rear sofas while preserving the central aisle and all sitting anchors.
    ...[-22,-12].flatMap(x=>{
      const side=x<lounge.x?-1:1, chaiseX=x+side*3.05
      return [
      b(chaiseX,.45,-34.6,1.4,.65,3.1,'#356f75'),b(chaiseX+side*.61,.91,-34.6,.24,1.05,3.1,'#30555f'),
      b(chaiseX,.81,-33.9,1.24,.16,1.1,'#43858a'),
      ...[-1,1].map(side=>b(x+side*1.5,.91,-36.3,.72,.55,.28,side<0?'#d5b883':'#83bcb1',side*.12)),
    ]}),
    // Coffee cabinetry: fluted walnut, brass toe kick, service shelf and pendant rail.
    ...Array.from({length:19},(_,i)=>b(coffee.x-3.3+i*.36,.75,coffee.z-1,.12,1.1,.08,'#a2845a')),
    b(coffee.x,.15,coffee.z-1.04,6.8,.13,.08,'#a7bfaa'),
    b(coffee.x,3.3,coffee.z+.65,6.9,.14,.8,'#8c704e'),
    ...[-2.7,-1.8,-.9,1,1.8,2.6].map((dx,i)=>b(coffee.x+dx,3.65,coffee.z+.65,.35,.55,.36,['#c0d0be','#dab67a','#a3b5bf'][i%3])),
    b(coffee.x,5.4,coffee.z,6.8,.1,.12,'#283a44'),
    ...[-2.4,0,2.4].flatMap(dx=>[b(coffee.x+dx,4.8,coffee.z,.04,1.1,.04,'#bfab7f'),b(coffee.x+dx,4.2,coffee.z,.7,.18,.7,'#d7c19b')]),
    // Low upholstered benches and a pale stone floor distinguish the glazed commons.
    ...[meeting,tasks,reports].map(room=>b(room.x,.039,room.z,room.width-.25,.009,room.depth-.25,'#77838a')),
  ],[lounge,coffee,meeting,tasks,reports])
  const light=useMemo(()=>[
    b(coffee.x,3.2,coffee.z+.3,6.4,.045,.07,'#ffe0a6'),
    ...[-2.4,0,2.4].map(dx=>b(coffee.x+dx,4.09,coffee.z,.55,.035,.55,'#ffe4b3')),
    ...[meeting,tasks,reports].flatMap((room,i)=>[
      b(room.x,room.wallHeight+.06,room.front,room.width,.045,.065,['#80d2e9','#b7a0ef','#8bd2b7'][i]),
      b(room.left,room.wallHeight+.06,room.z,.06,.045,room.depth,['#80d2e9','#b7a0ef','#8bd2b7'][i]),
    ]),
  ],[coffee,meeting,tasks,reports])
  return <group>
    <Boxes items={furniture}/><Boxes items={light} unlit glow={1.8} shadows={false}/>
    {[-22,-12].map(x=><mesh key={x} position={[x,.043,lounge.z]} rotation={[-Math.PI/2,0,0]} receiveShadow>
      <circleGeometry args={[4.8,64]}/><meshStandardMaterial color="#4e7976" roughness={1}/>
    </mesh>)}
  </group>
}
