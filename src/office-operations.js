import { officeExecutionCounts, officeRuntimeWorkers } from './claude-execution.js';
import { blockedWorkSummary, activeTaskJob } from './huddle-ui.js';

export const OFFICE_SNAPSHOT_MAX_AGE = 30000;
export function officeSnapshotStale({ lastSuccessAt, refreshError }, now = Date.now()) {
  return Boolean(refreshError) || !Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0 || now - lastSuccessAt > OFFICE_SNAPSHOT_MAX_AGE || lastSuccessAt > now + 5000;
}

// Different sources answer different questions: a board claim is a task, while
// a native session/subagent is a person. Never add those counts together.
export function officeOperations({ tasks = [], runtime = {}, humanRequests = [], roster = [], stale = false, loading = false, autoPickup = false } = {}) {
  const execution = officeExecutionCounts(officeRuntimeWorkers(roster));
  const claimed = tasks.filter(task => !stale && activeTaskJob(task, runtime));
  const claimedIds = new Set(claimed.map(task => task.id));
  const unverifiedClaims = tasks.filter(task => task.status === 'running' && !claimedIds.has(task.id));
  const blocked = blockedWorkSummary(tasks, stale ? {} : runtime, humanRequests);
  const pending = tasks.filter(task => task.status === 'pending');
  const running = roster.filter(agent => officeExecutionCounts(officeRuntimeWorkers([agent])).confirmed > 0);
  const awaiting = (runtime.pending || []).filter(item => pending.some(task => task.id === item.taskId));
  const questions = humanRequests.filter(request => ['pending', 'delivered'].includes(request.state) && tasks.some(task => task.id === request.taskId && task.status === 'blocked' && task.humanGate?.requestId === request.id));
  const recent = tasks.filter(task => task.status === 'done').sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 3);
  return { execution, claimed, unverifiedClaims, blocked, pending, running, awaiting, questions, recent,
    queueState: stale ? (loading ? 'loading' : 'unavailable') : runtime.started !== true ? 'stopped' : !autoPickup ? 'paused' : pending.length ? 'queued' : 'ready' };
}

export function operationsHeadline(model, zh = true) {
  const count = model.execution.confirmed;
  const pending = model.execution.recorded + model.execution.unconfirmed;
  if (model.queueState === 'loading') return zh ? `${count} 位代理运行 · 正在读取任务板` : `${count} agents running · loading board`;
  if (model.queueState === 'unavailable') return zh ? `${count} 位代理运行 · 任务板连接待恢复` : `${count} agents running · board connection unavailable`;
  return zh ? `${count} 位代理运行${pending ? ` · ${pending} 位状态待确认` : ''} · 任务板 ${model.claimed.length} 项执行`
    : `${count} agents running${pending ? ` · ${pending} unconfirmed` : ''} · ${model.claimed.length} board tasks executing`;
}
