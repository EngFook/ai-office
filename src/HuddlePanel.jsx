import { useOfficeDate } from './OfficeIdentity';
import React, { useState } from 'react'
import { TaskBulkControls, useCardActions } from './TaskBulkControls.jsx'
import { useLang } from './i18n'
import { compactTaskText } from './task-card-content.js'
import { huddlePhaseLabel, huddleProviderLabel, huddleQuotaLabel, huddleActionLabel, blockedWorkSummary, resolutionStateLabel, huddleTaskProgress } from './huddle-ui.js'

export default function HuddlePanel({ huddle, tasks = [], onSelectTask, board, runtime = {}, humanRequests = [] }) {
  const zh = useLang() === 'zh'
  const timeLabel = useOfficeDate({ month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', timeZoneName:'short' })
  const sourceRuntime = board?.state?.runtime || runtime
  const liveRuntime = board?.stale ? { ...sourceRuntime, agents: [], running: [], providers: {}, unavailable: true } : sourceRuntime
  const stale = liveRuntime?.unavailable === true
  const requests = board?.state?.humanRequests || humanRequests
  const summary = blockedWorkSummary(tasks, liveRuntime, requests)
  const ownership = summary.ownership
  const [category, setCategory] = useState('active')
  const shownOwnership = ownership.filter(item => category === 'all' || (category === 'paused' ? item.state === 'paused' || item.state === 'user_denied' : !['paused', 'user_denied'].includes(item.state)))
  const visibleTasks = tasks.filter(task => shownOwnership.some(item => item.taskId === task.id))
  const actions = useCardActions(board, visibleTasks)
  if (!huddle) return null
  const pausedCount = summary.paused
  const decisions = Array.isArray(huddle.decisions) ? huddle.decisions : []
  const attendees = Array.isArray(huddle.meeting?.attendees) ? huddle.meeting.attendees : []
  const discussion = Array.isArray(huddle.discussion) ? huddle.discussion : []
  const categoryLabels = zh ? { active: '受阻待处理', paused: '已暂停／拒绝', all: '全部受阻' } : { active: 'Needs action', paused: 'Paused / denied', all: 'All blocked' }
  const actionLabels = zh ? { rerequest: '重新请求', delete: '删除任务', deny: '拒绝' } : { rerequest: 'Request again', delete: 'Delete task', deny: 'Deny' }
  const progress = taskId => {
    const value = huddleTaskProgress(taskId, tasks, liveRuntime, board?.state?.settings, zh, requests)
    return <p className={`tb-huddle__progress is-${value.status}`}><strong>{value.label}</strong>{value.detail && <span> · {compactTaskText(value.detail, zh ? '打开原任务查看原因。' : 'Open the task for the reason.')}</span>}</p>
  }
  return <section className="tb-huddle" data-no-i18n aria-label={zh ? 'Qwen 受阻任务集结' : 'Qwen blocked-task huddle'}>
    <div className="tb-huddle__heading"><div><span className="tb-huddle__eyebrow">{zh ? '受阻任务 · 分工与下一步' : 'BLOCKED TASKS · OWNERS AND NEXT STEPS'}</span><h2>{zh ? 'Qwen 集结与分配' : 'Qwen huddle & assignment'}</h2></div><span className={`tb-huddle__status is-${stale ? 'unavailable' : huddle.phase || 'idle'}`}>{stale ? (zh ? '连接待恢复 · 上次检查快照' : 'Connection unavailable · last check snapshot') : huddlePhaseLabel(huddle, zh)}</span></div>
    <p className="tb-huddle__counts">{zh ? `可排查 ${summary.actionable} · 待你处理 ${summary.needsUser} · 待 Grok 核查 ${summary.grokCheck} · 实际处理 ${summary.working}` : `${summary.actionable} to investigate · ${summary.needsUser} need you · ${summary.grokCheck} await Grok · ${summary.working} working now`}</p>
    <div className="tb-huddle__times">{Number.isFinite(huddle.reviewedCount) && <span>{zh ? '本轮检查' : 'Reviewed this round'} <strong>{huddle.reviewedCount}{Number.isFinite(huddle.blockedCount) ? ` / ${huddle.blockedCount}` : ''}</strong></span>}<span>{zh ? '最近检查' : 'Last check'} <strong>{timeLabel(huddle.lastCheckedAt)}</strong></span><span>{zh ? '下次检查' : 'Next check'} <strong>{timeLabel(huddle.nextCheckAt)}</strong></span>{!stale && huddle.meeting?.active && <span>{zh ? '集结代表' : 'Delegates'} <strong>{attendees.map(huddleProviderLabel).join(' · ') || '—'}</strong></span>}</div>
    {huddle.error && <p className="tb-huddle__error" role="status">{String(huddle.error)}</p>}
    {discussion.length > 0 && <details className="tb-huddle__advice"><summary>{zh ? '查看 Qwen 建议与检查记录' : 'Qwen advice and check record'}</summary><p>{zh ? '以下为 Qwen 的建议或检查记录，未代表已执行或其他 AI 已发言；是否开始工作以当前执行器的对应任务记录为准。' : 'These are Qwen suggestions or check notes, not confirmation of execution or statements by other AIs. Execution requires a matching job in the current runner snapshot.'}</p>{discussion.map((entry, i)=><p key={i}>{typeof entry === 'string' ? entry : entry.text || entry.message || entry.content || ''}</p>)}</details>}
    {ownership.length > 0 && <details className="tb-huddle__ownership"><summary>{zh ? `受阻任务分工 · ${summary.active.length} 项待推进${pausedCount ? ` · ${pausedCount} 项已暂停留档` : ''}` : `Blocked-task next steps · ${summary.active.length} active${pausedCount ? ` · ${pausedCount} paused records` : ''}`}</summary>{board && <><div className="tb-category-tabs" role="group" aria-label={zh ? 'Qwen 任务分类' : 'Qwen task categories'}>{Object.entries(categoryLabels).map(([id, label]) => <button key={id} type="button" disabled={actions.busy} aria-pressed={category === id} onClick={() => { setCategory(id); actions.setChecked({}) }}>{label}</button>)}</div><TaskBulkControls actions={actions} scopeLabel={categoryLabels[category]}/></>}<ul className="tb-huddle__decisions">{shownOwnership.map(item => <li key={item.taskId}>
      {board && <label className="tb-card-select"><input type="checkbox" checked={!!actions.checked[item.taskId]} disabled={actions.busy} aria-label={`${zh ? '选择 Qwen 任务：' : 'Select Qwen task: '}${item.title}`} onChange={event => actions.select(tasks.find(task => task.id === item.taskId), event.target.checked)}/>{zh ? '选择' : 'Select'}</label>}
      <div><button type="button" className="tb-huddle__task-link" onClick={() => onSelectTask?.(item.taskId)} disabled={!onSelectTask}>{item.title || item.taskId}</button><span>{zh ? '协调跟进：' : 'Follow-up: '}{huddleProviderLabel(item.owner)} · {resolutionStateLabel(item.state, zh)}{item.executor && ` · ${zh ? '实际执行：' : 'Executing: '}${huddleProviderLabel(item.executor)}`}</span></div>
      <p>{zh ? '下一步：' : 'Next: '}{compactTaskText(item.nextAction, zh ? '等待协调员记录下一步。' : 'Awaiting the coordinator’s next step.')}</p>{item.nextAction && <details className="tb-huddle__source"><summary>{zh ? '完整行动记录' : 'Full next-action record'}</summary><pre>{typeof item.nextAction === 'string' ? item.nextAction : JSON.stringify(item.nextAction, null, 2)}</pre></details>}
      {progress(item.taskId)}
      {!['paused', 'user_denied'].includes(item.state) && <p>{zh ? '下次跟进：' : 'Next follow-up: '}{timeLabel(item.nextCheckAt)}</p>}
      {board && <div className="tb-card-actions">{Object.entries(actionLabels).map(([action,label]) => <button key={action} type="button" disabled={actions.busy} onClick={() => actions.run(action,[tasks.find(task => task.id === item.taskId)])}>{label}</button>)}</div>}
      {item.workTaskId && <button type="button" className="tb-huddle__task-link is-secondary" onClick={() => onSelectTask?.(item.workTaskId)} disabled={!onSelectTask}>{zh ? ({repair:'查看修复任务',review:'查看审查任务'}[item.workKind] || '查看排查任务') : ({repair:'View repair task',review:'View review task'}[item.workKind] || 'View investigation task')}</button>}
    </li>)}</ul></details>}
    {decisions.length > 0 ? <details className="tb-huddle__advice"><summary>{zh ? '本轮分工记录' : 'Decisions this round'}</summary><ul className="tb-huddle__decisions">{decisions.map((decision, i)=><li key={`${decision.taskId}:${i}`}><div><strong>{decision.title || decision.taskId}</strong><span>{huddleActionLabel(decision.action, zh)} · {huddleProviderLabel(decision.provider)} · {huddleQuotaLabel(decision.remainingPercent, zh)}</span></div><p>{compactTaskText(decision.reason, zh ? '打开任务查看完整记录。' : 'Open the task for the complete record.')}</p>{decision.reason && <details className="tb-huddle__source"><summary>{zh ? '完整分工依据' : 'Full assignment reason'}</summary><pre>{typeof decision.reason === 'string' ? decision.reason : JSON.stringify(decision.reason, null, 2)}</pre></details>}{progress(decision.taskId)}</li>)}</ul></details> : <p className="tb-huddle__empty">{zh ? '暂无分配结论。没有受阻任务时不会制造任务或安排讨论。' : 'No assignment decisions yet. An empty blocked board does not create work or discussions.'}</p>}
  </section>
}
