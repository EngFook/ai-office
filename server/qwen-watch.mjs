import { observeUsage } from './qwen-usage-watch.mjs';
import { quotaResetAt } from '../src/usage-utils.js';
import { createHash } from 'node:crypto';
import { readQwenPrerequisites } from './qwen-prerequisites.mjs';

export const WATCH_INTERVAL_MS = 5 * 60000;
export const WATCH_STALE_MS = 30 * 60000;
export const WATCH_LOW_PERCENT = 20;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const iso = value => new Date(value).toISOString();
const providerOf = task => String(task.assignee?.provider || task.provider || 'unknown');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const severityOf = type => ['failed', 'runner-missing'].includes(type) ? 'error' : ['blocked', 'stale', 'quota', 'quota-unavailable'].includes(type) ? 'warning' : 'info';
const taskBase = task => ({ taskId: task.id, provider: providerOf(task), projectPath: '', label: `${providerOf(task)} · ${task.id}` });
// A task ID survives retries. Associate telemetry only with the current claim,
// never a lingering job from the prior attempt or an unidentifiable worker.
function currentClaimJob(task, runtime) {
  if (!task.assignee?.id || !Array.isArray(runtime?.running)) return null;
  return runtime.running.find(job => {
    if (job.taskId !== task.id || !job.workerId || job.workerId !== task.assignee.id) return false;
    const provider = task.assignee.provider || task.provider;
    if (job.provider && provider && provider !== 'any' && job.provider !== provider) return false;
    const claimed = timestamp(task.updatedAt), started = timestamp(job.startedAt);
    if (job.startedAt != null && !Number.isFinite(started)) return false;
    if (Number.isFinite(claimed) && (!Number.isFinite(started) || started < claimed)) return false;
    return true;
  }) || null;
}


// Facts only. Titles, paths, results and raw errors are intentionally excluded.
// An external claim without a local job is not evidence of a stalled process.
export function watchIssues(board, runtime, quota, now = Date.now()) {
  const issues = [];
  for (const task of board.tasks || []) {
    const base = taskBase(task);
    if (['blocked', 'failed'].includes(task.status)) {
      issues.push({ ...base, key: `task:${task.id}:${task.status}:${digest([task.version, task.updatedAt])}`, type: task.status, severity: severityOf(task.status), detail: `任务${task.status === 'blocked' ? '受阻' : '失败'}；请核对原卡结果与依赖。` });
    } else if (task.status === 'running') {
      const job = currentClaimJob(task, runtime);
      const last = timestamp(job?.lastProgressAt || job?.startedAt);
      if (job && Number.isFinite(last) && last <= now && now - last >= WATCH_STALE_MS) issues.push({ ...base, key: `stale:${task.id}:${last}`, type: 'stale', severity: 'warning', detail: '已观测的办公室运行任务至少 30 分钟未记录输出或进度更新；心跳不算进度，请核对运行会话。' });
    }
  }
  for (const provider of ['claude', 'codex', 'gemini', 'grok']) {
    const value = quota?.[provider], observed = timestamp(value?.observedAt);
    if (!value && !quota?.[`${provider}Error`]) continue;
    const freshnessMs = provider === 'grok' ? 6 * 3600000 : 30 * 60000;
    if (quota?.[`${provider}Error`] || !Number.isFinite(observed) || observed > now + 60000 || now - observed > freshnessMs) {
      issues.push({ key: `quota-unavailable:${provider}`, type: 'quota-unavailable', provider, severity: 'warning', taskId: null, projectPath: '', label: `${provider} · quota`, detail: '额度观测不可用或已过期；无法确认当前额度，不据旧数据判断余额。' });
      continue;
    }
    for (const window of value?.windows || []) {
      const left = window.remainingPercent, reset = quotaResetAt(window, observed);
      if (typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > WATCH_LOW_PERCENT || Number.isFinite(reset) && reset <= now) continue;
      const name = String(window.name || window.windowMinutes || 'quota').slice(0, 120);
      const relative = /^(?:in\s+)?(?:\d+\s*(?:d|days?|h|hours?|m|minutes?)\s*)+$/i.test(String(window.resetsText || '').trim());
      const cycle = Number.isFinite(reset) && !relative ? reset : 'unknown-reset';
      issues.push({ key: `quota:${provider}:${name}:${cycle}`, type: 'quota', provider, severity: 'warning', taskId: null, projectPath: '', label: `${provider} · ${name}`, detail: `额度剩余 ${left}%，已达到 20% 提醒线；只报告，不重置额度、不购买额度、不切换账号。` });
    }
  }
  return issues;
}

export function createQwenWatch({ store, runtimeReader = () => ({}), quotaReader = () => null, projectPath = '', now = Date.now, intervalMs = WATCH_INTERVAL_MS, onChange = () => {}, publishReport = async () => {}, usageReader, readReport = async () => null, prerequisiteIds = readQwenPrerequisites('watch') } = {}) {
  let timer, pending, stopped = true;
  const seenTasks = new Map(), observedJobs = new Map(), queuedEvents = new Map();
  let previousIssues = new Set(), previousUsage = {}, restored = false;
  let state = { started: false, phase: 'stopped', lastCheckedAt: null, nextCheckAt: null, issues: [], events: [], progress: {}, usage: {}, error: null, observation: '' };
  const status = () => ({ ...state, issues: state.issues.map(issue => ({ ...issue })), events: state.events.map(event => ({ ...event })), progress: structuredClone(state.progress), usage: structuredClone(state.usage), intervalMs, staleMs: WATCH_STALE_MS, lowPercent: WATCH_LOW_PERCENT, noQuota: true, summarySource: 'structured-facts' });
  const notify = () => { try { onChange(); } catch {} };
  async function collect() {
    // snapshot's normal lease recovery is a write; patrols must be pure readers.
    const board = store.snapshot({ recoverLeases: false }), runtime = runtimeReader(), quota = usageReader ? null : quotaReader(), checked = now();
    const tasks = board.tasks || [], progress = {}, issues = watchIssues(board, runtime, quota, checked);
    const liveIds = new Set();
    for (const task of tasks) {
      const provider = providerOf(task), previous = seenTasks.get(task.id), status = String(task.status || 'unknown');
      liveIds.add(task.id);
      const counts = progress[provider] ||= { total: 0, pending: 0, running: 0, done: 0, blocked: 0, failed: 0 };
      counts.total++; const countKey = Object.hasOwn(counts, status) && status !== 'total' ? status : 'unknown'; counts[countKey] = (counts[countKey] || 0) + 1;
      if ((previous && previous.status !== status) || (!previous && ['running', 'blocked', 'failed'].includes(status))) {
        const occurred = timestamp(task.updatedAt);
        const key = `state:${task.id}:${status}:${digest([task.version, task.updatedAt, provider])}`;
        queuedEvents.set(key, { key, type: status, taskId: task.id, provider, severity: severityOf(status), detail: `任务状态：${previous ? `${previous.status} → ` : ''}${status}。`, occurredAt: iso(Number.isFinite(occurred) && occurred <= checked ? occurred : checked) });
      }
      seenTasks.set(task.id, { status });
      const job = currentClaimJob(task, runtime);
      const claim = digest([task.assignee?.id, task.version, task.updatedAt]);
      if (status !== 'running' || observedJobs.get(task.id)?.claim !== claim) observedJobs.delete(task.id);
      if (status === 'running' && job) observedJobs.set(task.id, { identity: job.sessionId || job.workerId || job.startedAt || 'observed', claim });
      else if (status === 'running' && Array.isArray(runtime?.running) && observedJobs.has(task.id)) {
        const observed = observedJobs.get(task.id);
        issues.push({ ...taskBase(task), key: `runner-missing:${task.id}:${digest(observed.identity)}`, type: 'runner-missing', severity: 'error', detail: '此前实际观测到的办公室运行任务已不在 runner 列表，但原卡仍为 running；请人工核对进程与任务状态。' });
      }
    }
    for (const id of seenTasks.keys()) if (!liveIds.has(id)) { seenTasks.delete(id); observedJobs.delete(id); }
    for (const issue of issues) {
      if (['blocked', 'failed'].includes(issue.type) || previousIssues.has(issue.key)) continue;
      const key = `issue:${issue.key}`;
      queuedEvents.set(key, { key, type: issue.type, taskId: issue.taskId, provider: issue.provider, severity: issue.severity, detail: issue.detail, occurredAt: iso(checked) });
    }
    previousIssues = new Set(issues.map(issue => issue.key));
    const observed = usageReader ? observeUsage(await usageReader(), previousUsage, checked) : { usage: {}, issues: [], events: [] };
    issues.push(...observed.issues);
    return { checkedAt: iso(checked), issues, progress, usage: observed.usage, usageEvents: observed.events, ready: prerequisiteIds.every(id => tasks.some(task => task.id === id && task.status === 'done')) };
  }
  async function publish(facts, phase, observation, error) {
    for (const event of facts.usageEvents || []) queuedEvents.set(event.key, event);
    const report = { checkedAt: facts.checkedAt, phase, issues: facts.issues, events: [...queuedEvents.values()], progress: facts.progress, usage: facts.usage || {}, observation, error };
    state = { ...state, phase, lastCheckedAt: report.checkedAt, issues: report.issues, events: report.events, progress: report.progress, usage: report.usage, observation, error };
    try {
      await publishReport(structuredClone(report));
      previousUsage = report.usage;
      for (const event of report.events) queuedEvents.delete(event.key);
    } catch {
      state.phase = 'unavailable'; state.error = '巡查报告发布失败；结构化事实与事件已保留，下次巡查重试发布。';
    }
    notify(); return status();
  }
  async function scan() {
    let facts;
    try {
      if (!restored) { previousUsage = (await readReport())?.current?.usage || {}; state.usage = structuredClone(previousUsage); restored = true; }
      facts = await collect();
    }
    catch { if (stopped) return status(); return publish({ checkedAt: iso(now()), issues: state.issues, progress: state.progress, usage: state.usage }, 'unavailable', '', '巡查数据读取失败；当前事实未刷新，不能判断健康状态。'); }
    if (stopped) return status();
    if (!facts.ready) return publish(facts, 'waiting', '', null);
    // Counts and current quota facts are deterministic. Running a language model
    // over a status snapshot wastes the single local slot and can invent facts.
    const counts = Object.values(facts.progress).reduce((sum, row) => {
      for (const key of ['pending', 'running', 'done', 'blocked', 'failed']) sum[key] += Number.isSafeInteger(row[key]) ? row[key] : 0;
      return sum;
    }, { pending: 0, running: 0, done: 0, blocked: 0, failed: 0 });
    const observation = `直接观测：任务板待处理 ${counts.pending} 项、运行 ${counts.running} 项、完成 ${counts.done} 项、受阻 ${counts.blocked} 项、失败 ${counts.failed} 项；本轮 ${facts.issues.length} 项提醒。运行数仅包含任务板记录，原生代理请查看对应工作室。额度未知或过期时保持未知，受阻分工以本轮集结记录为准。`;
    return publish(facts, facts.issues.length ? 'attention' : 'healthy', observation, null);
  }

  function tick() {
    if (stopped) return Promise.resolve(status());
    if (!pending) pending = scan().catch(() => { state.phase = 'unavailable'; state.error = '巡查暂不可用；将在下次巡查重试。'; notify(); return status(); }).finally(() => { pending = null; });
    return pending;
  }
  return {
    status, tick,
    start() {
      if (!stopped) return tick();
      stopped = false; state.started = true;
      const schedule = () => { state.nextCheckAt = iso(now() + intervalMs); };
      schedule(); timer = setInterval(() => { schedule(); void tick(); }, intervalMs); timer.unref?.();
      return tick();
    },
    async stop() { stopped = true; clearInterval(timer); await pending; state.started = false; state.phase = 'stopped'; state.nextCheckAt = null; },
  };
}
