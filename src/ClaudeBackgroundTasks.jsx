import React, { useEffect, useState } from 'react';
import { claudeUncertaintyLabel } from './claude-execution.js';
import { createClaudeLiveFeed } from './claude-live.js';

export default function ClaudeBackgroundTasks({ lang = 'zh', selectedSession, onSessionChange }) {
  const zh = lang === 'zh';
  const [filter, setFilter] = useState('running'), [kind, setKind] = useState('all'), [localSession, setLocalSession] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const session = selectedSession ?? localSession;
  const setSession = onSessionChange || setLocalSession;
  const [scope, setScope] = useState('current');
  const [state, setState] = useState({ data: null, error: false });
  const names = zh ? { running: '运行中（最后记录）', stalled: '受阻（最后记录）', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态待确认', all: '全部状态' } : { running: 'Running (last recorded)', stalled: 'Stalled (last recorded)', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', unknown: 'Unconfirmed', all: 'All states' };
  const kinds = zh ? { all: '全部类型', command: '后台命令', foreground: '命令执行中（尚未返回）', workflow: '工作流', agent: '后台代理', monitor: '监视任务', unknown: '未识别类型' } : { all: 'All types', command: 'Commands', foreground: 'Pending command calls', workflow: 'Workflows', agent: 'Background agents', monitor: 'Monitors', unknown: 'Unknown type' };
  useEffect(() => {
    setState({ data: null, error: false });
    let sync;
    const params = new URLSearchParams({ status: filter, kind, scope, sessionId: session, search, offset: String(page * 60), limit: '60' });
    const feed = createClaudeLiveFeed({ url: `/api/claude/background-tasks?${params}`,
      validate: data => Array.isArray(data?.tasks),
      onSync: value => { sync = value; setState(previous => ({ ...previous, sync })); },
      onSnapshot: data => setState({ data, error: false, sync }),
      onError: () => setState(previous => ({ ...previous, error: true })),
    });
    void feed.start();
    return () => { void feed.stop(); };
  }, [filter, kind, scope, session, search, page]);
  const data = state.data;
  const stale = state.error || Boolean(data?.error) || Boolean(data && data.sessionId !== session);
  useEffect(() => { setPage(0); }, [session]);
  const change = setter => event => { setter(event.target.value); setPage(0); };
  return <section data-no-i18n className="cw-background" aria-label={zh ? 'Claude 后台任务' : 'Claude background tasks'}>
    <h2>{zh ? '后台命令与工作流' : 'Background commands & workflows'}</h2>
    <p>{zh ? '与上方代理面板使用同一个会话筛选。命令、监视任务、工作流分开计数；本次进程仅覆盖进程启动后的记录，历史记录不与原生当前运行数量混算。' : 'Uses the same session filter as the agent panels. Commands, monitors and workflows are separate counts. Current-process records and history are never combined for native running comparisons.'}</p>
    <p role="status">{state.error || data?.error ? (zh ? '同步失败：以下为旧记录，当前状态未确认。' : 'Sync failed: cached records; current status unconfirmed.') : !data || !data.initialScanComplete ? (zh ? `正在补齐历史记录… ${data?.progress.filesRead || 0} / ${data?.progress.filesTotal || '—'} 个文件` : `Indexing history… ${data?.progress.filesRead || 0} / ${data?.progress.filesTotal || '—'} files`) : (zh ? `${state.sync?.transport === 'live' ? state.sync?.fallbackSources?.length ? '事件同步 · 部分来源轮询补偿' : '事件实时同步' : '轮询回退 · 自动重连中'} · 最近读取 ${new Date(data.lastScanAt).toLocaleTimeString()}` : `${state.sync?.transport === 'live' ? state.sync?.fallbackSources?.length ? 'Event sync · some sources use polling' : 'Live event sync' : 'Polling fallback · reconnecting'} · Last read ${new Date(data.lastScanAt).toLocaleTimeString()}`)}</p>
    {data?.initialScanComplete && <p className="cw-background-total">{session ? `${zh ? '会话' : 'Session'} ${session} · ` : `${zh ? '全部会话合计' : 'All sessions combined'} · `}{zh ? '已记录的运行项' : 'Recorded running items'}: {stale ? '—' : data.counts.running || 0} · {zh ? '后台命令 + 监视' : 'Background commands + monitors'}: {stale ? '—' : (data.byKind.command?.running || 0) + (data.byKind.monitor?.running || 0)} · {zh ? '工作流' : 'Workflows'}: {stale ? '—' : data.byKind.workflow?.running || 0} · {zh ? '命令尚未返回' : 'Pending command calls'}: {stale ? '—' : data.byKind.foreground?.running || 0}</p>}
    <div className="cw-background-counts">{Object.entries(data?.byKind || {}).map(([type, counts]) => <div key={type}><strong>{kinds[type]}</strong><span>{Object.entries(counts).map(([status, count]) => `${stale && status === 'running' ? names.unknown : names[status]} ${count}`).join(' · ')}</span></div>)}</div>
    <div className="cw-controls">
      <select aria-label={zh ? '后台任务记录范围' : 'Task history scope'} value={scope} onChange={change(setScope)}><option value="current">{zh ? '本次进程' : 'This process'}</option><option value="history">{zh ? '全部历史' : 'All history'}</option></select>
      <select aria-label={zh ? '后台任务会话' : 'Task session'} value={session} onChange={change(setSession)}><option value="">{zh ? '全部会话合计' : 'All sessions combined'}</option>{[...new Set([...(data?.sessions || []), ...(session ? [session] : [])])].map(id => <option key={id} value={id}>{id}</option>)}</select>
      <select aria-label={zh ? '后台任务类型' : 'Task type'} value={kind} onChange={change(setKind)}>{Object.entries(kinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label={zh ? '后台任务状态' : 'Task status'} value={filter} onChange={change(setFilter)}>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <input type="search" aria-label={zh ? '搜索后台任务' : 'Search background tasks'} placeholder={zh ? '搜索任务 ID、指令或描述' : 'Search task ID, command or description'} value={search} onChange={change(setSearch)}/>
    </div>
    <div className="cw-background-list">{data?.tasks.map(task => <details key={task.id} className="cw-background-task">
      <summary><span className={`cw-state cw-${stale ? 'stale' : task.status}`}>{stale ? names.unknown : names[task.status]}</span><strong>{task.description || task.command?.split('\n')[0]?.slice(0, 160) || task.summary || task.taskId}</strong><code>{task.taskId}</code></summary>
      <div className="cw-background-detail"><p>{zh ? '来源：本地任务生命周期记录' : 'Source: local task lifecycle records'} · {task.executionState === 'unconfirmed' ? (zh ? '实时执行未确认' : 'Live execution unconfirmed') : (zh ? '已记录状态' : 'Recorded state')}</p><p>{kinds[task.kind]} · {zh ? '所属代理' : 'Owner'}: {task.agentId || (zh ? '主会话 / 未记录' : 'Main session / unrecorded')}</p><p>{zh ? '会话' : 'Session'}: {task.sessionId}</p><p>{zh ? '开始' : 'Started'}: {task.startedAt ? new Date(task.startedAt).toLocaleString() : '—'} · {zh ? '最后状态事件' : 'Last state event'}: {task.updatedAt ? new Date(task.updatedAt).toLocaleString() : '—'}</p>{task.command && <pre tabIndex={0} aria-label={zh ? '后台命令指令' : 'Background command'}>{task.command}</pre>}{task.uncertainty && <p>{claudeUncertaintyLabel(task.uncertainty, lang)}</p>}{task.summary && <p>{task.summary}</p>}{task.toolUseId && <code>{task.toolUseId}</code>}</div>
    </details>)}</div>
    {data && !data.tasks.length && <p>{zh ? '此筛选下没有已读取的记录。' : 'No indexed records match this filter.'}</p>}
    <div className="cw-background-pages"><button disabled={page === 0} onClick={() => setPage(page - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{data ? `${page * 60 + (data.total ? 1 : 0)}–${Math.min((page + 1) * 60, data.total)} / ${data.total}` : '…'}</span><button disabled={!data || (page + 1) * 60 >= data.total} onClick={() => setPage(page + 1)}>{zh ? '下一页' : 'Next'}</button></div>
    {data?.skippedRecords > 0 && <p role="alert">{zh ? `有 ${data.skippedRecords} 条损坏或超大记录未解析，不能确认完整同步。` : `${data.skippedRecords} malformed or oversized records could not be parsed; full sync is unconfirmed.`}</p>}
    <small>{zh ? '显示 Claude 已写入本机记录的状态；有运行记录不代表已确认此刻仍在执行。原生 stalled 若未落盘，办公室无法自动同步；缺少结束记录的旧任务保留待确认。' : 'Shows states recorded locally by Claude. Old tasks without a terminal event remain unconfirmed. Credentials are masked; internal reasoning is excluded.'}</small>
  </section>;
}
