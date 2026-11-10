import React from 'react'
import SceneLabel from './SceneLabel'
import { residentFigures } from './office-resident-layout.js'
import { useLang } from './i18n'

export default function ResidentLabels({ residents, onSelectProvider }) {
  const lang = useLang()
  return residentFigures(residents).map(figure => {
    const { resident } = figure
    const working = resident.status === 'working'
    const status = lang === 'zh' ? (working ? '运行中' : '待命') : (working ? 'Working' : 'Standby')
    const title = `${resident.provider} · ${lang === 'zh' ? '常驻代表' : 'Resident representative'} · ${status}`
    return <SceneLabel key={resident.id} position={[figure.x, 3.15, figure.z]} avoidCollisions priority={3} style={{ pointerEvents: 'auto' }}>
      <button type="button" className="resident-label" data-no-i18n aria-label={title} title={title} onClick={() => onSelectProvider?.(resident.provider)}>
        <span aria-hidden="true" className={`resident-dot${working ? ' resident-dot--working' : ''}`}/>
        <strong>{resident.provider === 'Local Qwen' ? 'Qwen' : resident.provider}</strong>
        <span>{status}</span>
      </button>
    </SceneLabel>
  })
}
