import { requestId } from './request-id.js';
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLang } from './i18n'
import { humanRelayStateLabel, questionActionPayload, questionErrorMessage } from './human-relay-ui.js'
import { containDialogFocus } from './task-board-ui.js'

export default function HumanRelayPanel({ requests = [], board, onSelectTask }) {
  const zh = useLang() === 'zh'
  const [selected, setSelected] = useState(null)
  const [notice, setNotice] = useState('')
  const tasks = new Map((board?.state?.tasks || []).map(task => [task.id, task]))
  const current = requests.filter(request => ['pending', 'delivered', 'denied'].includes(request.state) &&
    tasks.get(request.taskId)?.status === 'blocked' && tasks.get(request.taskId)?.humanGate?.requestId === request.id)
  const needsYou = request => request.state === 'delivered' || request.kind === 'approval' || request.requiresUserAction || request.triage?.outcome === 'needs_user'
  const sorted = [...current].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)))
  const selectedCurrent = selected && requests.find(request => request.id === selected.id)
  return <section className="tb-coordination tb-human-relay" data-no-i18n aria-labelledby="tb-human-heading">
    <header className="tb-human-relay__heading"><h3 id="tb-human-heading">{zh ? '需要你处理' : 'Needs your attention'}</h3><span>{zh ? `${current.filter(q => q.state !== 'denied').length} 项可回复` : `${current.filter(q => q.state !== 'denied').length} open questions`}</span></header>
    <p>{zh ? '资料和决定都可以在这里回复。Grok 先查现有资料，能解决的直接交回负责人；解决不了才请你补充。每次回复只适用于对应任务。' : 'Reply here with information or a decision. Grok checks existing records first and asks you only for unresolved details. Each reply applies only to its linked task.'}</p>
    {notice && <p className="tb-question-notice" role="status">{notice}</p>}
    {sorted.length ? <ul className="tb-coordination__list tb-question-list">{sorted.map(request => <li key={request.id} className={needsYou(request) ? 'needs-user' : ''}>
      <div className="tb-coordination__row"><strong>{request.taskTitle || request.taskId}</strong><span className="tb-question-badge">{request.state === 'denied' ? (zh ? '已拒绝' : 'Declined') : request.kind === 'approval' ? (zh ? '等你决定' : 'Your decision') : needsYou(request) ? (zh ? '等你补资料' : 'Your information') : (zh ? '待 Grok 核查' : 'Grok to investigate')}</span></div>
      <p className="tb-question-preview">{request.triage?.outcome === 'needs_user' ? request.triage.summary : request.question}</p>
      <p className={`tb-human-relay__state is-${request.state}`}>{humanRelayStateLabel(request.state, zh)}</p>
      <div className="tb-question-actions">
        <button type="button" className="tb-button" onClick={() => setSelected(request)}>{request.state === 'denied' ? (zh ? '查看 / 重新请求' : 'View / request again') : request.kind === 'approval' ? (zh ? '查看并决定' : 'Review and decide') : (zh ? '填写资料 / 回复' : 'Add information / reply')}</button>
        <button type="button" className="tb-text-button" onClick={() => onSelectTask?.(request.taskId)} disabled={!onSelectTask}>{zh ? '原任务' : 'Original task'}</button>
      </div>
    </li>)}</ul> : <p>{zh ? '暂时没有需要你补充或确认的问题。' : 'No questions need your information or confirmation.'}</p>}
    <GrokWakeSetup board={board} zh={zh}/>
    {selected && createPortal(<QuestionDialog key={selected.id + selected.questionHash} request={selected} current={selectedCurrent} board={board} zh={zh} onClose={() => setSelected(null)} onResult={setNotice}/>, document.body)}
  </section>
}

function QuestionDialog({ request, current, board, zh, onClose, onResult }) {
  const [reply, setReply] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const input = useRef(null)
  const submitting = useRef(false)
  const operation = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    input.current?.focus()
    const listener = event => { if (event.key === 'Escape' && !submitting.current) closeRef.current() }
    document.addEventListener('keydown', listener)
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => { clearInterval(timer); document.removeEventListener('keydown', listener); previous?.focus?.() }
  }, [])
  const changed = !current || current.questionHash !== request.questionHash || !['pending', 'delivered', 'denied'].includes(current.state)
  const reaskLimit = (current?.rerequestCount || 0) >= 5
  const cooldown = Math.max(0, Math.ceil((Date.parse(current?.rerequest?.at || '') + 60000 - clock) / 1000)) || 0
  const act = async action => {
    if (submitting.current || changed || result) return
    setError('')
    let payload
    try { payload = questionActionPayload(request, action, reply, projectPath, zh) }
    catch (e) { setError(e.message); return }
    // Reuse an operation ID on a network retry of the same exact answer.
    submitting.current = true; setBusy(true)
    try {
      const signature = JSON.stringify(payload)
      if (operation.current?.signature !== signature) operation.current = { signature, id: `office-ui:${requestId()}` }
      if (action === 'rerequest') await board.rerequestQuestion(request.id, { ...payload, operationId: operation.current.id })
      else await board.respondToQuestion(request.id, { ...payload, userMessageId: operation.current.id })
      const message = action === 'rerequest'
        ? (zh ? '已重新请求 Grok 核查。任务仍保持受阻，未视为批准或直接重跑。' : 'Grok has been asked to check again. The task remains blocked; this is not approval or a task retry.')
        : action === 'deny' ? (zh ? '已记录拒绝，任务保持受阻。' : 'Declined. The task stays blocked.')
          : (zh ? '回复已保存到原任务。负责人检查额度和运行条件后继续处理。' : 'Reply saved to the original task. Its owner will continue after checking capacity and runtime conditions.')
      setResult(message); onResult(message)
    } catch (e) { setError(questionErrorMessage(e.message, zh)) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <div className="tb-overlay tb-question-overlay" data-no-i18n onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="tb-dialog tb-question-dialog" role="dialog" aria-modal="true" aria-labelledby="tb-question-title" onKeyDown={containDialogFocus}>
      <button type="button" className="tb-dialog__close" onClick={onClose} disabled={busy} aria-label={zh ? '关闭问题' : 'Close question'}>×</button>
      <span className="tb-question-badge">{request.kind === 'approval' ? (zh ? '需要你的明确决定' : 'Your decision is needed') : (zh ? '补充资料' : 'Add information')}</span>
      <h2 id="tb-question-title">{request.taskTitle || request.taskId}</h2>
      <div className="tb-question-full">{request.question}</div>
      {request.triage && <details><summary>{zh ? 'Grok 已核查的内容' : 'What Grok checked'}</summary><p>{request.triage.summary}</p><pre>{request.triage.evidence}</pre></details>}
      {result ? <p role="status" className="tb-question-notice">{result}</p> : <>
        {changed && <p role="alert">{zh ? '问题已更新或已被处理，请关闭后打开最新问题。你的输入仍保留在此处。' : 'This question changed or was handled. Close and open the latest one. Your draft remains here.'}</p>}
        {request.state !== 'denied' && <>
          <label className="tb-field">{request.kind === 'approval' ? (zh ? '补充条件或拒绝原因（可选）' : 'Conditions or reason (optional)') : (zh ? '你的回复' : 'Your reply')}
            <textarea ref={input} value={reply} maxLength={7000} rows={5} disabled={busy || changed} onChange={e => setReply(e.target.value)} placeholder={zh ? '写清楚资料、位置或你的决定…' : 'Add the information, location or your decision…'}/>
          </label>
          {request.kind === 'info' && <details><summary>{zh ? '原项目目录已失效？提供新的目录' : 'Original project unavailable? Provide its replacement'}</summary>
            <label className="tb-field">{zh ? '已有项目的完整路径（也需写在回复中）' : 'Existing absolute project path (also include it in your reply)'}<input value={projectPath} onChange={e => setProjectPath(e.target.value)} disabled={busy || changed} placeholder="/absolute/project/path"/></label>
          </details>}
          <p className="tb-question-hint">{request.kind === 'approval' ? (zh ? '点击“批准”只同意上面这项具体请求，并附上你填写的条件。' : 'Approve applies only to the request above, including your written conditions.') : (zh ? '提交资料不会批准其他操作。确认条件已恢复，也只会要求负责人重新核查。' : 'Information does not approve other actions. Confirming restoration asks the owner to verify again.')}</p>
          <div className="tb-question-actions">
            {request.kind === 'approval' ? <button type="button" className="tb-button" disabled={busy || changed} onClick={() => act('approve')}>{zh ? '批准这项请求' : 'Approve this request'}</button> : <>
              <button type="button" className="tb-button" disabled={busy || changed || !reply.trim()} onClick={() => act('provide_info')}>{zh ? '提交回复' : 'Submit reply'}</button>
              <button type="button" className="tb-text-button" disabled={busy || changed} onClick={() => act('restored')}>{zh ? '确认条件已恢复' : 'Confirm conditions restored'}</button>
            </>}
            <button type="button" className="tb-question-deny" disabled={busy || changed} onClick={() => act('deny')}>{zh ? '拒绝 / 暂不继续' : 'Decline / do not continue'}</button>
          </div>
        </>}
        <div className="tb-question-reask"><button ref={request.state === 'denied' ? input : undefined} type="button" className="tb-text-button" disabled={busy || changed || cooldown > 0 || reaskLimit} onClick={() => act('rerequest')}>{zh ? '重新请求' : 'Request again'}{cooldown > 0 ? ` (${cooldown}s)` : ''}</button><small>{reaskLimit ? (zh ? '已重新请求五次，请直接补充资料或作出决定。' : 'Requested five times. Please add information or make a decision.') : (zh ? '让 Grok 重新核查并说明问题；不会替你批准，也不会直接重跑任务。' : 'Ask Grok to check and clarify. This does not approve or rerun the task.')}</small></div>
      </>}
      {busy && <p role="status">{zh ? '正在保存…' : 'Saving…'}</p>}
      {error && <p role="alert" className="tb-question-error">{error}</p>}
      <details className="tb-question-identifiers"><summary>{zh ? '任务与问题编号' : 'Task and question IDs'}</summary><p>{request.taskId}</p><p>{request.id}</p></details>
      {result && <button type="button" className="tb-button" onClick={onClose}>{zh ? '完成' : 'Done'}</button>}
    </section>
  </div>
}

function GrokWakeSetup({ board, zh }) {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState('')
  const wake = board?.state?.grokWake
  const externallyConfigured = ['environment', 'env-file'].includes(wake?.source)
  const submit = async event => {
    event.preventDefault()
    if (saving || externallyConfigured || !board?.configureGrokWake) return
    let parsed
    try { parsed = new URL(url) } catch { setResult(zh ? '请输入有效的 HTTPS webhook 地址。' : 'Enter a valid HTTPS webhook URL.'); return }
    if (parsed.origin !== 'https://api2.cursor.sh' || parsed.username || parsed.password) { setResult(zh ? '只接受现有 Grok Bot 的 api2.cursor.sh HTTPS webhook 地址。' : 'Use the existing Grok Bot HTTPS webhook on api2.cursor.sh.'); return }
    setSaving(true); setResult('')
    try {
      await board.configureGrokWake({ url: url.trim(), token })
      setUrl(''); setToken('')
      setResult(zh ? '设置已保存到本机。' : 'Settings saved locally.')
    } catch { setResult(zh ? '保存失败，请检查地址、令牌和办公室连接后重试。' : 'Could not save. Check the URL, token and office connection, then retry.') }
    finally { setSaving(false) }
  }
  return <details className="tb-grok-wake" data-no-i18n>
    <summary>{zh ? '即时转告：本机设置' : 'Instant relay: local setup'} · {wake?.configured ? (zh ? '已配置' : 'Configured') : (zh ? '未配置' : 'Not configured')}</summary>
    <p>{zh ? '填入现有 Grok Bot 的唤醒 webhook 和令牌，仅保存在本机。未配置时保留 Grok 原有的每两小时查看；此设置不会改变该计划。' : 'Enter the existing Grok Bot wake-up webhook and token; these are stored locally. Without it, Grok retains its existing two-hour check. This setting does not change that schedule.'}</p>
    {wake?.configured && <p>{zh ? '已配置主机：' : 'Configured host: '}{wake.host || '—'}</p>}
    {wake?.error && <p role="status">{zh ? '最近的即时通知未成功，现有定时查看仍保留。' : 'The latest instant notification failed; the existing periodic check is retained.'}</p>}
    {externallyConfigured ? <p>{zh ? '当前由本机环境配置管理。修改环境变量或私有 grok-webhook.env 文件后重启办公室服务；此处不覆盖该配置。' : 'Managed by local environment configuration. Update the environment variables or private grok-webhook.env file, then restart the office service; this form does not override it.'}</p> : <form onSubmit={submit}>
      <label className="tb-field">{zh ? '现有 Grok webhook 地址' : 'Existing Grok webhook URL'}<input type="url" required autoComplete="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://api2.cursor.sh/…" disabled={saving}/></label>
      <label className="tb-field">{zh ? 'Webhook key（只填密钥，不含 Bearer）' : 'Webhook key (token only, without Bearer)'}<input type="password" required autoComplete="off" value={token} onChange={event => setToken(event.target.value)} disabled={saving}/></label>
      <button type="submit" className="tb-button" disabled={saving || !board?.configureGrokWake}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存到本机' : 'Save locally')}</button>
    </form>}
    {result && <p role="status">{result}</p>}
  </details>
}
