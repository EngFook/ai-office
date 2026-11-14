import { createHash } from 'node:crypto';

export const QWEN_DUTY_INTERVAL_MS = 15000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();
const summary = service => {
  const state = service?.status?.() || {};
  return { started: state.started === true, phase: state.phase || 'stopped', lastCheckedAt: state.lastCheckedAt || null,
    nextCheckAt: state.nextCheckAt || null, error: state.error || state.logSummary?.error || (state.logSummary?.sourceErrors?.length ? '部分运行记录来源不可用；值守将继续检查连接。' : null), ...(state.logSummary ? { logPhase: state.logSummary.phase } : {}) };
};

// Always-on oversight is a lightweight local service, not an invented model job.
// The existing huddle/runner retain sole authority over assignment, approvals,
// quotas and retries; only semantic changes wake them ahead of their own timers.
export function createQwenDuty({ store, runtimeReader = () => ({}), quotaReader = () => null,
  watch, huddle, workReports, enabled = true, now = Date.now,
  intervalMs = QWEN_DUTY_INTERVAL_MS, eventDelayMs = 1000, followUpMs = 30000, reportCheckMs = 60000 } = {}) {
  let started = false, timer, huddleHash, reportsHash, lastHuddleAt = -Infinity, lastReportsAt = -Infinity;
  const pending = new Map(), errors = new Map();
  let notifiedRuntime;
  let state = { heartbeatAt: null, lastCheckedAt: null, nextCheckAt: null, checks: 0, error: null, runningTasks: 0 };
  function status() {
    const services = { watch: summary(watch), huddle: summary(huddle), reports: summary(workReports) };
    const problem = state.error || [...errors.values()][0] || Object.values(services).find(item => item.error)?.error || null;
    const working = state.runningTasks > 0 || services.reports.phase === 'generating' || services.reports.logPhase === 'summarizing';
    return { ...state, enabled, started, intervalMs, phase: !started ? 'stopped' : problem ? 'degraded' : working ? 'working' : pending.has('watch') ? 'checking' : 'monitoring',
      error: problem, ...services };
  }
  function launch(name, service) {
    if (!started || !service?.tick || pending.has(name)) return false;
    const operation = Promise.resolve().then(() => {
      if (!started) return;
      return service.tick();
    }).then(() => { errors.delete(name); }, () => { errors.set(name, '值守服务暂时失败，下一轮会重新检查。'); })
      .finally(() => { pending.delete(name); });
    pending.set(name, operation);
    return true;
  }
  function schedule(delay = intervalMs) {
    if (!started) return;
    clearTimeout(timer);
    state.nextCheckAt = iso(now() + delay);
    timer = setTimeout(() => { tick(); }, delay);
    timer.unref?.();
  }
  function tick() {
    if (!started) return status();
    try {
      const board = store.snapshot({ recoverLeases: false }), runtime = runtimeReader(), quota = quotaReader();
      if (!Array.isArray(board?.tasks) || !runtime || typeof runtime !== 'object') throw new Error('Duty source unavailable');
      const checked = now(), tasks = board.tasks;
      // Ignore lease/heartbeat/version noise and our own next-check timestamps.
      // User replies, changed blockers, real job exits and capacity changes wake
      // a fresh assessment; repeated identical waiting cards do not call a model.
      const dispatchKey = hash({ autoPickup: board.settings?.autoPickup !== false, runnerStarted: runtime.started,
        tasks: tasks.filter(task => ['blocked', 'pending', 'running'].includes(task.status)).map(task => [task.id, task.status, task.provider, task.title, task.description, task.projectPath,
          task.error, task.result, task.humanGate, task.resolution?.clearance, task.resolution?.state, task.huddleRetry, task.reviewState, task.humanReplies]).sort((a, b) => a[0].localeCompare(b[0])),
        providers: Object.entries(runtime.providers || {}).map(([id, provider]) => [id, provider.available, provider.authenticated]),
        jobs: (runtime.running || []).map(job => [job.taskId, job.workerId, job.provider]),
        quota: Object.entries(quota || {}).map(([id, value]) => [id, value?.windows?.map(window => [window.remainingPercent, window.resetsAt]), typeof value === 'string' ? Boolean(value) : null]),
      });
      const completeKey = hash(tasks.filter(task => task.status === 'done').map(task => [task.id, task.provider, task.title, task.result, task.updatedAt, task.completionSource]).sort((a, b) => a[0].localeCompare(b[0])));
      state = { ...state, heartbeatAt: iso(checked), lastCheckedAt: iso(checked), checks: state.checks + 1,
        runningTasks: runtime.started === true && !runtime.unavailable ? (runtime.running || []).filter(job => job.provider === 'local-qwen' && job.taskId && !job.finished && (job.status == null || ['running', 'working'].includes(job.status))).length : 0,
        error: runtime.providers?.['local-qwen']?.available === false ? '本地模型连接不可用；值守仍在检查，恢复后继续处理。' : runtime.providers?.['local-qwen']?.authenticated === false ? '本地模型尚未就绪；值守仍在检查，模型恢复后继续处理。' : runtime.unavailable === true ? '运行状态来源暂不可用；值守仍在检查，恢复后继续处理。' : runtime.started === false ? '办公室执行器已停止；值守仍在检查，恢复执行器后才能接单。' : null };
      launch('watch', watch);
      const huddleRetryDue = huddle?.status?.().phase === 'unavailable' && checked - lastHuddleAt >= followUpMs;
      if ((dispatchKey !== huddleHash || huddleRetryDue) && checked - lastHuddleAt >= eventDelayMs && launch('huddle', huddle)) {
        huddleHash = dispatchKey; lastHuddleAt = checked;
      }
      const reportsState = workReports?.status?.() || {};
      const backlogDue = ['backfill', 'unavailable'].includes(reportsState.phase) && checked - lastReportsAt >= followUpMs;
      if ((completeKey !== reportsHash || backlogDue || checked - lastReportsAt >= reportCheckMs) && launch('reports', workReports)) {
        reportsHash = completeKey; lastReportsAt = checked;
      }
    } catch {
      state.error = '值守未能读取最新任务与运行状态；保留上次检查时间，下一轮重试。';
    }
    schedule();
    return status();
  }
  return { status, tick,
    // Coalesce HTTP edits and runner notifications; no extra worker or inference
    // is created for each event. A single timer continues without any browser.
    notify(runtime) {
      if (runtime) {
        const key = hash([runtime.started, (runtime.running || []).map(job => [job.taskId, job.workerId, job.provider]), Object.entries(runtime.providers || {}).map(([id, provider]) => [id, provider.available, provider.authenticated])]);
        if (key === notifiedRuntime) return;
        notifiedRuntime = key;
      }
      if (started && (!state.nextCheckAt || Date.parse(state.nextCheckAt) > now() + eventDelayMs)) schedule(eventDelayMs);
    },
    start() { if (started || !enabled) return status(); started = true; return tick(); },
    stop() { started = false; clearTimeout(timer); state.nextCheckAt = null; state.runningTasks = 0; return Promise.allSettled([...pending.values()]); },
  };
}
