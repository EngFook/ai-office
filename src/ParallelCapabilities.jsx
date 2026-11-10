import React from 'react'
import { useLang } from './i18n'

const PROVIDERS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', 'local-qwen': 'Qwen', 'grok-bot': 'Grok Bot' }
const detail = (id, capability, zh) => {
  if (id === 'codex') return zh ? `普通任务最多 ${capability.nativeLimit ?? '—'} 个原生子代理；共享额度，独立 worktree。` : `Up to ${capability.nativeLimit ?? '—'} native subagents per ordinary task; shared quota, separate worktrees.`
  if (id === 'claude') return zh ? '支持原生 Agent；按需分工，共享额度，独立 worktree。' : 'Native Agent delegation as needed; shared quota, separate worktrees.'
  if (id === 'gemini') return zh ? '独立研究任务并行；原生子代理尚未验证。' : 'Independent research tasks in parallel; native subagents are unverified.'
  if (id === 'local-qwen') return zh ? '单路本地推理，协调多个 AI 同时工作，保留 Mac 内存。' : 'One local inference at a time; coordinates other AIs in parallel and preserves Mac memory.'
  return zh ? '多个 Bot 可分别登记；启动与并行由外部 Grok Bot 管理。' : 'Multiple bots may register independently; the external Grok Bot app manages execution.'
}

export default function ParallelCapabilities({ capabilities }) {
  const zh = useLang() === 'zh'
  if (!capabilities || !Object.keys(capabilities).length) return null
  return <details className="tb-coordination tb-parallel" data-no-i18n>
    <summary><strong>{zh ? '多 Agent 协作' : 'Multi-agent collaboration'}</strong><span>{zh ? '查看并行容量与限制' : 'Capacity and limits'}</span></summary>
    <ul className="tb-coordination__list">{Object.entries(PROVIDERS).filter(([id]) => capabilities[id]).map(([id, label]) => {
      const capability = capabilities[id]
      const native = ({ enabled: zh ? '原生子代理已启用' : 'Native subagents enabled', available: zh ? '原生子代理可用' : 'Native subagents available', unverified: zh ? '原生子代理未验证' : 'Native subagents unverified', none: zh ? '通过任务板委派' : 'Delegation through the board' })[capability.nativeSubagents] || (zh ? '能力待确认' : 'Capability unconfirmed')
      const ready = capability.ready === true ? (zh ? '连接可用' : 'Connection ready') : capability.ready === false ? (zh ? '当前未就绪' : 'Currently unavailable') : (zh ? '外部管理' : 'Externally managed')
      return <li key={id}><div className="tb-coordination__row"><strong>{label}</strong><span>{ready} · {Number.isFinite(capability.taskSlots) ? (zh ? `${capability.taskSlots} 个任务席位` : `${capability.taskSlots} task slots`) : (zh ? '容量由外部管理' : 'External capacity')}</span></div><small>{native}</small><p>{detail(id, capability, zh)}</p></li>
    })}</ul>
    <p>{zh ? '只在任务适合时拆分；席位是运行上限，不代表当前都在工作。额度、登录、任务权限与项目占用仍会限制执行。只读排障不会另开子代理。' : 'Split work when useful. Slots are limits, not a count of active workers. Quota, login, permissions and project locks still apply. Read-only investigations do not spawn subagents.'}</p>
  </details>
}
