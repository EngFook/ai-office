import React, { useState } from 'react'
import { TaskBulkControls, useCardActions } from './TaskBulkControls.jsx'
import { useLang } from './i18n'
import { huddlePhaseLabel, huddleProviderLabel, huddleQuotaLabel, huddleActionLabel, blockedOwnership, resolutionStateLabel } from './huddle-ui.js'

const timeLabel = (value, zh) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(zh ? 'zh-CN' : 'en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Singapore' })
}
export default function HuddlePanel({ huddle, tasks = [], onSelectTask, board }) {
  const zh = useLang() === 'zh'
  const ownership = blockedOwnership(tasks)
  const [category, setCategory] = useState('active')
  const shownOwnership = ownership.filter(item => category === 'all' || (category === 'paused' ? item.state === 'paused' || item.state === 'user_denied' : !['paused', 'user_denied'].includes(item.state)))
  const visibleTasks = tasks.filter(task => shownOwnership.some(item => item.taskId === task.id))
  const actions = useCardActions(board, visibleTasks)
  if (!huddle) return null
  const activeOwnership = ownership.filter(item => item.state !== 'paused')
  const ownedCount = activeOwnership.filter(item => item.owner).length
  const pausedCount = ownership.length - activeOwnership.length
  const decisions = Array.isArray(huddle.decisions) ? huddle.decisions : []
  const attendees = Array.isArray(huddle.meeting?.attendees) ? huddle.meeting.attendees : []
  const discussion = Array.isArray(huddle.discussion) ? huddle.discussion : []
  return <section className="tb-huddle" data-no-i18n aria-label={zh ? 'Qwen 受阻任务集结' : 'Qwen blocked-task huddle'}>
    <div className="tb-huddle__heading"><div><span className="tb-huddle__eyebrow">{zh ? '受阻任务 · 每五分钟检查' : 'BLOCKED TASKS · FIVE-MINUTE CHECK'}</span><h2>{zh ? 'Qwen 集结与分配' : 'Qwen huddle & assignment'}</h2></div><span className={`tb-huddle__status is-${huddle.phase || 'idle'}`}>{huddlePhaseLabel(huddle, zh)}</span></div>
    <p>{zh ? 'Qwen 召集检查，按角色、权限、空闲状态和额度安排合适的负责人。受阻任务持续保留负责人、下一步和跟进时间；排查结果会写回任务。集结画面不代表其他模型已经发言。' : 'Qwen convenes checks and matches owners by role, permissions, availability and quota. Blocked requests retain an owner, next action and follow-up time, with findings written back to the task. The gathering does not imply other models have spoken.'}</p>
    <div className="tb-huddle__times">{Number.isFinite(huddle.reviewedCount) && <span>{zh ? '本轮检查' : 'Reviewed this round'} <strong>{huddle.reviewedCount}{Number.isFinite(huddle.blockedCount) ? ` / ${huddle.blockedCount}` : ''}</strong></span>}<span>{zh ? '最近检查' : 'Last check'} <strong>{timeLabel(huddle.lastCheckedAt, zh)}</strong></span><span>{zh ? '下次检查' : 'Next check'} <strong>{timeLabel(huddle.nextCheckAt, zh)}</strong></span>{huddle.meeting?.active && <span>{zh ? '集结代表' : 'Delegates'} <strong>{attendees.map(huddleProviderLabel).join(' · ') || '—'}</strong></span>}</div>
    {huddle.error && <p className="tb-huddle__error" role="status">{String(huddle.error)}</p>}
    {discussion.length > 0 && <details className="tb-huddle__advice"><summary>{zh ? '查看 Qwen 建议与检查记录' : 'Qwen advice and check record'}</summary>{discussion.map((entry, i)=><p key={i}>{typeof entry === 'string' ? entry : entry.text || entry.message || entry.content || ''}</p>)}</details>}
    {ownership.length > 0 && <details className="tb-huddle__ownership"><summary>{zh ? `受阻任务分工 · ${ownedCount} / ${activeOwnership.length} 项已有负责人${pausedCount ? ` · ${pausedCount} 项已暂停留档` : ''}` : `Blocked-task owners · ${ownedCount} / ${activeOwnership.length} assigned${pausedCount ? ` · ${pausedCount} paused records` : ''}`}</summary>{board && <><div className="tb-category-tabs" role="group" aria-label="Qwen 任务分类">{[['active', '受阻待处理'], ['paused', '已暂停／拒绝'], ['all', '全部受阻']].map(([id, label]) => <button key={id} type="button" disabled={actions.busy} aria-pressed={category === id} onClick={() => { setCategory(id); actions.setChecked({}) }}>{label}</button>)}</div><TaskBulkControls actions={actions} scopeLabel={{active:'受阻待处理',paused:'已暂停／拒绝',all:'全部受阻'}[category]}/></>}<ul className="tb-huddle__decisions">{shownOwnership.map(item => <li key={item.taskId}>
      {board && <label className="tb-card-select"><input type="checkbox" checked={!!actions.checked[item.taskId]} disabled={actions.busy} aria-label={`选择 Qwen 任务：${item.title}`} onChange={event => actions.select(tasks.find(task => task.id === item.taskId), event.target.checked)}/>选择</label>}
      <div><button type="button" className="tb-huddle__task-link" onClick={() => onSelectTask?.(item.taskId)} disabled={!onSelectTask}>{item.title || item.taskId}</button><span>{huddleProviderLabel(item.owner)} · {resolutionStateLabel(item.state, zh)}</span></div>
      <p>{item.nextAction || (zh ? '尚未记录下一步，等待协调员检查。' : 'No next action recorded yet; awaiting coordinator check.')}</p>
      {item.state !== 'paused' && <p>{zh ? '下次跟进：' : 'Next follow-up: '}{timeLabel(item.nextCheckAt, zh)} SGT</p>}
      {board && <div className="tb-card-actions">{[['rerequest','重新请求'],['delete','删除任务'],['deny','拒绝']].map(([action,label]) => <button key={action} type="button" disabled={actions.busy} onClick={() => actions.run(action,[tasks.find(task => task.id === item.taskId)])}>{label}</button>)}</div>}
      {item.investigationTaskId && <button type="button" className="tb-huddle__task-link is-secondary" onClick={() => onSelectTask?.(item.investigationTaskId)} disabled={!onSelectTask}>{zh ? '查看排查任务' : 'View investigation task'}</button>}
    </li>)}</ul></details>}
    {decisions.length > 0 ? <details className="tb-huddle__advice"><summary>{zh ? '本轮分工记录' : 'Decisions this round'}</summary><ul className="tb-huddle__decisions">{decisions.map((decision, i)=><li key={`${decision.taskId}:${i}`}><div><strong>{decision.title || decision.taskId}</strong><span>{huddleActionLabel(decision.action, zh)} · {huddleProviderLabel(decision.provider)} · {huddleQuotaLabel(decision.remainingPercent, zh)}</span></div><p>{decision.reason}</p></li>)}</ul></details> : <p className="tb-huddle__empty">{zh ? '暂无分配结论。没有受阻任务时不会制造任务或安排讨论。' : 'No assignment decisions yet. An empty blocked board does not create work or discussions.'}</p>}
  </section>
}
