// Presentation joins for saved task claims and live native sessions. No routing.
const providerNames = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'local-qwen': 'Local Qwen' };
export function taskMatchesAgent(task, agent, runtime = {}) {
  const assigned = task.assignee;
  const id = typeof assigned === 'string' ? assigned : assigned?.agentId || assigned?.id;
  if (id && (agent.id === id || agent.runtimeAgents?.some(worker => worker.id === id))) return true;
  const job = runtime.running?.find(item => item.taskId === task.id);
  return !!job && agent.runtimeAgents?.some(worker => worker.id === job.workerId || (job.sessionId && worker.isSubagent !== true && (worker.sessionId === job.sessionId || worker.id === job.sessionId)));
}
export function findTaskAgent(task, agents, runtime, providerHint) {
  const assigned = task.assignee;
  const name = typeof assigned === 'object' && assigned?.name;
  const provider = providerNames[providerHint || assigned?.provider || task.provider] || providerHint;
  return agents.find(agent => taskMatchesAgent(task, agent, runtime)) || agents.find(agent => name && agent.name === name) || agents.find(agent => agent.provider === provider);
}
export function modelReadiness(provider, runtime = {}, grok = {}) {
  if (provider === 'Grok') return grok.loading ? undefined : grok.error ? false : grok.connected;
  const key = Object.keys(providerNames).find(key => providerNames[key] === provider);
  const state = runtime.providers?.[key];
  if (!state || typeof state.available !== 'boolean' || typeof state.authenticated !== 'boolean') return undefined;
  return state.available && state.authenticated;
}

// Scene zone IDs remain unchanged: reviewers occupy zone 3, Gemini zone 4.
export const officeDepartmentFocus = index => `department-${index >= 3 ? index + 1 : index}`;
export const roomProvider = focus => ({'department-0':'Claude Code','department-1':'Codex','department-2':'Grok','department-4':'Gemini','department-5':'Local Qwen'})[focus];

// An installed/loaded model alone is not evidence of a running task.
export function localQwenConnection(runtime = {}) {
  const provider = runtime.providers?.['local-qwen'];
  return { agents: [], skills: [], connected: provider?.available === true && provider?.authenticated === true,
    pending: !provider, metadataAvailable: !!provider, loading: false, error: null };
}

// Provider representatives are connection affordances, never roster members or
// extra workers. A configured installation without a live connection is absent.
export function connectedProviderResidents({ claude = {}, codex = {}, grok = {}, runtime = {}, roster = [] } = {}) {
  const native = { claude, codex, grok };
  return Object.entries(providerNames).flatMap(([key, provider]) => {
    const workers = roster.filter(agent => agent.provider === provider && agent.liveStatus === 'working' && agent.runtimeAgents?.some(worker => worker.status === 'working' && worker.observed === true));
    const running = (Array.isArray(runtime.running) ? runtime.running : []).filter(job =>
      (job.provider === key || key === 'grok' && job.provider === 'grok-bot') && typeof job.taskId === 'string' && job.taskId.trim() &&
      job.finished !== true && (!job.status || ['running', 'working'].includes(job.status)));
    const activeTaskCount = new Set(running.map(job => job.taskId)).size;
    const state = native[key], readiness = runtime.providers?.[key];
    const connected = state?.connected === true && !state.error || readiness?.available === true && readiness?.authenticated === true && !readiness.error || workers.length > 0 || activeTaskCount > 0;
    if (!connected) return [];
    return [{ id: `resident:${key}`, key, provider, status: workers.length || activeTaskCount ? 'working' : 'idle', workingCount: workers.length, activeTaskCount }];
  });
}
