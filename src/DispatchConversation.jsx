import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from './i18n';
import './dispatch-conversation.css';
import { requestId } from './request-id.js';
import GrokConversation from './GrokConversation.jsx';

export function dispatchMessages(state = {}) {
  const tasks = state.tasks || [];
  return [...(state.instructions || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id)).map(item => ({
    ...item,
    tasks: tasks.filter(task => task.managementRequestId === item.id || (item.taskIds || item.createdTaskIds || item.result?.taskIds || []).includes(task.id)),
    summary: item.summary || item.result?.summary || item.plan?.summary || '',
  }));
}

export default function DispatchConversation({ board, compact = false, onOpenDispatch, lang: suppliedLang }) {
  const currentLang = useLang(), zh = (suppliedLang || currentLang) === 'zh';
  const state = board?.state || {}, messages = dispatchMessages(state);
  const readOnly = !board || (state.capabilities?.dispatchInstructions !== true && Boolean(state.configuration && state.configuration.mode !== 'enabled'));
  const [localDraft, setLocalDraft] = useState({ text: '', projectPath: null, requestId: null });
  const draft = board?.dispatchDraft || localDraft, setDraft = board?.setDispatchDraft || setLocalDraft;
  const text = draft.text, projectPath = draft.projectPath ?? state.configuration?.workspace ?? '';
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [follow, setFollow] = useState(true);
  const latestReply = messages.filter(item => item.summary && item.updatedAt).at(-1);
  const log = useRef(null), sending = useRef(false);
  const revision = messages.map(item => `${item.id}:${item.updatedAt}:${item.tasks.map(task => `${task.id}:${task.status}`).join(',')}`).join('|');
  useLayoutEffect(() => { if (follow && log.current) log.current.scrollTop = log.current.scrollHeight; }, [revision, follow]);
  useEffect(() => {
    if (!follow || !log.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; });
    observer.observe(log.current);
    return () => observer.disconnect();
  }, [follow]);
  const statusName = status => (zh ? { pending: '等待调度', running: '正在规划', done: '已规划', blocked: '需要处理' } : { pending: 'Queued', running: 'Planning', done: 'Planned', blocked: 'Needs attention' })[status] || status;
  const deliveryName = value => (zh ? { accepted: '通知通道已接受 · 等待 Bot 回写', queued: '已入队 · 等待通知 Bot', retrying: '通知失败 · 等待重试', failed: '通知失败 · 重试次数已用完', unconfigured: '未配置调度通知通道' } : { accepted: 'Notification accepted · awaiting bot reply', queued: 'Queued · awaiting notification', retrying: 'Notification failed · retry pending', failed: 'Notification failed · retries exhausted', unconfigured: 'Dispatch notification is not configured' })[value] || (zh ? '尚无通知记录' : 'No notification record');
  const taskStatus = status => (zh ? { pending: '待处理', running: '运行中', done: '已完成', blocked: '受阻' } : { pending: 'To do', running: 'Running', done: 'Done', blocked: 'Blocked' })[status] || status;
  async function send(event) {
    event.preventDefault();
    if (sending.current || board?.pending || readOnly || !text.trim()) return;
    sending.current = true; setBusy(true); setError(''); setSaved('');
    try {
      const payload = { text: text.trim(), projectPath: projectPath.trim() };
      const operationId = draft.requestId || requestId();
      setDraft(previous => ({ ...previous, requestId: operationId }));
      const result = await board.sendInstruction({ ...payload, requestId: operationId });
      setDraft(previous => previous.requestId === operationId ? { ...previous, text: '', requestId: null } : previous);
      setSaved(result?.instruction?.id || 'saved'); setFollow(true);
    } catch (failure) { setError(failure.message || String(failure)); }
    finally { sending.current = false; setBusy(false); }
  }
  async function retry(id) {
    if (sending.current || board?.pending || readOnly) return;
    sending.current = true; setBusy(true); setError('');
    try { await board.retryInstruction(id); }
    catch (failure) { setError(failure.message || String(failure)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <><GrokConversation lang={suppliedLang}/><section className={`dispatch-conversation${compact ? ' dc-compact' : ''}`} data-no-i18n aria-label={zh ? '调度台对话' : 'Dispatch conversation'}>
    <header className="dc-heading"><div><h2>{zh ? '调度台对话' : 'Dispatch conversation'}</h2><p>{zh ? '这里同步办公室指令队列与 Bot 回写的规划，不是 Grok 私人聊天镜像。' : 'Shows the office instruction queue and bot planning replies, not a mirror of private Grok chats.'}</p></div>{onOpenDispatch && <button type="button" onClick={onOpenDispatch}>{zh ? '打开调度台 ↗' : 'Open dispatch ↗'}</button>}</header>
    <div className="dc-toolbar"><span>{state.grok?.connected ? (zh ? '调度连接在线' : 'Dispatch connected') : state.grokWake?.configured ? (zh ? '通知通道已配置 · 按指令唤醒' : 'Notification configured · wakes on instructions') : readOnly ? (zh ? '调度未连接' : 'Dispatch offline') : (zh ? '调度未连接 · 指令可排队' : 'Dispatch offline · instructions can queue')}</span><button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? (zh ? '正在跟随' : 'Following latest') : (zh ? '跟随最新' : 'Follow latest')}</button></div>
    <div className="dc-toolbar"><span>{zh ? '队列最近读取：' : 'Queue last read: '}{state.dispatchSync?.checkedAt ? new Date(state.dispatchSync.checkedAt).toLocaleTimeString() : (zh ? '未确认' : 'Unconfirmed')} · {zh ? '每 4 秒刷新' : 'Refreshes every 4 seconds'}</span><button type="button" disabled={busy || board?.loading} onClick={() => board?.refresh?.()}>{zh ? '立即同步' : 'Sync now'}</button></div>
    {!state.grok?.connected && <p className="dc-note">{zh ? '当前没有有效的 Grok 心跳；已配置通知时，新指令仍可唤醒 Bot。Webhook 接受通知不代表 Bot 已读取、回复或开始执行；回复以实际回写为准。' : 'No current Grok heartbeat. New instructions can still wake the bot through a configured notification channel. Webhook acceptance does not mean the bot has read, replied or started work; only actual replies are shown.'}</p>}
    {latestReply && <p className="dc-note">{zh ? '最近实际回写：' : 'Last actual reply: '}{new Date(latestReply.updatedAt).toLocaleString()}</p>}
    {state.dispatchSync?.notification?.error && <p className="dc-error" role="alert">{zh ? '调度通知失败：' : 'Dispatch notification failed: '}{state.dispatchSync.notification.error}</p>}
    {board?.error && <p className="dc-error" role="alert">{zh ? '同步异常：' : 'Sync error: '}{board.error}</p>}
    <div className="dc-log" tabIndex={0} ref={log} aria-label={zh ? '调度对话记录' : 'Dispatch history'} onScroll={event => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight > 35) setFollow(false); }}>
      {messages.map(item => <article className="dc-thread" key={item.id} data-instruction-id={item.id}>
        <div className="dc-message dc-user"><div><strong>{zh ? '你的指令' : 'Your instruction'}</strong><span>{statusName(item.status)}</span><time>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</time></div><pre>{item.text || item.instruction}</pre>{item.projectPath && <small>{item.projectPath}</small>}<small>{item.id}</small></div>
        {item.status === 'pending' && <p className="dc-note">{state.dispatchSync?.plannerConnected ? (zh ? '等待 API 调度规划' : 'Awaiting API planning') : deliveryName(state.dispatchSync?.delivery?.[item.id]?.state)}</p>}
        {item.summary && <div className="dc-message dc-reply"><strong>{zh ? '调度回复' : 'Dispatch reply'}</strong><pre>{typeof item.summary === 'string' ? item.summary : JSON.stringify(item.summary, null, 2)}</pre></div>}
        {item.tasks.length > 0 && <ul className="dc-tasks">{item.tasks.map(task => <li key={task.id}><span>{taskStatus(task.status)}</span><strong>{task.title}</strong><small>{task.provider}</small>{task.error && <p>{task.error}</p>}{task.result && <details><summary>{zh ? '执行结果' : 'Result'}</summary><pre>{typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}</pre></details>}</li>)}</ul>}
        {item.error && <p className="dc-error">{item.error}</p>}
        {item.status === 'blocked' && !readOnly && <button type="button" className="dc-retry" disabled={busy} onClick={() => retry(item.id)}>{zh ? '重新请求规划' : 'Retry planning'}</button>}
      </article>)}
      {!messages.length && <p className="dc-empty">{board?.loading ? (zh ? '正在同步对话…' : 'Syncing conversation…') : (zh ? '暂无指令。你发送的请求和调度回复会出现在这里。' : 'No instructions yet. Requests and dispatch replies will appear here.')}</p>}
    </div>
    <form className="dc-compose" onSubmit={send}>
      <label>{zh ? '新指令' : 'New instruction'}<textarea required rows={compact ? 2 : 3} maxLength={20000} value={text} disabled={readOnly || busy || board?.pending} onChange={event => { setDraft(previous => ({ ...previous, text: event.target.value, requestId: null })); setSaved(''); }} placeholder={zh ? '告诉调度台要做什么、由谁处理，以及验收要求…' : 'Describe the work, preferred agent and acceptance criteria…'}/></label>
      <div className="dc-compose-bottom"><label>{zh ? '项目目录' : 'Project folder'}<input maxLength={2048} value={projectPath} disabled={readOnly || busy || board?.pending} onChange={event => { setDraft(previous => ({ ...previous, projectPath: event.target.value, requestId: null })); }} placeholder="/path/to/project" spellCheck={false}/></label><button type="submit" disabled={readOnly || busy || board?.pending || board?.loading || !text.trim()}>{busy ? (zh ? '提交中…' : 'Submitting…') : (zh ? '发送指令' : 'Send instruction')}</button></div>
      <p className="dc-note">{readOnly ? (zh ? '当前为只读预览，可以查看对话；发送需在已启用的办公室中使用。' : 'Read-only preview. Sending is available in an enabled office.') : state.grok?.apiConnected ? (zh ? '提交后由调度台规划；关联任务的实际进度会同步显示。' : 'Dispatch will plan the instruction; actual linked task progress is shown here.') : (zh ? '发送后保存到办公室队列，并通过已配置的 webhook 通知 Grok Bot。Bot 必须读取队列并回写规划，这里才会显示真实回复。' : 'Saves to the office queue and notifies Grok Bot through the configured webhook. A real reply appears only after the bot reads the queue and writes its plan back.')}</p>
      {saved && <p className="dc-success" role="status">{zh ? '已保存到调度台，等待处理。' : 'Saved to dispatch; awaiting processing.'}</p>}
      {error && <p className="dc-error" role="alert">{error}</p>}
    </form>
  </section></>;
}
