import React, { useEffect, useRef, useState } from 'react'
import { requestId } from './request-id.js'
import { selectedForScope } from './task-selection.js'
import { useLang } from './i18n'

export function useCardActions(board, tasks) {
  const zh = useLang() === 'zh'
  const [checked, setChecked] = useState({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const binding = task => ({ id: task.id, version: task.version, questionHash: board.state.humanRequests?.find(request => request.id === task.humanGate?.requestId)?.questionHash })
  // Selections bind to the version the user saw, never silently approve changed cards.
  const visibleIds = tasks.filter(task => task.status !== 'running').map(task => task.id).join('|')
  useEffect(() => { setChecked(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => tasks.some(task => task.id === id && task.status !== 'running')))) }, [visibleIds])
  const select = (task, value) => { if (task.status === 'running') return; setChecked(previous => { const next = { ...previous }; if (value && Object.keys(next).length < 100) next[task.id] = binding(task); else delete next[task.id]; return next }) }
  const run = async (action, targetTasks) => {
    if (busyRef.current) return
    const items = targetTasks ? targetTasks.map(binding) : selectedForScope(checked, tasks)
    if (!items.length) return
    busyRef.current = true; setBusy(true); setError(''); setResults([])
    try {
      const response = await board.cardActions(action, items.map(item => ({ ...item, operationId: requestId() })))
      const next = response.results.map(item => ({ ...item, title: [...tasks, ...(board.state.deletedTasks || [])].find(task => task.id === item.id)?.title || item.id, action, message: item.error }))
      setResults(next)
      setChecked(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !next.some(item => item.id === id && item.ok))))
    } catch (failure) { setError(`${zh ? '无法确认操作结果，请刷新核对后重试：' : 'Result unconfirmed. Refresh and check before retrying: '}${failure instanceof Error ? failure.message : String(failure)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const count = selectedForScope(checked, tasks).length
  const labels = zh
    ? { rerequest: '已重新请求', delete: '已移至已删除任务，可恢复', deny: '已拒绝，保留记录', restore: '已恢复任务记录' }
    : { rerequest: 'Requested again', delete: 'Moved to deleted tasks; can be restored', deny: 'Denied; record retained', restore: 'Task record restored' }
  return { checked, setChecked, select, run, busy, results: results.map(item => ({ ...item, message: item.ok ? labels[item.action] : item.message })), error, count, tasks: tasks.filter(task => task.status !== 'running'), binding }
}

export function TaskBulkControls({ actions, scopeLabel }) {
  const zh = useLang() === 'zh'
  const scope = scopeLabel || (zh ? '当前分类' : 'current category')
  const { checked, setChecked, run, busy, results, error, count, tasks, binding } = actions
  return <>
    <div className="tb-bulk-actions" data-no-i18n aria-label={zh ? '任务批量操作' : 'Bulk task actions'}>
      <label><input type="checkbox" disabled={busy || !tasks.length} checked={tasks.length > 0 && count === Math.min(tasks.length, 100)} onChange={event => setChecked(event.target.checked ? Object.fromEntries(tasks.slice(0, 100).map(task => [task.id, binding(task)])) : {})}/>{zh ? `全选${scope}（最多 100 项）` : `Select all ${scope} (up to 100)`}</label>
      <strong>{zh ? `已选 ${count} 项` : `${count} selected`}</strong>
      <button type="button" disabled={busy || !count} onClick={() => run('rerequest')}>{zh ? '一并重新请求' : 'Request selected again'}</button>
      <button type="button" disabled={busy || !count} onClick={() => run('delete')}>{zh ? '一并删除' : 'Delete selected'}</button>
      <button type="button" disabled={busy || !count} onClick={() => run('deny')}>{zh ? '一并拒绝' : 'Deny selected'}</button>
      <button type="button" disabled={busy || !count} onClick={() => setChecked({})}>{zh ? '取消选择' : 'Clear selection'}</button>
      {busy && <span role="status">{zh ? '正在逐项处理…' : 'Processing selected tasks…'}</span>}
    </div>
    <div role="alert">{error}</div>
    {!!results.length && <div className="tb-action-results" role="status" data-no-i18n><strong>{zh ? `成功 ${results.filter(item => item.ok).length} 项 · 未处理 ${results.filter(item => !item.ok).length} 项` : `${results.filter(item => item.ok).length} succeeded · ${results.filter(item => !item.ok).length} not processed`}</strong><details><summary>{zh ? '查看逐项结果' : 'View each result'}</summary><ul>{results.map((item, index) => <li key={`${item.id}-${index}`}>{item.title}{zh ? '：' : ': '}{item.message}</li>)}</ul></details></div>}
  </>
}
