// A recorded lifecycle event is not live execution evidence.
export function isConfirmedExecution(worker = {}) {
  return worker.observed === true && ['working', 'running'].includes(worker.status) && ['working', 'running'].includes(worker.executionState);
}

export function agentExecutionDisplay(agent = {}, unavailable = false) {
  if (unavailable) return 'stale';
  if (agent.status === 'offline') return 'offline';
  if (agent.observed !== true) return 'unconfirmed';
  if (['working', 'running'].includes(agent.status)) return isConfirmedExecution(agent) ? 'running' : 'recorded-running';
  if (['idle', 'waiting'].includes(agent.status) && agent.executionState === agent.status) return agent.status;
  return 'unconfirmed';
}

export function claudeSessionSummary(agents = [], sessionId = '') {
  const scoped = agents.filter(agent => !sessionId || agent.sessionId === sessionId);
  const counts = officeExecutionCounts(scoped);
  return {
    agents: scoped,
    main: scoped.filter(agent => !agent.isSubagent).length,
    child: scoped.filter(agent => agent.isSubagent).length,
    confirmedRunning: counts.confirmed,
    recordedRunning: counts.recorded,
    waiting: counts.waiting,
    idle: counts.idle,
    unconfirmed: counts.recorded + counts.unconfirmed,
  };
}

// Aggregate availability can invalidate activity, but can never promote an
// idle sibling. Conflicting non-active/active snapshots remain unconfirmed.
export function officeRuntimeWorkers(roster = []) {
  return roster.flatMap(agent => (agent.runtimeAgents || []).map(worker => {
    if (agent.liveStatus === 'offline') return { ...worker, status: 'offline', executionState: 'offline', tool: null };
    if (agent.liveStatus && !['working', 'running'].includes(agent.liveStatus) && ['working', 'running'].includes(worker.status)) {
      return { ...worker, status: agent.liveStatus, executionState: 'unconfirmed', tool: null };
    }
    return worker;
  }));
}

export function officeExecutionCounts(workers = []) {
  const counts = { active: 0, recorded: 0, confirmed: 0, idle: 0, waiting: 0, unconfirmed: 0 };
  for (const worker of workers) {
    const state = agentExecutionDisplay(worker);
    if (state === 'running') { counts.active++; counts.confirmed++; }
    else if (state === 'recorded-running') { counts.active++; counts.recorded++; }
    else if (Object.hasOwn(counts, state)) counts[state]++;
  }
  return counts;
}


export function claudeUncertaintyLabel(reason, lang = 'zh') {
  if (lang !== 'zh') return reason;
  return {
    'No terminal event before session restart': '会话已重启，重启前没有收到该任务的结束事件；当前执行状态待确认。',
    'Owner no longer active; command completion not recorded': '所属代理已不再活动，未记录到命令结束；当前执行状态待确认。',
  }[reason] || reason;
}
