import { officeCapability } from './office-capabilities.js';
import { officeSnapshotStale } from './office-operations.js';
import { useOfficeDate } from './OfficeIdentity';
import { TaskBulkControls, useCardActions } from './TaskBulkControls.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, useLang } from './i18n';
import { officeAgentLabel, officeRoleLabel } from './unified-office.js'
import { containDialogFocus, filterBoardTasks, taskProjectDisplay, taskProjectKey, taskProjectName, taskProjects, taskWaitSummary } from './task-board-ui.js'
import { Activity, AlertCircle, ArrowRight, Check, CheckCircle2, ChevronDown, CircleDashed, ClipboardList, ExternalLink, FileText, Folder, ListPlus, LoaderCircle, Plus, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react'
import './task-board.css'
import HuddlePanel from './HuddlePanel.jsx'
import HumanRelayPanel from './HumanRelayPanel.jsx'
import DispatchConversation from './DispatchConversation.jsx'
import ParallelCapabilities from './ParallelCapabilities.jsx'
import LocalQwenDesk from './LocalQwenDesk.jsx'
import GeminiResearchDesk from './GeminiResearchDesk.jsx'
import { geminiResearchDraft, geminiSourcePrompt, geminiReadiness } from './gemini-desk.js'
import { qwenAssistanceDraft, qwenSourcePrompt } from './local-qwen-desk.js'
import { taskReviewStatus, taskReviewLabel } from './review-ui.js'
import { compactTaskText } from './task-card-content.js'
import { activeTaskJob, blockedOwnership, taskHumanStage, huddleProviderLabel, resolutionStateLabel } from './huddle-ui.js'

const EMPTY = { tasks: [], roles: [], instructions: [], settings: { autoPickup: false }, runtime: { providers: {}, running: [] }, grok: { configured: false, connected: false }, csrfToken: '' }
const COLUMNS = [{ id: 'pending', name: 'To do', Icon: CircleDashed }, { id: 'running', name: 'Working', Icon: Activity }, { id: 'blocked', name: 'Blocked', Icon: AlertCircle }, { id: 'done', name: 'Done', Icon: CheckCircle2 }]
import { LOCAL_QWEN_TYPES } from '../server/local-qwen-policy.mjs'
const PROVIDERS = { any: 'Any available agent', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini research (read-only)', grok: 'Grok Dispatch', 'grok-bot': 'Grok Bot', 'local-qwen': 'Local Qwen (preliminary only)' }
const BASE_ROLES = ['Facilitator', 'Admin', 'Helper', 'Tester']
const freshRequest = () => ({ title: '', description: '', projectPath: '', provider: 'any', supportType: 'log-triage', role: 'any', priority: 'normal' })
const textError = error => error instanceof Error ? error.message : String(error || 'The request could not be completed.')
const folderName = taskProjectName
const taskCounts = tasks => Object.fromEntries(COLUMNS.map(column => [column.id, tasks.filter(task => task.status === column.id).length]))
const roleNames = () => BASE_ROLES
const displayAssignee = value => { const label = officeAgentLabel(value); return label === value ? value : t(label) }
const assigneeName = assignee => displayAssignee(typeof assignee === 'string' ? assignee : assignee?.name || assignee?.label || assignee?.agentId || assignee?.id || '')
const resultText = result => typeof result === 'string' ? result : result ? JSON.stringify(result, null, 2) : ''
const newest = items => [...items].sort((a, b) => (Date.parse(b.createdAt || b.updatedAt) || 0) - (Date.parse(a.createdAt || a.updatedAt) || 0))

const roleLabel = (role, provider = 'any') => officeRoleLabel(role, provider === 'any' ? 'Codex' : provider === 'local-qwen' ? 'Local Qwen' : PROVIDERS[provider] || provider)
const priorityLabel = value => ({ high: 'High', low: 'Low', normal: 'Normal' }[value] || 'Normal')

function WaitSummary({ summary }) {
  return <span className="tb-task__reason"><span data-no-i18n={summary.customOwner || undefined}>{summary.customOwner ? displayAssignee(summary.owner) : summary.owner}</span><span aria-hidden="true"> · </span><span>{summary.wait}</span><span aria-hidden="true"> · </span><span>{summary.next}</span></span>
}

function ReviewBadge({ task, tasks = [] }) {
  const zh = useLang() === 'zh'
  const review = taskReviewStatus(task, tasks)
  return review ? <span className={`tb-review-badge is-${review.state}${review.historical ? ' is-historical' : ''}`} data-no-i18n>{taskReviewLabel(review, zh)}</span> : null
}

function ResolutionSummary({ task, detail = false, tasks = [], runtime = {}, humanRequests = [] }) {
  const dateLabel = useOfficeDate({ day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
  const zh = useLang() === 'zh'
  if (task.status !== 'blocked') return null
  const linkedIds = [task.resolution?.investigationTaskId, task.reviewRepairTaskId, task.reviewTaskId]
  const linked = tasks.filter(item => linkedIds.includes(item.id))
  const row = blockedOwnership([task, ...linked], runtime, humanRequests)[0]
  const resolution = task.resolution
  const fallback = zh ? '等待协调员检查并记录行动。' : 'Awaiting coordinator check and next action.'
  return <span className={`tb-resolution${detail ? ' is-detail' : ''}`} data-no-i18n>
    <strong>{zh ? '协调跟进：' : 'Follow-up: '}{row.owner ? huddleProviderLabel(row.owner) : (zh ? '待分配' : 'Unassigned')} · {resolutionStateLabel(row.state, zh)}</strong>
    {row.executor && <span>{zh ? '实际执行：' : 'Executing: '}{huddleProviderLabel(row.executor)}</span>}
    <span>{zh ? '下一步：' : 'Next: '}{detail ? resultText(resolution?.nextAction) || fallback : compactTaskText(resolution?.nextAction, fallback)}</span>
    {detail && !['paused', 'user_denied'].includes(row.state) && <small>{zh ? '下次跟进：' : 'Next follow-up: '}{dateLabel(resolution?.nextCheckAt) || '—'}</small>}
    {detail && resolution?.finding && <span>{zh ? '最新排查：' : 'Latest finding: '}{resultText(resolution.finding)}</span>}
    {detail && resolution?.investigationTaskId && <small>{zh ? '关联排查任务：' : 'Investigation task: '}{resolution.investigationTaskId}</small>}
  </span>
}

async function readResponse(response) {
  const source = await response.text()
  let data
  try { data = source ? JSON.parse(source) : {} } catch { throw new Error('The local studio service returned an unreadable response.') }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `The studio service returned ${response.status}.`)
  return data
}

export function useTaskBoard() {
  const [state, setState] = useState(EMPTY)
  const [dispatchDraft, setDispatchDraft] = useState({ text: '', projectPath: null, requestId: null })
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState(null)
  const [refreshError, setRefreshError] = useState('')
  const [lastSuccessAt, setLastSuccessAt] = useState(null)
  const [clock, setClock] = useState(Date.now)
  const [pending, setPending] = useState(0)
  const stateRef = useRef(EMPTY), mounted = useRef(true), sequence = useRef(0), requests = useRef(new Set())
  const refresh = useCallback(async (options = {}) => {
    const quiet = options.quiet === true
    const request = ++sequence.current
    const controller = new AbortController()
    requests.current.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15000)
    if (!quiet && mounted.current) setLoading(true)
    try {
      const response = await fetch('/api/office/board', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal })
      const data = await readResponse(response)
      const next = { ...EMPTY, ...data, tasks: Array.isArray(data.tasks) ? data.tasks : [], roles: Array.isArray(data.roles) ? data.roles : [], instructions: Array.isArray(data.instructions) ? data.instructions : [], settings: { ...EMPTY.settings, ...data.settings }, runtime: { ...EMPTY.runtime, ...data.runtime }, grok: { ...EMPTY.grok, ...data.grok } }
      if (mounted.current && request === sequence.current) {
        stateRef.current = next
        setState(next)
        setLastSuccessAt(Date.now())
        setRefreshError('')
        setFailure(previous => previous?.kind === 'refresh' ? null : previous)
      }
      return next
    } catch (error) {
      const failure = controller.signal.aborted ? new Error('The local studio service did not respond. Refresh and try again.') : error
      if (mounted.current && request === sequence.current) {
        setRefreshError(textError(failure))
        setFailure(previous => previous?.kind === 'mutation' ? previous : { kind: 'refresh', message: textError(failure) })
      }
      if (options.throwOnError) throw failure
      return null
    } finally { clearTimeout(timeout); requests.current.delete(controller); if (mounted.current && request === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    refresh()
    const wake = () => { if (document.visibilityState !== 'hidden' && requests.current.size === 0) refresh({ quiet: true }) }
    const timer = setInterval(() => { setClock(Date.now()); wake() }, 4000)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); for (const controller of requests.current) controller.abort(); requests.current.clear() }
  }, [refresh])
  const mutate = useCallback(async (url, method, payload) => {
    const controller = new AbortController()
    requests.current.add(controller)
    const timeout = setTimeout(() => controller.abort(), 45000)
    if (mounted.current) setPending(count => count + 1)
    try {
      if (!stateRef.current.csrfToken) {
        const current = await refresh({ quiet: true, throwOnError: true })
        if (current) stateRef.current = current
      }
      if (!stateRef.current.csrfToken) throw new Error('The local studio service is not ready. Refresh and try again.')
      const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Office-Token': stateRef.current.csrfToken }, body: JSON.stringify(payload || {}), signal: controller.signal })
      const result = await readResponse(response)
      if (mounted.current) setFailure(null)
      await refresh({ quiet: true })
      return result
    } catch (error) {
      const failure = controller.signal.aborted ? new Error('The studio did not confirm the change. Refresh the board to check whether it was saved before retrying.') : error
      if (mounted.current) setFailure({ kind: 'mutation', message: textError(failure) })
      throw failure
    } finally { clearTimeout(timeout); requests.current.delete(controller); if (mounted.current) setPending(count => Math.max(0, count - 1)) }
  }, [refresh])
  const methods = useMemo(() => ({
    cardActions: (action, items) => mutate('/api/office/tasks/card-actions', 'POST', { action, items }),
    createTask: payload => mutate('/api/office/tasks', 'POST', payload),
    updateTask: (id, patch, version) => mutate(`/api/office/tasks/${encodeURIComponent(id)}`, 'PATCH', { ...patch, ...(version !== undefined ? { version } : {}) }),
    createRole: (payload, description) => mutate('/api/office/roles', 'POST', typeof payload === 'string' ? { name: payload, description: description || '' } : payload),
    sendInstruction: payload => mutate('/api/office/instructions', 'POST', payload),
    retryInstruction: id => mutate(`/api/office/instructions/${encodeURIComponent(id)}/retry`, 'POST', {}),
    updateSettings: payload => mutate('/api/office/settings', 'PATCH', payload),
    connectGrok: payload => mutate('/api/office/grok/connect', 'POST', payload),
    respondToQuestion: (id, payload) => mutate(`/api/office/human-requests/${encodeURIComponent(id)}/respond`, 'POST', payload),
    rerequestQuestion: (id, payload) => mutate(`/api/office/human-requests/${encodeURIComponent(id)}/rerequest`, 'POST', payload),
    configureGrokWake: payload => mutate('/api/office/grok/wake/config', 'POST', payload),
  }), [mutate])
  return { state, dispatchDraft, setDispatchDraft, loading, error: failure?.message || '', refreshError, lastSuccessAt, stale: officeSnapshotStale({ lastSuccessAt, refreshError }, Math.max(clock, Date.now())), pending: pending > 0, refresh, ...methods }
}

function ErrorNotice({ error, onRetry }) {
  return error ? <div className="tb-error" role="alert"><AlertCircle size={17}/><span>{error}</span>{onRetry && <button type="button" onClick={onRetry}><RefreshCw size={13}/> Refresh</button>}</div> : null
}

function ProviderReadiness({ runtime }) {
  return <div className="tb-readiness" aria-label="Agent readiness">{['codex', 'claude', 'gemini', 'local-qwen', 'grok-bot'].map(id => {
    if (id === 'grok-bot') return <span className="is-external" key={id}><ExternalLink size={11}/><span>Grok Bot</span><b>Managed in Grok Bot</b></span>
    const provider = runtime?.providers?.[id]
    const ready = id === 'gemini' ? geminiReadiness(provider) === 'ready' : provider?.available === true && provider?.authenticated === true
    const label = id === 'gemini' ? ({ready:'Ready','needs-login':'Sign-in needed',unavailable:'Unavailable',disabled:'Disabled','model-unavailable':'Configured model unavailable',unknown:'Status unconfirmed'})[geminiReadiness(provider)] : ready ? 'Ready' : provider?.available === true ? provider?.authenticated === false ? id === 'local-qwen' ? 'Model not installed' : 'Sign-in needed' : 'Checking' : 'Unavailable'
    return <span className={ready ? 'is-ready' : ''} key={id} title={provider?.reason || label}>{ready ? <CheckCircle2 size={11}/> : <AlertCircle size={11}/>}<span>{provider?.label || PROVIDERS[id]}</span><b>{label}</b></span>
  })}</div>
}

function LocalQwenFields({ value, onChange }) {
  if (value.provider !== 'local-qwen') return null
  return <><label className="tb-field">{t('Assistance type')}<select value={value.supportType || 'log-triage'} onChange={event => onChange({ ...value, supportType: event.target.value })}>{Object.entries(LOCAL_QWEN_TYPES).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label><p className="form-note">{t('Paste source text in Details. Image tags require a supplied caption; this model cannot see images. Results require human verification. No code, review or final deliverables.')}</p><p className="form-note">{t('Source limit: 20,000 characters or 24 KB of UTF-8 text, whichever comes first (about 8,000 Chinese characters).')}</p></>
}

function GrokBotNotice({ provider }) {
  return provider === 'grok-bot' ? <p className="tb-note tb-field--wide tb-grok-bot-note"><ExternalLink size={14}/><span>Grok Bot must claim this request in its app. Office auto pickup does not start it. Use Grok Dispatch for planning instructions.</span></p> : null
}

function RequestFields({ value, onChange, roles, includeTitle = true }) {
  const lang = useLang()
  const change = (key, next) => onChange({ ...value, [key]: next })
  return <>
    {includeTitle && <label className="tb-field">Request title<input required maxLength={200} value={value.title} onChange={event => change('title', event.target.value)} placeholder="What needs to get done?"/></label>}
    <label className="tb-field tb-field--wide">Details<textarea required={['local-qwen', 'gemini'].includes(value.provider)} rows={3} maxLength={20000} value={value.description} onChange={event => change('description', event.target.value)} placeholder={value.provider === 'gemini' ? geminiSourcePrompt(null, lang) : "Describe the result you want and any constraints."}/></label>
    {value.provider !== 'gemini' && <label className="tb-field tb-field--wide">Project folder<input maxLength={2048} value={value.projectPath} onChange={event => change('projectPath', event.target.value)} placeholder="/path/to/your/project" spellCheck={false}/></label>}
    <label className="tb-field">Agent<select value={value.provider} onChange={event => change('provider', event.target.value)}>{['any', 'claude', 'codex', 'gemini', 'local-qwen', 'grok-bot'].map(id => <option key={id} value={id}>{PROVIDERS[id]}</option>)}</select></label>
    <LocalQwenFields value={value} onChange={onChange}/>
    <GrokBotNotice provider={value.provider}/>
    <label className="tb-field">Role<select value={value.role} onChange={event => change('role', event.target.value)}><option value="any">Any role</option>{roleNames(roles).map(name => <option key={name} value={name}>{roleLabel(name, value.provider)}</option>)}</select></label>
    <label className="tb-field">Priority<select value={value.priority} onChange={event => change('priority', event.target.value)}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
  </>
}

export function TaskDetails({ task, board, roles, pendingReason, onClose, onOpenAgent }) {
  const runtime = board?.stale ? { ...(board.state.runtime || {}), agents: [], running: [], providers: {}, unavailable: true } : board.state.runtime
  const zh = useLang() === 'zh'
  const dateLabel = useOfficeDate({ day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => ({ ...freshRequest(), ...task }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = useRef()
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    const listener = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', listener)
    return () => { document.removeEventListener('keydown', listener); previous?.focus?.() }
  }, [onClose])
  useEffect(() => { if (!editing) setDraft({ ...freshRequest(), ...task }) }, [task.id, task.version, editing])
  const save = async (patch, version = task.version) => {
    setBusy(true); setError('')
    try { await board.updateTask(task.id, { ...patch, version }); setEditing(false) }
    catch (failure) { setError(textError(failure)) }
    finally { setBusy(false) }
  }
  const canEdit = officeCapability(board.state, 'taskActions') && ['pending', 'blocked'].includes(task.status)
  const assigned = assigneeName(task.assignee)
  const output = resultText(task.result)
  const StateIcon = COLUMNS.find(column => column.id === task.status)?.Icon || CircleDashed
  const reason = task.error ? resultText(task.error) : pendingReason
  const wait = taskWaitSummary(task, { reason, autoPickup: board.state.settings.autoPickup })
  return <div className="tb-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="tb-dialog" role="dialog" aria-modal="true" aria-labelledby="tb-task-heading" onKeyDown={containDialogFocus}>
      <button ref={close} type="button" className="tb-dialog__close" onClick={onClose} aria-label="Close request"><X size={19}/></button>
      <span className={`tb-state is-${task.status}`}><StateIcon size={12}/>{COLUMNS.find(column => column.id === task.status)?.name || task.status}</span>
      <h2 id="tb-task-heading" data-no-i18n>{task.title}</h2>
      <ReviewBadge task={task} tasks={board.state.tasks}/>
      <ErrorNotice error={error}/>
      {editing ? <form className="tb-edit-form" onSubmit={event => { event.preventDefault(); const { title, description, projectPath, provider, role, priority, supportType } = draft; save({ title, description, projectPath, provider, role, priority, supportType }, draft.version) }}>
        {draft.version !== task.version && <div className="tb-edit-conflict"><span>This request changed while you were editing.</span><button type="button" onClick={() => setDraft({ ...freshRequest(), ...task })}>Load latest request</button></div>}
        <RequestFields value={draft} onChange={setDraft} roles={roles}/>
        <div className="tb-dialog__actions"><button type="button" className="tb-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button className="tb-button tb-button--primary" disabled={busy}>{busy ? <LoaderCircle className="tb-spin" size={14}/> : <Check size={14}/>} Save request</button></div>
      </form> : <>
        {['pending', 'blocked'].includes(task.status) && <div className="tb-wait-details"><StateIcon size={15}/><div>{!(task.status === 'blocked' && task.resolution) && <WaitSummary summary={wait}/>} {reason && <details><summary>Full reason</summary><pre data-no-i18n>{reason}</pre></details>}</div></div>}
        <ResolutionSummary task={task} detail tasks={board.state.tasks} runtime={runtime} humanRequests={board.state.humanRequests}/>
        {task.description && <details className="tb-task-source" data-no-i18n><summary>{zh ? '完整任务指令' : 'Complete task instructions'}</summary><p className="tb-task-description">{task.description}</p></details>}
        <dl className="tb-task-facts"><div><dt>Project folder</dt><dd data-no-i18n={!!task.projectPath || undefined}>{taskProjectDisplay(task).detail}</dd></div><div><dt>Agent preference</dt><dd>{PROVIDERS[task.provider] || task.provider || 'Any available agent'}</dd></div><div><dt>Role / priority</dt><dd><span>{task.role === 'any' ? 'Any role' : roleLabel(task.role, task.provider) || 'Any role'}</span> · <span>{priorityLabel(task.priority)}</span></dd></div><div><dt>Assigned agent</dt><dd data-no-i18n={!!assigned || undefined}>{assigned || 'Not assigned'}</dd></div><div><dt>Requested by</dt><dd>{task.source === 'grok' ? 'Grok Dispatch' : 'You'}</dd></div><div><dt>Updated</dt><dd>{dateLabel(task.updatedAt || task.createdAt) || '—'}</dd></div></dl>
        {task.status === 'running' && <p className="tb-note" data-no-i18n><Activity size={14}/>{activeTaskJob(task, runtime) ? (zh ? '执行器已确认正在运行，结果会回写到这里。' : 'The runner confirms execution. Results will appear here.') : (zh ? '任务记录为运行中，但当前执行器尚无对应工作记录。' : 'Recorded as running; no matching job in the current runner snapshot.')}</p>}
        {task.status === 'done' && !assigned && <p className="tb-note">Marked done without an agent assignment.</p>}
        {output && <div className="tb-result"><h3><FileText size={15}/> Result</h3><pre data-no-i18n>{output}</pre></div>}
        <div className="tb-dialog__actions">
          {task.status === 'blocked' && wait.provider !== 'grok-bot' && onOpenAgent && <button type="button" className="tb-button" onClick={() => { onClose(); onOpenAgent(task, wait.provider) }}><ExternalLink size={14}/> Open agent</button>}
          {canEdit && <button type="button" className="tb-button" disabled={busy} onClick={() => setEditing(true)}>Edit request</button>}
          {task.status === 'blocked' && officeCapability(board.state, 'taskActions') && <button type="button" className="tb-button tb-button--primary" disabled={busy} onClick={() => save({ status: 'pending' })}>{busy ? <LoaderCircle className="tb-spin" size={14}/> : <RefreshCw size={14}/>} Retry request</button>}
        </div>
      </>}
    </section>
  </div>
}

function Kanban({ tasks, allTasks = tasks, runtime = {}, humanRequests = [], pending = [], autoPickup, onSelect, onOpenAgent, checked = {}, onCheck, onAction, busy, results = [], onStatusChange, statusFilter = 'all', readOnly = false }) {
  const zh = useLang() === 'zh'
  const columns = statusFilter !== 'all' ? COLUMNS.filter(column => column.id === statusFilter) : COLUMNS
  const [limits, setLimits] = useState({})
  return <div className={`tb-kanban tb-kanban--categories${statusFilter !== 'all' ? ' tb-kanban--blocked' : ''}`}>{columns.map(({ id, name, Icon }) => {
    const items = newest(tasks.filter(task => task.status === id))
    const shown = items.slice(0, limits[id] || 20)
    return <section id={`tb-column-${id}`} className={`tb-column is-${id} is-current`} key={id} aria-label={`${name} requests`}>
      <h3><Icon size={15}/>{name}<span>{items.length}</span></h3>
      <div className="tb-column__cards">{items.length ? shown.map(task => {
        const reason = resultText(task.error) || pending.find(item => item.taskId === task.id)?.reason || ''
        const wait = taskWaitSummary(task, { reason, autoPickup })
        const owner = assigneeName(task.assignee)
        const project = taskProjectDisplay(task)
        const review = taskReviewStatus(task, allTasks)
        return <article className={`tb-task${task.priority === 'high' ? ' is-high' : ''}`} key={task.id}>
          {!readOnly && <label className="tb-card-select" data-no-i18n><input type="checkbox" checked={task.status !== 'running' && !!checked[task.id]} disabled={busy || task.status === 'running'} onChange={event => onCheck(task, event.target.checked)} aria-label={`${zh ? '选择任务：' : 'Select task: '}${task.title}`}/>{zh ? '选择' : 'Select'}</label>}
          <button className="tb-task__open" type="button" onClick={() => onSelect(task.id)}>
            <span className="tb-task__top"><span>{task.role && task.role !== 'any' ? roleLabel(task.role, task.provider) : PROVIDERS[task.provider] || 'Any agent'}</span><b className={`tb-priority is-${task.priority || 'normal'}`}>{priorityLabel(task.priority)}</b></span>
            <strong data-no-i18n>{task.title}</strong>
            <ReviewBadge task={task} tasks={allTasks}/>
            {task.status === 'blocked' && taskHumanStage(task, humanRequests) && <span className="tb-question-badge" data-no-i18n>{taskHumanStage(task, humanRequests) === 'user_denied' ? (zh ? '已拒绝 · 保持受阻' : 'Denied · remains blocked') : taskHumanStage(task, humanRequests) === 'grok_check' ? (zh ? '待 Grok 核查' : 'Awaiting Grok check') : task.humanGate?.kind === 'approval' ? (zh ? '需要你确认 · 在上方问询区处理' : 'Approval needed · answer above') : (zh ? '资料待补充 · 在上方问询区处理' : 'Information needed · answer above')}</span>}
            {task.status === 'running' && <span className="tb-task__execution" data-no-i18n>{activeTaskJob(task, runtime) ? (zh ? '执行器已确认运行' : 'Runner confirms execution') : (zh ? '已记录运行 · 执行待确认' : 'Recorded running · execution unconfirmed')}</span>}
            <span className={`tb-task__project${project.needsProject && task.status === 'pending' ? ' needs-project' : ''}`}><Folder size={13}/><span data-no-i18n={!!task.projectPath || undefined}>{project.name}</span></span>
            <span className="tb-task__owner"><UsersRound size={12}/><span data-no-i18n={!!owner || undefined}>{owner && task.status === 'blocked' ? (zh ? `原执行人：${owner}` : `Previous assignee: ${owner}`) : owner || PROVIDERS[task.provider] || 'Not assigned'}</span></span>
            {['pending', 'blocked'].includes(task.status) ? (task.status === 'blocked' && task.resolution ? null : <WaitSummary summary={wait}/>) : task.description && <p data-no-i18n>{compactTaskText(task.description, zh ? '点击查看完整任务指令。' : 'Open the complete task instructions.')}</p>}
            <ResolutionSummary task={task} tasks={allTasks} runtime={runtime} humanRequests={humanRequests}/>
            <span className="tb-task__footer"><span><Icon size={11}/>{review && task.status === 'done' ? <span data-no-i18n>{taskReviewLabel(review, zh)}</span> : name}</span>{task.kind === 'review' ? <span>Review</span> : task.kind === 'research' ? <span>Research</span> : task.source === 'grok' ? <span><Sparkles size={11}/> Grok plan</span> : <span>Your request</span>}</span>
          </button>
          {!readOnly && <div className="tb-card-actions" data-no-i18n>
            <button type="button" disabled={busy || !['pending', 'blocked'].includes(task.status)} onClick={() => onAction('rerequest', [task])}>{zh ? '重新请求' : 'Request again'}</button>
            <button type="button" disabled={busy || !['pending', 'blocked'].includes(task.status)} onClick={() => onAction('deny', [task])}>{zh ? '拒绝' : 'Deny'}</button>
            <button type="button" disabled={busy || task.status === 'running'} onClick={() => onAction('delete', [task])}>{zh ? '删除任务' : 'Delete task'}</button>
          </div>}
          {task.status === 'running' && <small className="tb-card-feedback" data-no-i18n>{zh ? '执行中，结束后可操作' : 'Running; actions become available after it ends'}</small>}
          {results.find(item => item.id === task.id) && <small className="tb-card-feedback" data-no-i18n>{results.find(item => item.id === task.id).message}</small>}
          {task.status === 'blocked' && wait.provider !== 'grok-bot' && onOpenAgent && <button type="button" className="tb-task__agent" onClick={() => onOpenAgent(task, wait.provider)}><ExternalLink size={12}/> Open agent</button>}
        </article>
      }) : <div className="tb-column__empty">{id === 'pending' ? 'New requests appear here.' : id === 'running' ? 'No agent has a request in progress.' : id === 'blocked' ? 'Requests needing attention appear here.' : 'Completed requests appear here.'}</div>}</div>
      {items.length > 20 && <div className="tb-column__paging" data-no-i18n><span>{zh ? `已显示 ${shown.length} / ${items.length} 项` : `Showing ${shown.length} of ${items.length}`}</span>{shown.length < items.length && <button type="button" onClick={() => setLimits(previous => ({...previous,[id]:(previous[id] || 20) + 20}))}>{zh ? '再显示 20 项' : 'Show 20 more'}</button>}</div>}
    </section>
  })}</div>
}

function ActionableKanban({ board, ...props }) {
  const zh = useLang() === 'zh'
  const actions = useCardActions(board, newest(props.tasks))
  const readOnly = !officeCapability(board.state, 'taskActions')
  const { checked, select, run, busy, results } = actions
  const labels = zh ? { all: '全部任务', pending: '待处理', running: '执行中', blocked: '受阻', done: '已完成' } : { all: 'All tasks', pending: 'To do', running: 'Working', blocked: 'Blocked', done: 'Done' }
  return <>
    <div className="tb-category-tabs" role="group" aria-label={zh ? '任务分类' : 'Task categories'} data-no-i18n>{Object.entries(labels).map(([id, label]) => <button key={id} type="button" aria-pressed={props.statusFilter === id} disabled={busy} onClick={() => props.onStatusChange(id)}>{label}{props.categoryCounts && <b>{id === 'all' ? Object.values(props.categoryCounts).reduce((sum, count) => sum + count, 0) : props.categoryCounts[id]}</b>}</button>)}</div>
    {!readOnly && <TaskBulkControls actions={actions} scopeLabel={labels[props.statusFilter]}/>}
    {!readOnly && props.tasks.length > 20 && <p className="tb-pagination-note" data-no-i18n>{zh ? '每列先显示 20 项。全选涵盖当前筛选范围内最新的最多 100 项，包含尚未展开的任务；可继续展开核对。' : 'Each column starts with 20 cards. Select all includes the newest 100 matching tasks at most, including cards not expanded yet; load more to inspect them.'}</p>}
    <Kanban {...props} checked={checked} onCheck={select} onAction={run} busy={busy} results={results} readOnly={readOnly}/>
    {!readOnly && <details className="tb-trash" data-no-i18n><summary>{zh ? `已删除任务（${board.state.deletedTasks?.length || 0}）` : `Deleted tasks (${board.state.deletedTasks?.length || 0})`}</summary><p>{zh ? '删除保留历史。恢复后可检查问题或点击重新请求；不会自动批准。' : 'Deleted tasks retain their history. Restore a task to review it or request it again; restoring does not approve it.'}</p>{board.state.deletedTasks?.map(task => <div key={task.id}><span>{task.title}</span><button type="button" disabled={busy} onClick={() => run('restore', [task])}>{zh ? '恢复' : 'Restore'}</button></div>)}</details>}
  </>
}

function GrokConnection({ board }) {
  const grok = board.state.grok || EMPTY.grok
  const apiConnected = grok.apiConnected ?? grok.connected
  const [key, setKey] = useState(''), [model, setModel] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [change, setChange] = useState(false)
  useEffect(() => { if (apiConnected) setKey('') }, [apiConnected])
  // Configured offices use the Bot route; their server does not accept API keys.
  if (board.state.configuration) return null
  const status = apiConnected ? 'Connected' : grok.loading ? 'Verifying' : grok.configured ? 'Not verified' : 'Not connected'
  const models = Array.isArray(grok.models) ? grok.models.map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean) : []
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('')
    try { await board.connectGrok({ apiKey: key.trim(), ...(model.trim() ? { model: model.trim() } : {}) }); setKey(''); setChange(false) }
    catch (failure) { setError(textError(failure)) }
    finally { setBusy(false) }
  }
  return <details className="tb-api-route"><summary><ShieldCheck size={15}/><span>Optional xAI API connection</span>{apiConnected && <b>Connected</b>}<ChevronDown size={14}/></summary><section className="tb-panel tb-grok-connection">
    <div className="tb-panel__heading"><span className="tb-panel__icon"><ShieldCheck size={19}/></span><div><h3>Connect xAI API</h3><p>A connection route for local Grok planning.</p></div><span className={`tb-connection-state${apiConnected ? ' is-connected' : ''}`}><i/>{status}</span></div>
    {apiConnected && !change ? <><p className="tb-note">Connected on this Mac{grok.model ? ` · ${grok.model}` : ''}.</p><button type="button" className="tb-text-button" onClick={() => setChange(true)}>Change connection <Settings2 size={12}/></button></> : <>
      <p className="tb-body-copy">Connect with your own xAI API key to enable local planning. It is stored by the local server on this Mac. <a href="https://console.x.ai/" target="_blank" rel="noreferrer">Open xAI Console <ExternalLink size={11}/></a></p>
      <form onSubmit={submit} className="tb-connect-form" autoComplete="off">
        <label className="tb-field">xAI API key<input type="password" name="grok_api_key" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={key} onChange={event => setKey(event.target.value)} placeholder="Paste your API key"/></label>
        <label className="tb-field">Model <span>optional</span><input list="tb-grok-models" value={model} onChange={event => setModel(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Choose automatically"/>{models.length > 0 && <datalist id="tb-grok-models">{models.map(name => <option key={name} value={name}/>)}</datalist>}</label>
        <button className="tb-button tb-button--purple" disabled={busy || !key.trim()}>{busy ? <LoaderCircle className="tb-spin" size={14}/> : <ShieldCheck size={14}/>} {busy ? 'Verifying key…' : 'Connect xAI API'}</button>
      </form>
    </>}
    <ErrorNotice error={error || (!apiConnected ? resultText(grok.apiError ?? grok.error) : '')}/>
  </section></details>
}

function BotLocalConnection({ board }) {
  const dateLabel = useOfficeDate({ day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
  const command = board.state.runtime?.commandInterface || board.state.commandInterface
  const presence = board.state.grok?.bot
  const [expanded, setExpanded] = useState(false), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('')
  const available = Boolean(command?.projectPath && command?.scriptPath && command?.commands?.includes('apply-plan'))
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
  const executable = command?.scriptPath ? `node ${quote(command.scriptPath)}` : ''
  const taskInstructions = command?.commands?.includes('claim-next') ? `

Own task-board requests (separate from management instructions):
Read status and choose an eligible pending card whose provider is exactly "grok-bot". Create a local worker JSON file: {"worker":{"id":"grok-bot-main","name":"Grok Bot","provider":"grok-bot","providers":["grok-bot"],"roles":["any"],"projectPaths":["/actual/project/from/task"]}}. Use only the task's actual project folder.
${command.commands.includes('claim') ? `${executable} claim TASK_ID < /absolute/path/to/worker.json
Or claim the next eligible Grok Bot card:
` : ''}${executable} claim-next < /absolute/path/to/worker.json
The claim response contains task and claimToken. A null response means no eligible request was claimed, so do not start work. Keep the claim response and token only in local files, never in chat. Work only after a successful claim.
While working, send heartbeat every 20–30 seconds, with {"claimToken":"TOKEN_FROM_CLAIM"} in a local JSON file:
${executable} heartbeat TASK_ID < /absolute/path/to/heartbeat.json
When actually complete, use {"claimToken":"TOKEN_FROM_CLAIM","status":"done","result":"Actual result and evidence"}; if unable to continue, use status "blocked" and explain the error. Submit this local JSON file:
${executable} finish TASK_ID < /absolute/path/to/completion.json
Only finish the Grok Bot task you claimed. Do not finish other providers' tasks or mark planning as execution. Office auto pickup does not launch Grok Bot.
` : ''
  const instructions = available ? `Use the Studio command interface on this Mac as the Grok management team.\n\nOffice project: ${command.projectPath}\n\nRead the current board and queued instructions:\n${executable} status\n${executable} pending-instructions\n\nFor each requested instruction, prepare one JSON plan with these fields:\n- summary: a concise planning summary\n- roles: management roles with name, description and provider "grok"\n- tasks: bounded execution requests with title, description, projectPath, provider ("any", "codex", "claude", "gemini" or "grok-bot"), role ("any", "Facilitator", "Admin", "Helper", "Tester"), and priority ("normal", "high" or "low")\n\nUse the actual instruction ID from pending-instructions. Save the plan to a JSON file, then submit its contents through standard input:\n${executable} apply-plan INSTRUCTION_ID < /absolute/path/to/plan.json\n\n${command.commands.includes('bot-heartbeat') ? `Report your own actual presence through JSON standard input:\n${executable} bot-heartbeat < /absolute/path/to/bot-status.json\nUse a stable id and your actual name and role. The status object has {"id":"grok-bot-main","name":"Grok Bot","role":"Manager","status":"idle","activity":""}. While planning or working on a claimed Grok Bot task, report status "working" and your actual activity every 30 seconds; report "idle" when finished. Never report working merely to appear in the office.\n\n` : ''}Use only the project folder supplied in the instruction. Leave the path empty if none was supplied; do not invent a folder. Read the existing board and roles first, and avoid duplicate requests. Planning a coding task does not complete its execution. Do not mark other providers' execution requests done.${taskInstructions}\n` : ''
  const copy = async () => {
    setCopyError('')
    try { await navigator.clipboard.writeText(instructions); setCopied(true) }
    catch { setCopyError('Copy is unavailable here. Select and copy the setup text below.'); setExpanded(true) }
  }
  return <section className="tb-panel tb-bot-local">
    <div className="tb-panel__heading"><span className="tb-panel__icon"><Sparkles size={19}/></span><div><h3>Grok Bot · This Mac</h3><p>Use the installed Grok Bot with the local studio command interface.</p></div><span className={`tb-connection-state${presence?.connected ? ' is-connected' : ''}`}><i/>{presence?.connected ? 'Connected' : 'Local setup'}</span></div>
    <p className="tb-body-copy">Use Grok Bot’s local-computer command prompt and approve the requested command. A cloud browser cannot open this Mac’s localhost.</p>
    {available ? <><div className="tb-bot-local__actions"><button type="button" className="tb-button tb-button--purple" onClick={copy}>{copied ? <Check size={14}/> : <ClipboardList size={14}/>} {copied ? 'Copied setup' : 'Copy Bot setup'}</button><button type="button" className="tb-text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide setup' : 'View setup'} <ChevronDown size={12}/></button></div>{expanded && <pre className="tb-bot-setup" tabIndex={0}>{instructions}</pre>}</> : <p className="tb-note">The local command interface is starting. Refresh to load this Mac’s setup.</p>}
    <ErrorNotice error={copyError}/>
    {presence?.connected && <div className="tb-bot-presence">{presence.agents?.map(agent => <div key={agent.id}><i className={agent.status === 'working' ? 'is-working' : ''}/><strong>{agent.name}</strong><span>{agent.status === 'working' ? 'Working' : 'Idle'}</span></div>)}{presence.lastSeen && <small>Last seen {dateLabel(presence.lastSeen)}</small>}</div>}
  </section>
}

function Management({ board }) {
  const { state } = board
  const [role, setRole] = useState({ name: '', description: '' })
  const [addingRole, setAddingRole] = useState(false), [error, setError] = useState('')
  const addRole = async event => {
    event.preventDefault(); setAddingRole(true); setError('')
    try { await board.createRole({ name: role.name.trim(), description: role.description.trim() }); setRole({ name: '', description: '' }) }
    catch (failure) { setError(textError(failure)) }
    finally { setAddingRole(false) }
  }
  return <div className="tb-management">
    <div className="tb-management__main">
      <BotLocalConnection board={board}/>
      <DispatchConversation board={board}/>
      <ErrorNotice error={error}/>
    </div>
    <aside className="tb-management__side">
      <section className="tb-panel">
        <div className="tb-panel__heading"><span className="tb-panel__icon"><UsersRound size={18}/></span><div><h3>Team roles</h3><p>Add a role, or let Grok create one while planning.</p></div></div>
        <div className="tb-roles">{state.roles.map((item, index) => { const value = typeof item === 'string' ? { name: item } : item; return <article key={value.id || value.name || index}><strong data-no-i18n>{value.name}</strong>{value.description && <p data-no-i18n>{value.description}</p>}{value.source === 'grok' && <small>Created by Grok</small>}</article> })}{!state.roles.length && <p className="tb-muted">Roles created by you or Grok will appear here.</p>}</div>
        {officeCapability(state, 'roles') && <form className="tb-role-form" onSubmit={addRole}><label className="tb-field">Role name<input required maxLength={100} value={role.name} onChange={event => setRole({ ...role, name: event.target.value })} placeholder="e.g. Release coordinator"/></label><label className="tb-field">Purpose<textarea rows={2} maxLength={2000} value={role.description} onChange={event => setRole({ ...role, description: event.target.value })} placeholder="What should this role handle?"/></label><button className="tb-button" disabled={addingRole || !role.name.trim()}>{addingRole ? <LoaderCircle className="tb-spin" size={13}/> : <Plus size={13}/>} Add role</button></form>}
      </section>
      <GrokConnection board={board}/>
    </aside>
  </div>
}

export function TaskBoardSummary({ board, onOpen, onManagement }) {
  const tasks = board?.state?.tasks || [], counts = taskCounts(tasks)
  return <section className="tb-summary"><div className="tb-summary__heading"><ClipboardList size={18}/><h3>Task board</h3></div><div className="tb-summary__counts">{COLUMNS.map(column => <div key={column.id}><strong>{board?.loading ? '—' : counts[column.id]}</strong><small>{column.name}</small></div>)}</div>{board?.error && <p className="tb-summary__error" role="status">{board.error}</p>}<button className="tb-text-button" type="button" onClick={onOpen}>Open task board <ArrowRight size={13}/></button><button className="tb-summary__management" type="button" onClick={onManagement}><Sparkles size={14}/><span>Grok Dispatch<small>{board?.state?.grok?.connected ? 'Connected' : board?.state?.configuration ? 'Set up Grok Bot' : 'Set up Grok Bot or xAI API'}</small></span><ArrowRight size={13}/></button></section>
}

function NewRequest({ board, projectPath, provider = 'any', assistanceType, researchType, onClose }) {
  const lang = useLang()
  const [form, setForm] = useState(() => ({ ...freshRequest(), projectPath: projectPath || board.state.configuration?.workspace || '', provider: PROVIDERS[provider] && provider !== 'grok' ? provider : 'any', ...(assistanceType ? qwenAssistanceDraft(assistanceType) : {}), ...(assistanceType ? { title: t(LOCAL_QWEN_TYPES[assistanceType]) } : {}), ...(researchType ? geminiResearchDraft(researchType, lang) : {}) }))
  const [expanded, setExpanded] = useState(provider === 'grok-bot' || provider === 'local-qwen' || provider === 'gemini' || !!assistanceType || !!researchType)
  const [creating, setCreating] = useState(false)
  const input = useRef()
  const titleId = 'tb-new-request-heading'
  useEffect(() => {
    const previous = document.activeElement
    input.current?.focus()
    const listener = event => { if (event.key === 'Escape' && !creating) onClose() }
    document.addEventListener('keydown', listener)
    return () => { document.removeEventListener('keydown', listener); previous?.focus?.() }
  }, [onClose, creating])
  const create = async event => {
    event.preventDefault(); setCreating(true)
    try {
      await board.createTask({ ...form, title: form.title.trim(), projectPath: form.projectPath.trim() })
      onClose()
    } catch { /* Preserve the draft; the board hook exposes the failure. */ }
    finally { setCreating(false) }
  }
  return <div className="tb-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !creating) onClose() }}>
    <section className="tb-dialog tb-new-request" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={containDialogFocus}>
      <button type="button" className="tb-dialog__close" disabled={creating} onClick={onClose} aria-label="Close new request"><X size={19}/></button>
      <h2 id={titleId}>New request</h2>
      <form onSubmit={create}>
        <div className="tb-new-request__fields">
          <label className="tb-field">Request title<input ref={input} required maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="What needs to get done?"/></label>
          <label className="tb-field">Priority<select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
          {form.provider !== 'gemini' && <label className="tb-field tb-field--wide">Project folder<input maxLength={2048} value={form.projectPath} onChange={event => setForm({ ...form, projectPath: event.target.value })} placeholder="/path/to/your/project" spellCheck={false}/></label>}
        </div>
        <button type="button" className="tb-details-toggle" aria-expanded={expanded} aria-controls="tb-new-request-advanced" onClick={() => setExpanded(!expanded)}>Advanced <ChevronDown size={13}/></button>
        {expanded && <div id="tb-new-request-advanced" className="tb-advanced">
          <label className="tb-field tb-field--wide">Details<textarea required={['local-qwen', 'gemini'].includes(form.provider)} maxLength={20000} rows={5} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder={form.provider === 'local-qwen' ? qwenSourcePrompt(form.supportType, lang) : form.provider === 'gemini' ? geminiSourcePrompt(researchType, lang) : "Describe the result you want and any constraints."}/></label>
          <label className="tb-field">Agent preference<select value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value })}>{['any', 'claude', 'codex', 'gemini', 'local-qwen', 'grok-bot'].map(id => <option key={id} value={id}>{PROVIDERS[id]}</option>)}</select></label>
          <LocalQwenFields value={form} onChange={setForm}/>
          {form.provider === 'gemini' && <p className="form-note tb-field--wide" data-no-i18n>{lang === 'zh' ? '填写研究问题、版本、日期及约束。结果保存为带来源的只读研究笔记，不修改项目；代码实现与审查另交负责人。' : 'Supply research questions, versions, dates and constraints. Results become sourced, read-only research notes; implementation and review remain with their owners.'}</p>}
          <GrokBotNotice provider={form.provider}/>
          <label className="tb-field">Role<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="any">Any role</option>{roleNames(board.state.roles).map(name => <option key={name} value={name}>{roleLabel(name, form.provider)}</option>)}</select></label>
        </div>}
        <ErrorNotice error={board.error}/>
        <div className="tb-dialog__actions"><button type="button" className="tb-button" disabled={creating} onClick={onClose}>Cancel</button><button className="tb-button tb-button--primary" disabled={creating || !form.title.trim() || ['local-qwen', 'gemini'].includes(form.provider) && !form.description.trim()}>{creating ? <LoaderCircle className="tb-spin" size={14}/> : <Plus size={14}/>} {creating ? 'Adding…' : 'Add request'}</button></div>
      </form>
    </section>
  </div>
}

export function TaskProjects({ board, onOpenAgent }) {
  const [projectPath, setProjectPath] = useState(null)
  const projects = taskProjects(board?.state?.tasks || [],board?.state?.projectCatalog || [])
  if (projectPath !== null) return <div className="tb-project-view">
    <button type="button" className="tb-button tb-project-back" onClick={() => setProjectPath(null)}>← Back to projects</button>
    <TaskBoard key={projectPath} board={board} initialProjectPath={projectPath} onOpenAgent={onOpenAgent}/>
  </div>
  return <section className="tb-projects" aria-label="Project task boards">
    <h2>Project task boards</h2><p>Choose a project to see its requests.</p>
    <ErrorNotice error={board?.error} onRetry={() => board?.refresh()}/>
    {board?.loading && !projects.length ? <p role="status">Loading the task board…</p> : projects.length ? <div className="tb-project-grid">{projects.map(project => <button type="button" className="tb-project-card" key={project.key} title={project.folders.length > 1 ? project.folders.join('\n') : undefined} onClick={() => setProjectPath(project.path)}>
      <Folder size={20}/><strong data-no-i18n={!!project.path || undefined}>{project.name}</strong><span className="tb-project-card__count">{project.count}</span>
      {project.path && <small data-no-i18n>{project.path}</small>}
      {project.folders.length > 1 && <small>{`${project.folders.length} folders, including worktrees`}</small>}
      <span>Open task board <ArrowRight size={13}/></span>
    </button>)}</div> : <p>No project requests yet. Add a request with a project folder.</p>}
  </section>
}

export default function TaskBoard({ board, initialTab = 'board', initialProjectPath = null, initialStatus = 'all', initialTaskId = null, onOpenAgent }) {
  const zh = useLang() === 'zh'
  const [setting, setSetting] = useState(false)
  const [newRequest, setNewRequest] = useState(false)
  const [assistanceType, setAssistanceType] = useState(null)
  const [researchType, setResearchType] = useState(null)
  const [selectedId, setSelectedId] = useState(initialTaskId)
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState(initialStatus)
  const [projectFilter, setProjectFilter] = useState(initialProjectPath)
  const closeDetails = useCallback(() => setSelectedId(null), [])
  const closeNewRequest = useCallback(() => { setNewRequest(false); setAssistanceType(null); setResearchType(null) }, [])
  useEffect(() => { setNewRequest(false) }, [initialTab])
  const state = board?.state || EMPTY
  const runtime = board?.stale ? { ...(state.runtime || {}), agents: [], running: [], providers: {}, unavailable: true } : state.runtime
  const readOnly = !officeCapability(state, 'taskActions')
  const changePickup = async () => {
    setSetting(true)
    try { await board.updateSettings({ autoPickup: !state.settings.autoPickup }) } catch { /* Displayed by the hook. */ }
    finally { setSetting(false) }
  }
  const projects = taskProjects(state.tasks,state.projectCatalog || [])
  // Preserve the current selection even if its last task moves to another project.
  const projectFilterKey = projectFilter === null ? null : taskProjectKey(projectFilter,state.projectCatalog || [])
  if (projectFilter !== null && !projects.some(project => project.key === projectFilterKey)) projects.push({ key: projectFilterKey, path: projectFilter, name: folderName(projectFilter), count: 0, folders: [projectFilter] })
  const tasks = filterBoardTasks(state.tasks, { projectPath: projectFilter, provider: providerFilter, status: statusFilter, catalog: state.projectCatalog || [] })
  const selected = state.tasks.find(task => task.id === selectedId)
  return <section className="task-board">
    <div className="tb-heading"><div><span className="section-kicker">{initialTab === 'management' ? 'DISPATCH' : 'TASKS'}</span><h1>{initialTab === 'management' ? 'Grok Dispatch' : statusFilter === 'blocked' ? 'Blocked board' : 'Task board'}<span>.</span></h1><p>{initialTab === 'management' ? 'Give Grok a goal to plan and dispatch.' : 'Add a request. Available agents can pick it up and report their result.'}</p></div><button type="button" className="tb-button" onClick={() => board?.refresh()} disabled={board?.loading}><RefreshCw className={board?.loading ? 'tb-spin' : ''} size={14}/> Refresh</button></div>
    <ErrorNotice error={board?.error} onRetry={() => board?.refresh()}/>
    {board?.stale && <p className="tb-stale-snapshot" role="status" data-no-i18n>{board.loading && !board.lastSuccessAt ? (zh ? '正在读取任务板…' : 'Loading the task board…') : board.lastSuccessAt ? (zh ? '当前显示上次任务快照，实时执行状态待重新连接确认。' : 'Showing the last task snapshot. Live execution awaits reconnection.') : (zh ? '任务板连接待恢复，尚未读取到快照。' : 'Task board connection unavailable; no snapshot received yet.')}</p>}
    {initialTab !== 'board' && officeCapability(state, 'humanQuestions') && <HumanRelayPanel requests={state.humanRequests} board={board} onSelectTask={setSelectedId}/>}
    {initialTab === 'board' ? <>
      <div className="tb-controls">
        <button type="button" className="tb-button tb-button--primary" disabled={!board || readOnly} onClick={() => setNewRequest(true)}><Plus size={14}/> New request</button>
        <div className="tb-pickup"><button type="button" role="switch" aria-checked={!!state.settings.autoPickup} aria-label="Automatic task pickup" disabled={setting || !board || !officeCapability(state, 'taskSettings')} onClick={changePickup}><span/></button><div><strong>Auto pickup</strong><p>{state.settings.autoPickup ? 'On' : 'Off'}</p></div></div>
        <label className="tb-provider-filter tb-project-filter">Projects<select disabled={board?.pending} aria-label="Filter requests by project" value={projectFilter === null ? 'all' : `project:${projectFilterKey}`} onChange={event => { setProjectFilter(event.target.value === 'all' ? null : projects.find(project => `project:${project.key}` === event.target.value)?.path ?? null); setSelectedId(null) }}>
          <option value="all">All projects</option>
          {projects.map(project => <option key={project.key} value={`project:${project.key}`} data-no-i18n={!!project.path || undefined}>{!project.path ? t(project.name) : project.key === project.path ? `${project.name} · ${project.path} (${project.count})` : `${project.name} (${project.count})`}</option>)}
        </select></label>
        <label className="tb-provider-filter">Show<select disabled={board?.pending} aria-label="Filter requests by agent" value={providerFilter} onChange={event => setProviderFilter(event.target.value)}><option value="all">All agents</option><option value="any">Any agent</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini</option><option value="local-qwen">Local Qwen</option><option value="grok-bot">Grok Bot</option></select></label>
      </div>
      {officeCapability(state, 'humanQuestions') && <HumanRelayPanel requests={state.humanRequests} board={board} onSelectTask={setSelectedId}/>}
      <GrokBotNotice provider={providerFilter}/>
      {board?.loading && !state.tasks.length ? <div className="tb-loading" role="status"><LoaderCircle className="tb-spin" size={20}/> Loading the task board…</div> : <ActionableKanban board={board} key={`${statusFilter}:${providerFilter}:${projectFilter}`} statusFilter={statusFilter} onStatusChange={setStatusFilter} tasks={tasks} allTasks={state.tasks} runtime={runtime} humanRequests={state.humanRequests} categoryCounts={taskCounts(filterBoardTasks(state.tasks, { projectPath: projectFilter, provider: providerFilter, catalog: state.projectCatalog || [] }))} pending={state.runtime?.pending || []} autoPickup={state.settings.autoPickup} onSelect={setSelectedId} onOpenAgent={onOpenAgent}/>}
      <LocalQwenDesk state={{...state, runtime}} readOnly={readOnly} stale={!!board?.stale} onCreate={type => { setResearchType(null); setAssistanceType(type); setNewRequest(true) }}/>
      <GeminiResearchDesk state={{...state, runtime}} readOnly={readOnly} stale={!!board?.stale} loading={board?.loading} onRefresh={() => board?.refresh()} onCreate={type => { setAssistanceType(null); setResearchType(type); setNewRequest(true) }}/>
      <HuddlePanel board={readOnly ? undefined : board} huddle={state.huddle} tasks={state.tasks} runtime={runtime} humanRequests={state.humanRequests} onSelectTask={setSelectedId}/>
      <details className="tb-runtime-settings"><summary data-no-i18n>{zh ? '助手连接与并行能力' : 'Connections and parallel capacity'}</summary><ProviderReadiness runtime={runtime}/><ParallelCapabilities capabilities={runtime?.parallelCapabilities}/></details>
    </> : readOnly ? <DispatchConversation board={board}/> : board ? <Management board={board}/> : <p className="tb-muted">The local studio service is not available.</p>}
    {newRequest && board && <NewRequest board={board} projectPath={projectFilter} provider={providerFilter} assistanceType={assistanceType} researchType={researchType} onClose={closeNewRequest}/>}
    {selected && <TaskDetails key={selected.id} task={selected} board={board} roles={state.roles} pendingReason={state.runtime?.pending?.find(item => item.taskId === selected.id)?.reason} onClose={closeDetails} onOpenAgent={onOpenAgent}/>}
  </section>
}
