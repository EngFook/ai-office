import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from './i18n';
import './claude-workspace.css';
import DispatchConversation from './DispatchConversation.jsx';
import ClaudeBackgroundTasks from './ClaudeBackgroundTasks.jsx';
import { agentExecutionDisplay, claudeSessionSummary } from './claude-execution.js';
import { createClaudeLiveFeed } from './claude-live.js';

const labels = {
  zh: { title: 'Claude 工作室', back: '← 返回办公室', running: '运行中', 'recorded-running': '有运行记录 · 实时待确认', unconfirmed: '状态待确认', waiting: '等待', idle: '空闲', stale: '状态待确认', live: '事件实时同步', degraded: '事件同步 · 部分来源轮询补偿', polling: '轮询回退 · 自动重连中', connecting: '正在连接事件通道 · 轮询中', refresh: '重新连接', search: '搜索代理、项目或指令', active: '活动与等待记录', all: '全部已记录代理', task: '任务指令', activity: '最新活动', follow: '跟随最新', paused: '已暂停跟随', following: '正在跟随', none: '尚未读取到任务指令', noEvents: '暂无可显示的活动记录', missing: '尚未找到此代理的本地记录，保留真实状态。', limited: '仅显示最近 32 条可见活动；长记录已截取。', notice: '代理面板显示本地指令与活动，不含内部推理或工具结果。调度对话与办公室任务队列同步。', empty: '当前没有符合条件的代理。代理开始工作后会自动出现在这里。', disabled: '此安装未启用 Claude 连接。请先在设置向导中连接 Claude，并安装生命周期钩子。', loading: '正在读取 Claude 工作室…', error: '连接中断，下面是上次读取的记录，不能确认代理仍在运行。', failed: '工作室连接失败，请重新连接。', parent: '上级', main: '主代理', child: '子代理', checked: '更新于', count: '个代理面板', observedAgents: '已观察到的代理', hook: '未检测到完整的 Claude 生命周期钩子，请运行 npm run connect:claude。' },
  en: { title: 'Claude workspace', back: '← Back to office', running: 'Running', 'recorded-running': 'Recorded active · live state unconfirmed', unconfirmed: 'Status unconfirmed', waiting: 'Waiting', idle: 'Idle', stale: 'Status unconfirmed', live: 'Live event sync', degraded: 'Event sync · some sources use polling', polling: 'Polling fallback · reconnecting', connecting: 'Connecting event stream · polling', refresh: 'Reconnect', search: 'Search agents, projects or instructions', active: 'Active & waiting records', all: 'All recorded agents', task: 'Task instructions', activity: 'Recent activity', follow: 'Follow latest', paused: 'Follow paused', following: 'Following latest', none: 'Task instructions are not available yet', noEvents: 'No visible activity recorded yet', missing: 'Local records not found yet; showing observed status.', limited: 'Showing up to 32 recent visible events; long records are truncated.', notice: 'Agent panels show local instructions and activity, excluding internal reasoning and tool results. Dispatch shares the office task queue.', empty: 'No matching agents. New activity appears here automatically.', disabled: 'Claude is disabled in this installation. Connect it in setup and install lifecycle hooks.', loading: 'Loading Claude workspace…', error: 'Connection lost. These are previous records; agents may no longer be running.', failed: 'Workspace connection failed. Try reconnecting.', parent: 'Parent', main: 'Main agent', child: 'Subagent', checked: 'Updated', count: 'agent panels', observedAgents: 'Observed agents', hook: 'Complete Claude lifecycle hooks were not detected. Run npm run connect:claude.' },
};
const timeLabel = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export function ClaudeAgentPanel({ agent, stale = false, lang = 'zh', provider = 'Claude' }) {
  const l = labels[lang] || labels.en;
  const log = useRef(null);
  const [follow, setFollow] = useState(true);
  const events = agent.events || [];
  const assignmentPreview = (agent.instruction || '').split(/\n\s*\n/).find(part => part.trim() && !part.trim().startsWith('[Workflow harness'))?.trim().slice(0, 240);
  const latest = events.at(-1);
  useLayoutEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [follow, latest?.id, latest?.text, events.length]);
  const state = agentExecutionDisplay(agent, stale);
  const interrupted = state === 'waiting' && agent.lastEvent === 'StopFailure';
  return <article className="cw-agent" data-agent-id={agent.id} data-execution-state={agent.executionState || state}>
    <header className="cw-agent-heading"><div><span className="cw-agent-type">{agent.isSubagent ? l.child : l.main}</span><h2>{agent.name || provider}</h2></div><span className={`cw-state cw-${state}`}>{interrupted ? (lang === 'zh' ? '执行中断' : 'Execution interrupted') : l[state] || state}</span></header>
    <div className="cw-meta"><code title={agent.id}>{agent.agentId || agent.sessionId}</code><span title={agent.cwd}>{agent.cwd || '—'}</span>{agent.parentAgentId && <span title={agent.parentAgentId}>{l.parent}: {agent.parentAgentId}</span>}</div>
    {agent.observationSource && <p className="cw-evidence">{lang === 'zh' ? '状态来源' : 'State source'}: {agent.observationSource} · {lang === 'zh' ? '最后事件' : 'Last event'}: {agent.lastEvent || '—'} · <time dateTime={agent.lastEventAt || undefined}>{timeLabel(agent.lastEventAt)}</time>{agent.activityPhase && <span> · {interrupted ? (lang === 'zh' ? '执行中断' : 'Execution interrupted') : agent.activityPhase === 'tool-pending' ? (lang === 'zh' ? '等待工具返回' : 'Awaiting tool result') : agent.activityPhase === 'between-hooks' ? (lang === 'zh' ? '最近有活动' : 'Activity recorded') : agent.activityPhase}</span>}</p>}
    {interrupted && <p className="cw-evidence">{lang === 'zh' ? '最近收到 StopFailure；尚未提供具体失败原因。' : 'StopFailure was recorded; no specific failure reason was provided.'}</p>}
    {assignmentPreview && <p className="cw-task-preview" title={assignmentPreview}>{assignmentPreview}</p>}
    <details className="cw-instructions" open><summary>{l.task}</summary><pre tabIndex={0} aria-label={l.task}>{agent.instruction || (agent.instructionState === 'encrypted' ? (lang === 'zh' ? '此任务指令由 Codex 加密保存，办公室无法读取。运行状态与公开活动仍会同步。' : 'Codex stores this task instruction encrypted. The office cannot read it; status and public activity still update.') : agent.instructionState === 'outside-window' ? (lang === 'zh' ? `近期记录窗口内没有可读取的任务指令，请在 ${provider} 主会话查看。` : `The recent record window contains no readable task instruction. Open the original ${provider} chat to view it.`) : l.none)}</pre></details>
    {!agent.sourceAvailable && <p className="cw-missing">{l.missing}</p>}
    <div className="cw-log-heading"><h3>{l.activity}</h3><button type="button" onClick={() => setFollow(!follow)} aria-pressed={follow}>{follow ? l.following : l.follow}</button></div>
    {!follow && <span className="cw-paused">{l.paused}</span>}
    <div className="cw-log" ref={log} tabIndex={0} aria-label={`${agent.name} · ${l.activity}`} onScroll={event => {
      const el = event.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 35) setFollow(false);
    }}>
      {events.length ? events.map(event => <div className={`cw-event cw-event-${event.kind}`} key={event.id}><div><time dateTime={event.timestamp || undefined}>{timeLabel(event.timestamp)}</time>{event.tool && <strong>{event.tool}</strong>}</div><pre>{event.text}</pre></div>) : <p className="cw-log-empty">{l.noEvents}</p>}
    </div>
    <footer className="cw-panel-footer">{agent.truncated ? l.limited : `${l.checked} ${timeLabel(agent.updatedAt)}`}</footer>
  </article>;
}

export function ClaudeWorkspaceView({ data, loading, error, sync, onBack, onRetry, board, onOpenDispatch, lang = 'zh' }) {
  const l = labels[lang] || labels.en;
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [sessionId, setSessionId] = useState('');
  const agents = data?.agents || [];
  const sessions = [...new Set(agents.map(agent => agent.sessionId).filter(Boolean))];
  const summary = claudeSessionSummary(agents, sessionId);
  const uncertain = Boolean(error || data?.metadataAvailable === false);
  const query = search.trim().toLowerCase();
  const shown = summary.agents.filter(agent => (filter === 'all' || ['working', 'running', 'waiting'].includes(agent.status)) && `${agent.name} ${agent.id} ${agent.cwd} ${agent.instruction}`.toLowerCase().includes(query));

  return <section className="claude-workspace" data-no-i18n>
    <button type="button" className="cw-back" onClick={onBack}>{l.back}</button>
    <div className="cw-title"><div><span className="cw-eyebrow">CLAUDE CODE · LIVE WORKSPACE</span><h1>{l.title}</h1><p>{l.notice}</p></div><div className="cw-connection" role="status">{loading ? l.loading : uncertain ? l.stale : sync?.transport === 'live' ? sync?.fallbackSources?.length ? l.degraded : l.live : sync?.transport === 'fallback' ? l.polling : l.connecting}<small>{data?.updatedAt && `${l.checked} ${timeLabel(data.updatedAt)}`}</small></div></div>
    {board && <details className="cw-dispatch" open={Boolean(board.state?.grok?.connected)}><summary>{lang==='zh'?'调度台对话与指令':'Dispatch conversation & instructions'} · {board.state?.instructions?.length || 0}</summary><DispatchConversation board={board} compact onOpenDispatch={onOpenDispatch} lang={lang}/></details>}
    <div className="cw-controls"><label className="cw-session-label">{lang === 'zh' ? '对照会话' : 'Compare session'} <select aria-label={lang === 'zh' ? '工作室会话' : 'Workspace session'} value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">{lang === 'zh' ? '全部会话合计' : 'All sessions combined'}</option>{[...new Set([...sessions, ...(sessionId ? [sessionId] : [])])].map(id => <option value={id} key={id}>{id}</option>)}</select></label><div className="cw-filters">{['active', 'all'].map(value => <button type="button" key={value} aria-pressed={value === filter} onClick={() => setFilter(value)}>{l[value]}</button>)}</div><input type="search" aria-label={l.search} placeholder={l.search} value={search} onChange={event => setSearch(event.target.value)}/><span>{shown.length} {l.count}</span></div>
    <p className="cw-counts">{sessionId ? `${lang === 'zh' ? '单会话' : 'Session'} ${sessionId}` : (lang === 'zh' ? '所有会话合计；与 Claude 单个会话对照前请先选择会话。' : 'All sessions combined. Select the matching Claude session before comparing counts.')}</p>
    {!uncertain && <p className="cw-counts">{l.main} {summary.main} · {l.child} {summary.child} · {l.running} {summary.confirmedRunning} · {l.waiting} {summary.waiting} · {l.idle} {summary.idle} · {lang === 'zh' ? '实时执行待确认' : 'Live execution unconfirmed'} {summary.unconfirmed}</p>}
    {data?.enabled !== false && <p className="cw-evidence">{lang === 'zh' ? '代理数不等于后台命令数。运行中需要当前会话存活及近期活动证据；过期或缺少证据会单列待确认。卡片保留来源、事件和时间。' : 'Agents and background commands are separate counts. Running requires a live owning session and recent activity evidence; expired or missing evidence is unconfirmed. Each card retains its source, event and time.'}</p>}
    {data?.metadataAvailable === false && <p className="cw-alert" role="alert">{lang === 'zh' ? '生命周期来源读取不完整，计数与实时执行状态待确认。' : 'Lifecycle sources are incomplete; counts and live execution are unconfirmed.'}</p>}
    {data?.enabled !== false && <ClaudeBackgroundTasks lang={lang} selectedSession={sessionId} onSessionChange={setSessionId}/>}
    {error && <div className="cw-alert" role="alert">{data ? l.error : l.failed} <button type="button" onClick={onRetry}>{l.refresh}</button></div>}
    {data?.enabled === false ? <div className="cw-empty">{l.disabled}</div> : <>
      {data?.hookInstalled === false && <p className="cw-alert">{l.hook}</p>}
      <div className="cw-grid">{shown.map(agent => <ClaudeAgentPanel key={agent.id} agent={{ ...agent, status: agent.status === 'working' ? 'running' : agent.status }} stale={uncertain} lang={lang}/>)}</div>
      {!shown.length && !loading && <div className="cw-empty">{l.empty}</div>}
    </>}
  </section>;
}

export default function ClaudeWorkspace({ onBack, board, onOpenDispatch }) {
  const lang = useLang();
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let sync;
    const feed = createClaudeLiveFeed({ url: '/api/claude/workspace',
      validate: data => Array.isArray(data?.agents),
      onSync: value => { sync = value; setState(previous => ({ ...previous, sync })); },
      onSnapshot: data => setState({ data, loading: false, error: null, sync }),
      onError: () => setState(previous => ({ ...previous, loading: false, error: true })),
    });
    void feed.start();
    return () => { void feed.stop(); };
  }, [attempt]);
  return <ClaudeWorkspaceView {...state} board={board} onOpenDispatch={onOpenDispatch} onBack={onBack} onRetry={() => setAttempt(value => value + 1)} lang={lang}/>;
}
