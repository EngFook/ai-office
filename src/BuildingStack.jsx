import React from 'react'
import './building-stack.css'

const FLOORS = [
  { number: 3, name: 'Grok', detail: 'Strategy & exploration', accent: '#b8a6f3' },
  { number: 2, name: 'Claude Code', detail: 'Game development & live agents', accent: '#e5ac88' },
  { number: 1, name: 'Codex', detail: 'Engineering, design & delivery', accent: '#9ad8b9' },
]

// An illustrated cutaway keeps every storey visible while the buttons remain
// ordinary, keyboard-accessible HTML controls.
function StoreyIllustration({ number }) {
  const desks = [
    '79,44 91,41 103,44 91,47', '108,39 120,36 132,39 120,42',
    '145,34 157,32 169,35 157,38', '177,40 189,38 201,41 189,44',
    '210,46 222,44 234,47 222,50', '119,54 131,51 143,54 131,57',
    '153,49 165,46 177,49 165,52', '184,55 196,52 208,55 196,58',
  ]
  return <svg className="building-stack__art" viewBox="0 0 320 91" aria-hidden="true" focusable="false">
    {/* The rear glazing, raised floor and front edge form a cutaway room. */}
    <polygon className="building-stack__wall-left" points="10,31 150,3 150,20 10,49" />
    <polygon className="building-stack__wall-right" points="150,3 300,31 300,49 150,20" />
    {[0, 1, 2, 3, 4].map(i => <line key={`l${i}`} x1={35 + i * 24} y1={26 - i * 5} x2={35 + i * 24} y2={44 - i * 5} className="building-stack__mullion" />)}
    {[0, 1, 2, 3, 4].map(i => <line key={`r${i}`} x1={174 + i * 25} y1={8 + i * 4.7} x2={174 + i * 25} y2={25 + i * 4.7} className="building-stack__mullion" />)}
    <polygon className="building-stack__floor" points="10,49 150,20 300,49 158,79" />
    <polygon className="building-stack__slab-left" points="10,49 158,79 158,85 10,55" />
    <polygon className="building-stack__slab-right" points="158,79 300,49 300,55 158,85" />
    <polyline className="building-stack__rail" points="11,49 150,20 299,49" />
    {/* Tiny desks and lamps make the individual floors read as furnished offices. */}
    {desks.map((points, i) => <polygon key={points} points={points} className="building-stack__desk" style={{ opacity: i % 2 ? .8 : 1 }} />)}
    {[['93','43'],['122','38'],['159','34'],['191','40'],['224','46'],['133','53'],['167','48'],['198','54']].map(([x,y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" className="building-stack__lamp" />)}
    <polygon className="building-stack__meeting" points="57,50 70,47 82,50 69,53" />
    <circle cx="66" cy="50" r="2.2" className="building-stack__plant" />
    <text x="251" y="53" className="building-stack__art-number">0{number}</text>
  </svg>
}

export default function BuildingStack({ floor, onSelectFloor }) {
  return <section className="building-stack" aria-label="Studio building selector">
    <div className="building-stack__heading">
      <div><span className="building-stack__eyebrow">THE BUILDING</span><h2>Choose a studio</h2></div>
      <span className="building-stack__count">STUDIO</span>
    </div>
    <p className="building-stack__description">Select a level to visit its team.</p>
    <div className="building-stack__drawing">
      <div className="building-stack__roof" aria-hidden="true"><span>STUDIO</span></div>
      <div className="building-stack__levels">
        {FLOORS.map(({ number, name, detail, accent }) => <button
          type="button"
          key={number}
          className={`building-stack__level${Number(floor) === number ? ' is-selected' : ''}`}
          style={{ '--building-accent': accent }}
          onClick={() => onSelectFloor?.(number)}
          aria-pressed={Number(floor) === number}
          aria-label={`Floor ${number}: ${name}, ${detail}${Number(floor) === number ? ', currently viewing' : ''}`}
        >
          <StoreyIllustration number={number} />
          <span className="building-stack__name" aria-hidden="true"><b>0{number}</b><span><strong>{name}</strong><small>{detail}</small></span><i>↗</i></span>
        </button>)}
      </div>
      <div className="building-stack__foundation" aria-hidden="true" />
    </div>
    <div className="building-stack__foot"><span className="building-stack__dot" /> SELECT A LEVEL <span>TO EXPLORE ↗</span></div>
  </section>
}
