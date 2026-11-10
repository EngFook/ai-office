import React, { useEffect, useRef, useState } from 'react'
import { requestId } from './request-id.js'
import { selectedForScope } from './task-selection.js'

export function useCardActions(board, tasks) {
  const [checked, setChecked] = useState({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const binding = task => ({ id: task.id, version: task.version, questionHash: board.state.humanRequests?.find(request => request.id === task.humanGate?.requestId)?.questionHash })
  // Selections bind to the version the user saw, never silently approve changed cards.
  const visibleIds = tasks.map(task => task.id).join('|')
  useEffect(() => { setChecked(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => tasks.some(task => task.id === id)))) }, [visibleIds])
  const select = (task, value) => setChecked(previous => { const next = { ...previous }; if (value && Object.keys(next).length < 100) next[task.id] = binding(task); else delete next[task.id]; return next })
  const run = async (action, targetTasks) => {
    if (busyRef.current) return
    const items = targetTasks ? targetTasks.map(binding) : selectedForScope(checked, tasks)
    if (!items.length) return
    busyRef.current = true; setBusy(true); setError(''); setResults([])
    try {
      const response = await board.cardActions(action, items.map(item => ({ ...item, operationId: requestId() })))
      const labels = { rerequest: '已重新请求', delete: '已移至已删除任务，可恢复', deny: '已拒绝，保留记录', restore: '已恢复任务记录' }
      const next = response.results.map(item => ({ ...item, title: [...tasks, ...(board.state.deletedTasks || [])].find(task => task.id === item.id)?.title || item.id, message: item.ok ? labels[action] : item.error }))
      setResults(next)
      setChecked(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !next.some(item => item.id === id && item.ok))))
    } catch (failure) { setError(`无法确认操作结果，请刷新核对后重试：${failure instanceof Error ? failure.message : String(failure)}`) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const count = selectedForScope(checked, tasks).length
  return { checked, setChecked, select, run, busy, results, error, count, tasks, binding }
}

export function TaskBulkControls({ actions, scopeLabel = '当前分类' }) {
  const { checked, setChecked, run, busy, results, error, count, tasks, binding } = actions
  return <>
    <div className="tb-bulk-actions" data-no-i18n aria-label="任务批量操作">
      <label><input type="checkbox" disabled={busy || !tasks.length} checked={tasks.length > 0 && count === Math.min(tasks.length, 100)} onChange={event => setChecked(event.target.checked ? Object.fromEntries(tasks.slice(0, 100).map(task => [task.id, binding(task)])) : {})}/>全选{scopeLabel}（最多 100 项）</label>
      <strong>已选 {count} 项</strong>
      <button type="button" disabled={busy || !count} onClick={() => run('rerequest')}>一并重新请求</button>
      <button type="button" disabled={busy || !count} onClick={() => run('delete')}>一并删除</button>
      <button type="button" disabled={busy || !count} onClick={() => run('deny')}>一并拒绝</button>
      <button type="button" disabled={busy || !count} onClick={() => setChecked({})}>取消选择</button>
      {busy && <span role="status">正在逐项处理…</span>}
    </div>
    <div role="alert">{error}</div>
    {!!results.length && <div className="tb-action-results" role="status" data-no-i18n><strong>成功 {results.filter(item => item.ok).length} 项 · 未处理 {results.filter(item => !item.ok).length} 项</strong><details><summary>查看逐项结果</summary><ul>{results.map((item, index) => <li key={`${item.id}-${index}`}>{item.title}：{item.message}</li>)}</ul></details></div>}
  </>
}
