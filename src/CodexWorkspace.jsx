import React, { useEffect, useState } from 'react';
import { useLang } from './i18n';
import { ClaudeAgentPanel } from './ClaudeWorkspace.jsx';
import DispatchConversation from './DispatchConversation.jsx';
import { agentExecutionDisplay, officeExecutionCounts } from './claude-execution.js';
import './claude-workspace.css';

export function CodexWorkspaceView({ data, loading, error, onBack, onRetry, board, onOpenDispatch, lang = 'zh' }) {
  const zh = lang === 'zh';
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const agents = data?.agents || [];
  const isActive = agent => ['working', 'running', 'waiting'].includes(agent.status);
  const isUnconfirmed = agent => ['unconfirmed', 'recorded-running'].includes(agentExecutionDisplay(agent));
  const counts = officeExecutionCounts(agents);
  const shown = agents.filter(agent => (filter === 'all' || (filter === 'unconfirmed' ? isUnconfirmed(agent) : filter === 'idle' ? agentExecutionDisplay(agent) === 'idle' : isActive(agent))) && `${agent.name || ''} ${agent.id} ${agent.agentPath || ''} ${agent.cwd || ''} ${agent.instruction || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const uncertain = Boolean(error || data?.metadataAvailable === false);
  const timestamp = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '—';
  return <section className="claude-workspace" data-no-i18n>
    <button type="button" className="cw-back" onClick={onBack}>{zh ? '← 返回办公室' : '← Back to office'}</button>
    <div className="cw-title"><div><span className="cw-eyebrow">CODEX · LIVE WORKSPACE</span><h1>{zh ? 'Codex 工作室' : 'Codex workspace'}</h1><p>{zh ? '主代理与每个子代理各自一块面板。显示真实运行状态、可读取的任务指令和公开活动；加密指令会明确标注。' : 'A panel for each main agent and subagent: observed status, readable instructions and public activity. Encrypted instructions are identified explicitly.'}</p></div><div className="cw-connection" role="status">{loading ? (zh ? '正在读取…' : 'Loading…') : uncertain ? (zh ? '状态待确认' : 'Status unconfirmed') : (zh ? '每 4 秒更新' : 'Updates every 4 seconds')}<small>{zh ? '更新于' : 'Updated'} {timestamp}</small></div></div>
    {board && <details className="cw-dispatch"><summary>{zh ? '调度台对话与指令' : 'Dispatch conversation & instructions'} · {board.state?.instructions?.length || 0}</summary><DispatchConversation board={board} compact onOpenDispatch={onOpenDispatch} lang={lang}/></details>}
    <div className="cw-controls"><div className="cw-filters">{[['active', zh ? '运行与等待' : 'Running & waiting'], ['idle', zh ? '空闲' : 'Idle'], ['unconfirmed', zh ? '待确认' : 'Unconfirmed'], ['all', zh ? '全部在线' : 'All online']].map(([value, label]) => <button type="button" key={value} aria-pressed={value === filter} onClick={() => setFilter(value)}>{label}</button>)}</div><input type="search" aria-label={zh ? '搜索代理、项目或指令' : 'Search agents, projects or instructions'} placeholder={zh ? '搜索代理、项目或指令' : 'Search agents, projects or instructions'} value={search} onChange={event => setSearch(event.target.value)}/><button type="button" onClick={onRetry}>{zh ? '立即同步' : 'Refresh now'}</button><span>{shown.length} {zh ? '个代理面板' : 'agent panels'}</span></div>
    {!uncertain && <p className="cw-counts">{zh ? '运行中' : 'Running'} {counts.confirmed} · {zh ? '等待' : 'Waiting'} {counts.waiting} · {zh ? '空闲' : 'Idle'} {counts.idle} · {zh ? '待确认' : 'Unconfirmed'} {counts.recorded + counts.unconfirmed} · {zh ? '其中子代理' : 'Subagents'} {agents.filter(agent => agent.isSubagent).length}</p>}
    {data?.sourceHealth?.missingThreadRecords > 0 && <p className="cw-evidence">{zh ? `${data.sourceHealth.missingThreadRecords} 个会话身份尚未同步，已单列待确认；其余代理继续按自身状态显示。` : `${data.sourceHealth.missingThreadRecords} session identities have not synced and are listed as unconfirmed; other agents retain their own status.`}</p>}
    {data?.sourceHealth?.unreadableRollouts > 0 && <p className="cw-evidence">{zh ? '部分会话只有写入锁，尚未读到生命周期；已单列为待确认，不计入运行或空闲。' : 'Some sessions have a writer lock but no readable lifecycle; they are unconfirmed, excluded from running and idle counts.'}</p>}
    {uncertain && <div className="cw-alert" role="alert">{zh ? '无法确认 Codex 当前状态。以下是上次读取的记录，不代表代理仍在运行。' : 'Current Codex status cannot be confirmed. Previous records below do not establish that agents are still running.'}</div>}
    {data?.enabled === false ? <div className="cw-empty">{zh ? '此安装尚未启用 Codex。请先在设置向导中连接。' : 'Codex is disabled in this installation. Connect it in setup first.'}</div> : <><div className="cw-grid">{shown.map(agent => <ClaudeAgentPanel key={agent.id} agent={{ ...agent, status: agent.status === 'working' ? 'running' : agent.status }} provider="Codex" lang={lang} stale={uncertain}/>)}</div>{!shown.length && !loading && <div className="cw-empty">{zh ? '当前没有符合条件的代理。新代理开始工作后会自动出现；空闲代理可从“空闲”展开查看。' : 'No matching agents. New agents appear automatically; use Idle to inspect resting agents.'}</div>}</>}
  </section>;
}

export default function CodexWorkspace({ onBack, board, onOpenDispatch }) {
  const lang = useLang();
  const [state, setState] = useState({ data: null, loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { window.scrollTo(0, 0); }, []);
  useEffect(() => {
    let stopped = false, timer, controller;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch('/api/codex/workspace', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!Array.isArray(data.agents)) throw new Error('Invalid workspace');
        if (!stopped) setState({ data, loading: false, error: false });
      } catch {
        if (!stopped) setState(previous => ({ ...previous, loading: false, error: true }));
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(poll, 4000);
      }
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [attempt]);
  return <CodexWorkspaceView {...state} board={board} onOpenDispatch={onOpenDispatch} onBack={onBack} onRetry={() => setAttempt(value => value + 1)} lang={lang}/>;
}
