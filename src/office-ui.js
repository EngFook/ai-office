import { qwenContinuousDuty, qwenContinuousDutyLabel } from './local-qwen-desk.js';
import { officeExecutionCounts, officeRuntimeWorkers } from './claude-execution.js';

// Presentation joins for saved task claims and live native sessions. No routing.
const providerNames = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'local-qwen': 'Local Qwen' };
const providerName = key => key === 'grok-bot' ? 'Grok' : providerNames[key] || key;
export function taskMatchesAgent(task, agent, runtime = {}) {
  const assigned = task.assignee;
  const preference = assigned?.provider || task.provider;
  const provider = preference === 'any' ? undefined : providerName(preference);
  if (provider && provider !== agent.provider) return false;
  const id = typeof assigned === 'string' ? assigned : assigned?.agentId || assigned?.id;
  if (id && (agent.id === id || agent.runtimeAgents?.some(worker => worker.id === id))) return true;
  const job = !runtime.unavailable && runtime.running?.find(item => item.taskId === task.id);
  if (job?.provider && providerName(job.provider) !== agent.provider) return false;
  return !!job && agent.runtimeAgents?.some(worker => worker.id === job.workerId || (job.sessionId && worker.isSubagent !== true && (worker.sessionId === job.sessionId || worker.id === job.sessionId)));
}
export function findTaskAgent(task, agents, runtime = {}, providerHint) {
  const provider = providerName(providerHint);
  return agents.find(agent => (!provider || agent.provider === provider) && taskMatchesAgent(task, agent, runtime));
}
export function modelReadiness(provider, runtime = {}, grok = {}) {
  if (provider === 'Grok') return grok.loading ? undefined : grok.error ? false : grok.connected;
  const key = Object.keys(providerNames).find(key => providerNames[key] === provider);
  const state = runtime.providers?.[key];
  if (!state || typeof state.available !== 'boolean' || typeof state.authenticated !== 'boolean') return undefined;
  return state.available && state.authenticated;
}

// Scene zone IDs remain unchanged: Grok unblocking occupies legacy zone 3, Gemini zone 4.
export const officeDepartmentFocus = index => `department-${index >= 3 ? index + 1 : index}`;
export const roomProvider = focus => ({'department-0':'Claude Code','department-1':'Codex','department-2':'Grok','department-3':'Grok','department-4':'Gemini','department-5':'Local Qwen'})[focus];

// An installed/loaded model alone is not evidence of a running task.
export function localQwenConnection(runtime = {}) {
  const provider = runtime.providers?.['local-qwen'];
  return { agents: [], skills: [], connected: provider?.available === true && provider?.authenticated === true,
    pending: !provider, metadataAvailable: !!provider, loading: false, error: null };
}

// Lifecycle activity and confirmed execution are different evidence. Missing
// confirmation stays visible without being promoted to a running worker.
export function officeActivityCounts(agents = []) {
  const { confirmed, recorded } = officeExecutionCounts(officeRuntimeWorkers(agents));
  return { confirmed, recorded };
}

// Provider representatives are connection affordances, never roster members or
// extra workers. Grok's configured webhook keeps an on-demand representative
// after its heartbeat lease expires; this is not evidence of a live worker.
export function connectedProviderResidents({ claude = {}, codex = {}, grok = {}, grokWake = {}, runtime = {}, roster = [], qwenWatch } = {}) {
  const native = { claude, codex, grok };
  return Object.entries(providerNames).flatMap(([key, provider]) => {
    const activity = officeActivityCounts(roster.filter(agent => agent.provider === provider));
    const running = (runtime.started === true && !runtime.unavailable && Array.isArray(runtime.running) ? runtime.running : []).filter(job =>
      (job.provider === key || key === 'grok' && job.provider === 'grok-bot') && typeof job.taskId === 'string' && job.taskId.trim() &&
      job.finished !== true && (!job.status || ['running', 'working'].includes(job.status)));
    const activeTaskCount = new Set(running.map(job => job.taskId)).size;
    const state = native[key], readiness = !runtime.unavailable && runtime.providers?.[key];
    const connected = state?.connected === true && !state.error && state.metadataAvailable !== false || readiness?.available === true && readiness?.authenticated === true && !readiness.error || activity.confirmed > 0 || activity.recorded > 0 || activeTaskCount > 0;
    const onDemand = key === 'grok' && grokWake.configured === true;
    const duty = key === 'local-qwen' ? qwenContinuousDuty({ qwenWatch, runtime }) : null;
    if (!connected && !onDemand && !duty?.configured) return [];
    const status = activity.confirmed || activeTaskCount ? 'working' : activity.recorded ? 'recorded-active' : duty?.configured ? (duty.status === 'working' ? 'assisting' : duty.status) : connected ? 'idle' : grokWake.error ? 'unconfirmed' : 'on-demand';
    return [{ id: `resident:${key}`, key, provider, status, workingCount: activity.confirmed, recordedActiveCount: activity.recorded, activeTaskCount, ...(duty?.configured ? { duty } : {}) }];
  });
}

export function residentStatusLabel(resident, lang = 'en') {
  if (resident?.duty && !['working', 'recorded-active'].includes(resident.status)) return qwenContinuousDutyLabel(resident.duty, lang);
  const labels = lang === 'zh'
    ? { working: '运行中', 'recorded-active': '活动待确认', idle: '待命', 'on-demand': '按需唤醒', unconfirmed: '状态待确认' }
    : { working: 'Working', 'recorded-active': 'Activity unconfirmed', idle: 'Standby', 'on-demand': 'Wake on demand', unconfirmed: 'Status unconfirmed' };
  return labels[resident?.status] || labels.unconfirmed;
}


export function residentActivitySummary(resident, lang = 'en') {
  const zh = lang === 'zh';
  if (resident?.duty && !['working', 'recorded-active'].includes(resident.status)) return resident.duty.live
    ? (zh ? '本地助手持续巡检任务、跟进受阻和整理结果；模型按实际工作调用，值守不计入任务执行人数。' : 'The local assistant continuously checks tasks, follows blockers and organizes results. The model is invoked for actual work; supervision is not a task worker.')
    : (zh ? '本地助手值守未确认在线；查看助手工作台的心跳和恢复信息。' : 'Local supervision is not confirmed online. Open its desk for heartbeat and recovery details.');
  if (resident?.status === 'recorded-active') return zh ? '已记录代理活动；当前执行状态待确认。' : 'Agent activity was recorded; current execution is unconfirmed.';
  if (resident?.status === 'working') return zh ? '有已确认运行的会话或任务。' : 'A confirmed session or task is running.';
  return resident ? (zh ? '已连接，正在待命。' : 'Connected and standing by.') : (zh ? '没有在线代理会话。请检查连接。' : 'No live agent session. Check the provider connection to resume work.');
}
