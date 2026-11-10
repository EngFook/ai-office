import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, CirclePause, CirclePlay, Clock3, Radio, UsersRound } from 'lucide-react';
import { claudeWorkerIdentity, claudeAgentStatus, claudeWorkerGroups } from './claude-office';
import { buildSharedRoster, officeBridgeAvailable, officeRoleLabel, officeAgentLabel } from './unified-office';
import { t, useLang } from './i18n';
import './shared-connection.css';

const EMPTY = {skills:[], agents:[], connected:false, hookInstalled:false};
function useAgentConnection(provider) {
  const [state, setState] = useState({...EMPTY, loading:true, error:null});
  useEffect(() => {
    let disposed = false;
    let timer;
    let request;
    const refresh = async () => {
      const providerName = provider === 'codex' ? 'Codex' : provider === 'grok' ? 'Grok' : 'Claude Code';
      request = new AbortController();
      const timeout = setTimeout(()=>request.abort(), 5000);
      try {
        const response = await fetch(`/api/${provider}/status`, {signal:request.signal, cache:'no-store'});
        if (!response.ok) throw new Error(`The local ${providerName} bridge is unavailable.`);
        const data = await response.json();
        if (!Array.isArray(data.skills) || !Array.isArray(data.agents)) throw new Error(`The local ${providerName} bridge returned an invalid response.`);
        if (!disposed) setState({...data, loading:false, error:null});
      } catch (error) {
        if (!disposed) setState(previous=>({...previous, connected:false, loading:false, error:`The local ${providerName} connection is offline. Restart the studio to reconnect.`}));
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(refresh, 2000);
      }
    };
    refresh();
    return ()=>{disposed=true;clearTimeout(timer);request?.abort();};
  }, [provider]);
  return state;
}

export const useClaudeConnection = () => useAgentConnection('claude');
export const useCodexConnection = () => useAgentConnection('codex');

export const agentConnectionLabel = (state,provider='Claude Code') => state.loading ? 'Connecting…' : state.error ? 'Connection offline' : state.connected ? (state.agents.some(agent=>agent.observed && agent.status !== 'offline') ? `${provider} connected` : `${provider} session detected`) : provider === 'Codex' ? 'Listening for Codex' : state.hookInstalled ? 'Listening for Claude' : 'Setup needed';
export const claudeConnectionLabel = state => agentConnectionLabel(state);

export function AgentConnection({state, onDirectory, provider='Claude Code', floor=2}) {
  const live = state.agents.filter(agent=>agent.status !== 'offline');
  const working = state.error ? 0 : live.filter(agent=>agent.status === 'working').length;
  const idle = state.error ? 0 : live.filter(agent=>agent.status === 'idle').length;
  const waiting = state.error ? 0 : live.filter(agent=>agent.status === 'waiting').length;
  const topics = state.skills.filter(skill=>skill.category !== 'router').length;
  return <section className="claude-connection" aria-label={`${provider} connection`}>
    <div className="claude-connection__heading"><span className={`claude-signal${state.error ? ' is-offline' : state.hookInstalled || state.connected ? ' is-ready' : ''}`}><Radio size={17}/></span><div><span className="section-kicker">{t('Studio')} · {provider.toUpperCase()}</span><h3>{agentConnectionLabel(state,provider)}</h3></div><span className="claude-local">ON THIS MAC</span></div>
    <div className="claude-metrics"><div><strong>{topics}</strong><span>{provider === 'Codex' ? 'AVAILABLE SKILLS' : 'GAME DEV SKILLS'}</span></div><div><strong>{state.error ? '—' : live.length}</strong><span>{provider.toUpperCase()} AGENTS</span></div></div>
    <div className="claude-status-totals" aria-label={`${provider} agent status totals`}><span className="is-running"><i/>{working} Running</span><span className="is-idle"><i/>{idle} Idle</span>{waiting > 0 && <span className="is-waiting"><i/>{waiting} Waiting</span>}</div>
    <p>{state.error || (state.agents.some(agent=>agent.observed && agent.status !== 'offline') ? `${provider} sessions and subagents move to their desks while working, then return to their idle rooms.` : provider === 'Codex' ? 'Open a Codex task on this Mac to see its agents on this studio.' : state.hookInstalled ? 'Specialists are ready. Start a new Claude Code session or restart an existing session to send its activity to this studio.' : 'Run npm run connect:claude from the studio folder to connect Claude Code.')}</p>
    <button className="text-link" onClick={onDirectory}>{provider === 'Codex' ? 'Browse Codex skills & agents' : 'Meet the Claude specialists'} <UsersRound size={15}/></button>
  </section>;
}

function actorDetails(agent, worker, fallback) {
  const provider = worker.provider || agent.provider || (fallback === 'Shared studio' ? 'Agent' : fallback);
  const identity = claudeWorkerIdentity({...worker, provider});
  const role = agent.role || worker.agentRole || (worker.agentType === 'main' ? 'Coordinator' : worker.agentType) || (worker.isSubagent ? 'Specialist' : 'Coordinator');
  const original = worker.name || (agent.kind === 'live' && agent.name) || identity.label;
  const label = officeAgentLabel(original);
  return { ...identity, label: label === original ? original : t(label), provider, role: officeRoleLabel(role, provider, worker) };
}

export function AgentActivity({agent,provider: suppliedProvider='Claude Code'}) {
  const provider = agent.provider || agent.runtimeAgents?.[0]?.provider || suppliedProvider;
  const type = provider === 'Codex' ? (agent.skill ? `$${agent.skill.name}` : null) : provider === 'Claude Code' ? (agent.skill?.category === 'router' ? 'ai-office-gamedev-router' : agent.skill ? `ai-office-${agent.skill.name}` : null) : null;
  return <div className="claude-agent-activity">
    {(agent.role || agent.department) && <div className="shared-agent-facts">{agent.role && <span><small>ROLE</small><strong>{officeRoleLabel(agent.role, provider, agent.runtimeAgents?.[0])}</strong></span>}{agent.department && <span><small>DEPARTMENT</small><strong>{agent.department}</strong></span>}<span><small>PROVIDER</small><strong>{provider}</strong></span></div>}
    {type && <div className="claude-specialist-call"><small>USE THIS {provider === 'Codex' ? 'SKILL IN CODEX' : 'SPECIALIST IN CLAUDE CODE'}</small><code>{type}</code><p>{provider === 'Codex' ? `Ask Codex to use the ${agent.skill.name} skill for your task.` : `Ask Claude Code to use this specialist for a task. It loads ${agent.skillId}.`}</p></div>}
    {agent.runtimeAgents?.map(worker=>{
      const identity = actorDetails(agent, worker, provider);
      const status = agent.liveStatus || worker.status;
      const updatedAt = new Date(worker.updatedAt);
      return <div className="claude-worker" key={worker.id}><strong data-no-i18n>{identity.provider} · {identity.label} · {identity.shortId}</strong><span>Role: {identity.role}{worker.isSubagent ? ' · Subagent' : ' · Session'}</span><span>{worker.observed === false ? 'Session detected · activity not yet observed' : `${status === 'working' ? 'Running' : status === 'waiting' ? 'Waiting for input' : status === 'offline' ? 'Offline · session ended' : 'Idle'}${worker.tool ? ` · Using ${worker.tool}` : ''}`}</span>{!worker.tool && worker.lastTool && <span>Last tool: {worker.lastTool}{worker.lastToolOutcome === 'failed' ? ' · failed' : worker.lastToolOutcome === 'succeeded' ? ' · completed' : ''}</span>}{worker.cwd && <span className="claude-worker__project" title={worker.cwd}><span>Project:</span> <span data-no-i18n>{identity.project}</span></span>}<small>Agent ID: {worker.id}</small><small>{worker.updatedAt && Number.isFinite(updatedAt.getTime()) ? `Last activity: ${updatedAt.toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore'})} SGT` : 'Waiting for activity'}</small></div>;
    })}
  </div>;
}

function activityElapsed(worker, now) {
  const value = worker.startedAt || worker.statusSince || worker.updatedAt;
  const since = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(since)) return '—';
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  return minutes < 1 ? t('just now') : minutes < 60 ? t('{x} min').replace('{x}', minutes) : t('{x} hours').replace('{x}', Math.floor(minutes / 60));
}

export function AgentStatusPanel({agents, error, loading, onSelectAgent,provider='Claude Code',floor=2}) {
  const pull = useRef({ startY: null, suppressUntil: 0 });
  const [expanded, setExpanded] = useState(() => !globalThis.matchMedia?.('(max-width: 700px)').matches);
  const [idleExpanded, setIdleExpanded] = useState(false);
  const [waitingExpanded, setWaitingExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  useLang();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useEffect(()=>{setIdleExpanded(false);setWaitingExpanded(false);},[floor,provider]);
  const groups = claudeWorkerGroups(agents);
  const panelId = `working-now-${floor}-${provider.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
  const rows = group => groups[group].map(agent=>{
    const worker = agent.runtimeAgents[0];
    const identity = actorDetails(agent, worker, provider);
    const status = claudeAgentStatus(agent);
    const Icon = status.id === 'running' ? CirclePlay : status.id === 'waiting' ? Clock3 : CirclePause;
    return <button type="button" className={`shared-agent-row is-${status.id}`} key={agent.id} onClick={()=>onSelectAgent?.(agent)} aria-label={t('Locate agent {x}').replace('{x}', `${identity.provider} ${identity.label} ${identity.shortId}`)}>
      <i aria-hidden="true"/><span className="shared-agent-row__copy"><strong><span data-no-i18n>{identity.label}</span><small>{identity.provider}</small></strong><span><span>{identity.role}</span> · <span data-no-i18n>{identity.project}</span></span><span className="shared-agent-row__status"><Icon size={11}/>{status.label}<time title="Since last activity">{activityElapsed(worker, now)}</time></span></span><code data-no-i18n>{identity.shortId}</code><ArrowUpRight size={13} aria-hidden="true"/>
    </button>;
  });
  const hasAgents = groups.running.length + groups.idle.length + groups.waiting.length > 0;
  return <section className={`shared-agent-status${expanded ? ' is-expanded' : ''}`} aria-label={`${provider} agent status`}>
    <button type="button" className="shared-agent-status__heading" aria-expanded={expanded} aria-controls={panelId} onPointerDown={event => { if (event.pointerType === 'touch') { pull.current.startY = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerUp={event => { if (event.pointerType !== 'touch' || pull.current.startY == null) return; const distance = event.clientY - pull.current.startY; pull.current.startY = null; if (Math.abs(distance) > 24) { setExpanded(distance < 0); pull.current.suppressUntil = Date.now() + 500; } }} onPointerCancel={() => { pull.current.startY = null; }} onClick={() => { if (Date.now() >= pull.current.suppressUntil) setExpanded(value => !value); }}><span className="shared-agent-status__handle" aria-hidden="true"/><span className="shared-agent-status__title"><Radio size={13}/> WORKING NOW</span><span className="shared-agent-status__running"><CirclePlay size={13}/>{t('{x} running').replace('{x}', groups.running.length)}</span><ChevronDown size={14} className="shared-agent-status__chevron"/></button>
    <div id={panelId} hidden={!expanded} className="shared-agent-status__body">
      <div className="shared-agent-status__toolbar"><button type="button" className="shared-agent-toggle is-idle" aria-expanded={idleExpanded} aria-controls={`${panelId}-idle`} onClick={()=>setIdleExpanded(value=>!value)}>Idle agents <span>({groups.idle.length})</span><ChevronDown size={13}/></button>{groups.waiting.length > 0 && <button type="button" className="shared-agent-toggle is-waiting" aria-expanded={waitingExpanded} aria-controls={`${panelId}-waiting`} onClick={()=>setWaitingExpanded(value=>!value)}>Waiting <span>({groups.waiting.length})</span><ChevronDown size={13}/></button>}</div>
      {groups.running.length > 0 ? <div className="shared-agent-list" aria-label="Running agents">{rows('running')}</div> : <p className="shared-agent-status__empty">{loading && !hasAgents ? 'Checking local activity…' : 'No agents running right now.'}</p>}
      <div className="shared-agent-list is-idle" id={`${panelId}-idle`} aria-label="Idle agents" hidden={!idleExpanded}>{idleExpanded && (groups.idle.length ? rows('idle') : <p className="shared-agent-status__empty">No idle agents.</p>)}</div>
      {groups.waiting.length > 0 && <div className="shared-agent-list is-waiting" id={`${panelId}-waiting`} aria-label="Waiting agents" hidden={!waitingExpanded}>{waitingExpanded && rows('waiting')}</div>}
      {error && <p className="shared-agent-status__notice">{provider === 'Shared studio' ? 'Some provider connections are unavailable. Connected agents remain visible.' : `${provider} connection is unavailable.`}</p>}
    </div>
  </section>;
}

export function SharedConnections({claude=EMPTY,codex=EMPTY,grok=EMPTY,qwen=EMPTY,onDirectory}) {
  const providers = [['codex','Codex',codex],['claude','Claude Code',claude],['grok','Grok',grok],['local-qwen','Local Qwen',qwen]];
  return <section className="shared-connections" aria-label="Provider connections"><div className="shared-connections__heading"><Radio size={15}/><h3>Connections</h3><span>ON THIS MAC</span></div><div className="shared-connections__providers">{providers.map(([key,provider,state])=>{
    const unavailable = state.error || state.metadataAvailable === false;
    // Apply the same identity validation, deduplication and observation rules as
    // the shared floor, rather than displaying raw source claims as work.
    const live = officeBridgeAvailable(state) ? buildSharedRoster({[key]:state}).flatMap(agent=>agent.runtimeAgents).filter(worker=>worker.status !== 'offline') : [];
    const running = live.filter(agent=>agent.status === 'working').length;
    const waiting = live.filter(agent=>agent.status === 'waiting').length;
    const idle = live.filter(agent=>agent.status === 'idle').length;
    const label = state.pending ? 'Awaiting connection' : state.loading ? 'Connecting…' : unavailable ? 'Offline' : state.connected ? 'Connected' : provider === 'Claude Code' && state.hookInstalled ? 'Listening' : 'Not connected';
    const detail = state.pending ? 'Qwen desk reserved; runtime integration pending.' : unavailable ? 'Local activity unavailable' : live.length ? [running ? `${running} running` : '', waiting ? `${waiting} waiting` : '', idle ? `${idle} idle` : ''].filter(Boolean).join(' · ') : provider === 'Grok' ? 'No live activity connection' : state.connected ? 'No active agents' : 'Waiting for a local session';
    return <div className={`shared-connection-row${unavailable ? ' is-offline' : state.connected ? ' is-connected' : ''}`} key={provider}><i/><div><strong>{provider}</strong><small>{detail}</small></div><span>{label}</span></div>;
  })}</div><button type="button" className="shared-connections__directory" onClick={()=>onDirectory?.()}>Browse studio directory <UsersRound size={14}/></button></section>;
}
