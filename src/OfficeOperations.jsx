import React from 'react';
import { Activity, ArrowUpRight, CheckCircle2, CircleHelp, RefreshCw } from 'lucide-react';
import { useOfficeDate } from './OfficeIdentity';
import { agentExecutionDisplay, officeExecutionCounts, officeRuntimeWorkers } from './claude-execution.js';
import { officeAgentLabel } from './unified-office.js';
import { geminiReadiness } from './gemini-desk.js';
import { taskReviewStatus, taskReviewLabel } from './review-ui.js';
import { qwenContinuousDuty, qwenContinuousDutyLabel } from './local-qwen-desk.js';
import './office-operations.css';

const PROVIDERS = [['claude','Claude Code'], ['codex','Codex'], ['grok','Grok'], ['gemini','Gemini'], ['local-qwen','Qwen']];
const label = text => String(text || '').replace(/\s+/g, ' ').slice(0, 140);

export default function OfficeOperations({ model, board, roster, claude, codex, onProvider, onTask, onTasks, onAgent, lang = 'zh' }) {
  const zh = lang === 'zh', state = board.state, stale = board.stale;
  const time = useOfficeDate({ hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const messages = zh ? { loading: '正在读取任务板', unavailable: '任务板连接待恢复', stopped: '任务执行器未启动', paused: '自动接单已暂停', queued: '任务正在等待领取', ready: '自动接单已开启' }
    : { loading: 'Loading task board', unavailable: 'Board connection needs recovery', stopped: 'Task runner is stopped', paused: 'Automatic pickup is paused', queued: 'Tasks await pickup', ready: 'Automatic pickup is on' };
  const urgent = model.blocked.needsUser;
  const qwenDuty = qwenContinuousDuty(state, { stale });
  return <section className="office-operations" data-no-i18n aria-label={zh ? '办公室运行总览' : 'Office operations'}>
    <header><div><span className="office-operations__eyebrow">{zh ? '现在的工作' : 'WORK RIGHT NOW'}</span><h1>{zh ? '谁在做，下一步做什么' : 'Who is working, and what comes next'}</h1></div><button type="button" onClick={() => board.refresh()} disabled={board.loading} aria-label={zh ? '刷新办公室状态' : 'Refresh office status'}><RefreshCw size={14}/>{zh ? '刷新' : 'Refresh'}</button></header>
    <div className={`office-operations__health ${['unavailable','stopped','paused'].includes(model.queueState) ? 'needs-attention' : ''}`} role="status"><span><i/>{messages[model.queueState]}</span><span>{board.lastSuccessAt ? `${zh ? '任务板读取于' : 'Board read at'} ${time(board.lastSuccessAt)}` : (zh ? '等待首次读取' : 'Waiting for first snapshot')}</span>{model.unverifiedClaims.length > 0 && <button onClick={()=>onTasks('running')}>{zh ? `${model.unverifiedClaims.length} 项执行记录需核实` : `${model.unverifiedClaims.length} task claims need verification`}</button>}</div>
    <div className="office-operations__providers">{PROVIDERS.map(([key,name])=>{
      const provider = key === 'local-qwen' ? 'Local Qwen' : name;
      const workers = officeRuntimeWorkers(roster.filter(agent=>agent.provider===provider));
      const counts = officeExecutionCounts(workers);
      const interrupted = workers.filter(worker => agentExecutionDisplay(worker) === 'waiting' && worker.lastEvent === 'StopFailure').length;
      const p = state.runtime?.providers?.[key];
      const native = key==='claude' ? claude : key==='codex' ? codex : null;
      const unknown = counts.recorded + counts.unconfirmed;
      const connected = native?.connected && !native.error && native.metadataAvailable !== false || !stale && p?.available && p?.authenticated;
      const waiting = counts.waiting;
      const status = key === 'local-qwen' && !counts.confirmed && !unknown && qwenDuty.configured ? qwenContinuousDutyLabel(qwenDuty, lang) : counts.confirmed ? (zh ? `${counts.confirmed} 位运行` : `${counts.confirmed} running`)
        : unknown ? (zh ? `${unknown} 位待确认` : `${unknown} unconfirmed`)
        : waiting ? (interrupted === waiting ? (zh ? `${interrupted} 位执行中断` : `${interrupted} interrupted`) : interrupted ? (zh ? `${waiting - interrupted} 位等待 · ${interrupted} 位中断` : `${waiting - interrupted} waiting · ${interrupted} interrupted`) : (zh ? `${waiting} 位等待` : `${waiting} waiting`))
        : key==='gemini' && !stale && geminiReadiness(p)==='needs-login' ? (zh ? '需要登录' : 'Sign-in needed')
        : key==='grok' && !stale && state.grokWake?.configured ? (zh ? '通知已配置' : 'Notifications configured')
        : connected ? (zh ? '已连接 · 待命' : 'Connected · standby') : (zh ? '连接待确认' : 'Connection unconfirmed');
      const source = native?.metadataAvailable === false ? (zh ? '活动来源不完整' : 'Activity source incomplete') : native?.error ? (zh ? '活动来源连接中断' : 'Activity source disconnected')
        : native?.receivedAt ? `${zh ? '活动读取' : 'Activity read'} ${time(native.receivedAt)}`
        : key==='local-qwen' && !stale && qwenDuty.live ? `${zh ? '心跳' : 'Heartbeat'} ${time(qwenDuty.heartbeatAt)} · ${zh ? '巡检不计入执行人数' : 'Duty is not a task worker'}`
        : key==='local-qwen' && !stale ? (p?.model || (zh ? '本机辅助' : 'Local assistance'))
        : key==='grok' ? (zh ? '通知不等于已接单' : 'Notification is not pickup') : (zh ? '点击查看工作室' : 'Open workspace');
      return <button key={key} type="button" onClick={()=>onProvider(key)} className={counts.confirmed ? 'is-working' : key === 'local-qwen' && qwenDuty.live && qwenDuty.status !== 'degraded' ? 'is-on-duty' : unknown || waiting || key === 'local-qwen' && qwenDuty.configured ? 'is-uncertain' : ''}><span><strong>{name}</strong><ArrowUpRight size={14}/></span><b>{status}</b><small>{source}</small></button>;
    })}</div>
    <div className="office-operations__next">
      <button onClick={()=>onTasks('running')}><Activity size={16}/><span><strong>{stale ? '—' : model.claimed.length}</strong><small>{zh ? '任务板正在执行' : 'Board tasks executing'}</small></span></button>
      <button onClick={()=>onTasks('pending')}><Activity size={16}/><span><strong>{stale ? '—' : model.pending.length}</strong><small>{zh ? '等待领取' : 'Awaiting pickup'}</small></span></button>
      <button className={urgent ? 'is-attention' : ''} onClick={()=>onTasks('blocked')}><CircleHelp size={16}/><span><strong>{stale ? '—' : urgent}</strong><small>{zh ? '需要你的资料或决定' : 'Need your information or decision'}</small></span></button>
      <button onClick={()=>onTasks('blocked')}><CheckCircle2 size={16}/><span><strong>{stale ? '—' : (model.blocked.working ?? model.blocked.investigating)}</strong><small>{zh ? `实际处理 · ${stale ? '—' : model.blocked.grokCheck} 项待核查` : `Working · ${stale ? '—' : model.blocked.grokCheck} awaiting triage`}</small></span></button>
    </div>
    <p className="office-operations__context">{model.queueState==='loading' ? (zh ? '正在读取任务和执行状态。' : 'Reading tasks and execution state.') : stale ? (zh ? '上次任务快照仅供参考；恢复连接后再判断谁已接单。' : 'The last task snapshot is for reference until the connection recovers.')
      : model.claimed.length===0 && model.execution.confirmed>0 ? (zh ? '当前运行的是原生会话；任务板没有执行卡。点击对应工作室可查看代理正在做什么。' : 'Native sessions are running; no board task is executing. Open a workspace to inspect their work.')
      : model.pending.length===0 && model.claimed.length===0 && model.blocked.active.length ? (zh ? '任务板目前只剩受阻事项。等待资料、批准或核查不等于已经开工。' : 'Only blocked work remains on the board. Waiting for information, approval or triage is not execution.')
      : (zh ? '代理人数包含原生会话与子代理；任务板只统计实际领取的卡片，两者分别显示。' : 'Agent counts include native sessions and subagents; board counts describe claimed cards. They are shown separately.')}</p>
    <details className="office-operations__activity"><summary>{zh ? '查看当前执行与最近交付' : 'Current execution and recent deliveries'}</summary>
      <div>{model.running.slice(0,8).map(agent=><button key={agent.id} onClick={()=>onAgent(agent)}><span>{agent.provider} · {officeAgentLabel(agent.name)}</span><small>{label(agent.runtimeAgents?.[0]?.tool || agent.runtimeAgents?.[0]?.lastTool) || (zh ? '打开查看当前活动' : 'Inspect current activity')}</small></button>)}</div>
      <div>{model.claimed.map(task=><button key={task.id} onClick={()=>onTask(task.id)}><span>{label(task.title)}</span><small>{zh ? '任务板执行中 · 查看任务' : 'Board task executing · inspect task'}</small></button>)}</div>
      <div>{model.recent.map(task=><button key={task.id} onClick={()=>onTask(task.id)}><span>{label(task.title)}</span><small>{taskReviewLabel(taskReviewStatus(task, state.tasks), zh) || (task.kind==='review' ? (zh ? '审查已返回 · 查看结论' : 'Review returned · inspect verdict') : (zh ? '执行已返回 · 查看结果' : 'Execution returned · inspect result'))} · {time(task.updatedAt)}</small></button>)}</div>
      {!model.running.length && !model.recent.length && !model.claimed.length && <p>{zh ? '暂无执行或交付记录。' : 'No execution or delivery records yet.'}</p>}
    </details>
  </section>;
}
