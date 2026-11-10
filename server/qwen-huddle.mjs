import { localQwen } from './local-qwen.mjs';
import { routeTask, maxConcurrentFor } from './task-runner.mjs';
import { normalizeTaskProject, REVIEWER_FOR } from './task-store.mjs';
import { huddleFingerprint, huddleRetryHold, huddleQuota, HUDDLE_INTERVAL_MS } from './huddle-policy.mjs';
import { resolutionPaused } from './resolution-policy.mjs';
import { humanRequestHold } from './human-relay-policy.mjs';
import { isBalance, isReviewLike, isHighRisk } from './division-policy.mjs';

const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', 'local-qwen': 'Qwen', grok: 'Grok' };
const iso = value => new Date(value).toISOString();
const order = task => ({ high: 0, normal: 1, low: 2 }[task.priority] ?? 1);
const emptyMeeting = () => ({ active: false, attendees: [], topic: '', startedAt: null, endsAt: null });

export function huddleCandidates(task, board, runtime, quota, now, limits, investigate = false) {
  const hold = humanRequestHold(task) || (resolutionPaused(task) ? '用户暂停或已被替代，保持暂停。' : investigate ? null : huddleRetryHold(task));
  if (hold) return { candidates: [], reason: hold };
  if (board.settings?.autoPickup === false) return { candidates: [], reason: '自动领取已暂停，只讨论、不分派。' };
  let project;
  try { project = normalizeTaskProject(task.projectPath, true); } catch { if (!investigate) return { candidates: [], reason: '项目目录不可用，需先恢复目录。' }; }
  if (!project && !investigate) return { candidates: [], reason: '缺少项目目录，需先补充。' };
  if (!['local-qwen', 'gemini'].includes(task.provider) && board.tasks.some(other => other.id !== task.id && !['local-qwen', 'gemini'].includes(other.provider) && ['running', 'pending'].includes(other.status) && other.projectPath === project)) return { candidates: [], reason: '同一项目已有执行或排队任务，等待项目工作位空闲。' };
  const route = routeTask(task, quota), failures = [], candidates = [];
  const ordinaryCoding = ['any', 'claude', 'codex'].includes(task.provider) && (task.kind || 'task') === 'task' && !isReviewLike(task) && !isBalance(task);
  const eligible = investigate ? ['codex', 'claude'] : [...new Set([...route.eligible, ...(ordinaryCoding ? routeTask({ ...task, provider: 'any' }, quota).eligible : [])])];
  const original = board.tasks.find(item => item.id === task.reviewOf);
  const reviewer = original?.assignee?.provider && REVIEWER_FOR[original.assignee.provider];
  for (const provider of eligible) {
    if (!investigate && task.kind === 'review' && (reviewer ? provider !== reviewer : provider !== task.provider)) { failures.push('独立审查必须保留对应审查员。'); continue; }
    const connection = runtime.providers?.[provider];
    if (!connection?.available || !connection.authenticated) { failures.push(`${names[provider]} 尚未连接或登录。`); continue; }
    const capacity = huddleQuota(provider, quota, task, now);
    if (!capacity.allowed) { failures.push(`${names[provider]}：${capacity.reason}`); continue; }
    const load = (runtime.running || []).filter(job => job.provider === provider).length + board.tasks.filter(item => item.id !== task.id && item.status === 'pending' && item.provider === provider && !resolutionPaused(item)).length;
    if (load >= maxConcurrentFor(provider, limits)) { failures.push(`${names[provider]} 的工作位已满。`); continue; }
    const preferred = investigate || isHighRisk(task) || isReviewLike(task) || isBalance(task) ? 'codex' : ['claude', 'codex'].includes(task.provider) ? task.provider : 'claude';
    candidates.push({ provider, fit: provider === preferred ? 100 : 80, remainingPercent: capacity.remainingPercent, load, reason: capacity.reason });
  }
  candidates.sort((a, b) => b.fit - a.fit || a.load - b.load || (b.remainingPercent ?? 100) - (a.remainingPercent ?? 100));
  return { candidates, reason: candidates.length ? '' : failures.join(' ') || route.reason || '没有符合此任务分工的可用执行代理。' };
}

function assessment(task, board, runtime, quota, now, limits) {
  const humanHold = humanRequestHold(task);
  if (humanHold) return { candidates: [], mode: 'human_reply', reason: humanHold, owner: 'local-qwen' };
  const resolution = task.resolution?.fingerprint === huddleFingerprint(task) ? task.resolution : null;
  const linked = board.tasks.find(item => item.id === resolution?.investigationTaskId);
  if (linked && ['pending', 'running'].includes(linked.status)) return { candidates: [], mode: 'follow_up',
    reason: linked.status === 'running' ? '负责人正在排查，结果会写回这张卡。' : '排查已分配，等待负责人和项目工作位；执行前会再次检查额度。', owner: linked.provider };
  // One bounded reassessment for legacy diagnoses which confused "read only"
  // with "the original owner cannot act". Never restart a paused/human-gated card.
  if (linked && ['blocked', 'done'].includes(linked.status) && linked.investigationPolicy !== 2 && !resolution?.clearance && !resolutionPaused(linked)) {
    return { ...huddleCandidates(task, board, runtime, quota, now, limits, true), mode: 'investigate' };
  }
  if (linked?.status === 'done' && !resolution?.clearance) return { candidates: [], mode: 'follow_up', reason: resolution.nextAction || '查看负责人的排查结论并补充所需条件。', owner: resolution.owner };
  // A failed investigator is handled on its own original card, never by spawning
  // an endless chain of investigator-for-investigator tasks.
  if (linked?.status === 'blocked') return { candidates: [], mode: 'follow_up', reason: resolution?.state === 'needs_user' && resolution.nextAction || `排查也受阻：${linked.error || linked.result || '需核对运行环境'}。Qwen 跟进原排查卡。`, owner: linked.provider };
  const retry = huddleCandidates(task, board, runtime, quota, now, limits);
  const needsInvestigation = !!huddleRetryHold(task) || !task.projectPath || /项目目录不可用/.test(retry.reason);
  if (needsInvestigation && task.kind !== 'resolution' && !linked) return { ...huddleCandidates(task, board, runtime, quota, now, limits, true), mode: 'investigate' };
  return { ...retry, mode: 'dispatch' };
}
const defaultOwner = task => ['claude', 'codex', 'gemini', 'local-qwen'].includes(task.provider) ? task.provider : 'local-qwen';

export function createQwenHuddle({ store, runtimeReader = () => ({}), quotaReader = () => null, qwenClient = localQwen,
  onDispatch = async () => {}, now = Date.now, intervalMs = HUDDLE_INTERVAL_MS, meetingMs = 75000, providerConcurrency } = {}) {
  let stopped = true, timer, pending, controller;
  const previous = store.readHuddle?.();
  let state = { phase: 'idle', lastCheckedAt: null, nextCheckAt: null,
    decisions: [], discussion: [], blockedCount: 0, reviewedCount: 0, cursor: 0, error: null,
    ...previous, ...(previous?.policyVersion === 3 ? {} : { lastCheckedAt: null, cursor: 0 }), policyVersion: 3, enabled: true, intervalMs, meeting: emptyMeeting() };
  const status = () => structuredClone({ ...state, meeting: { ...state.meeting, active: !stopped && state.meeting.active && now() < state.meeting.endsAt } });
  const save = () => store.saveHuddle?.(state);
  const readFacts = () => ({ board: store.snapshot({ recoverLeases: false }), runtime: runtimeReader(), quota: quotaReader() });
  async function scan() {
    const checkedAt = now();
    store.syncHumanRequests?.();
    let { board, runtime, quota } = readFacts();
    // Give every active blocked card a durable accountable owner, even when its
    // discussion slot comes later. This is responsibility, not a fake work claim.
    for (const task of board.tasks.filter(item => item.status === 'blocked' && !resolutionPaused(item))) {
      const check = assessment(task, board, runtime, quota, now(), providerConcurrency);
      const resolution = task.resolution?.fingerprint === huddleFingerprint(task) ? task.resolution : null;
      const owner = check.owner || check.candidates[0]?.provider || resolution?.owner || defaultOwner(task);
      const state = check.mode === 'human_reply' ? task.humanGate.state === 'denied' ? 'user_denied' : 'needs_user' : task.kind === 'resolution' && huddleRetryHold(task) ? 'needs_user' : check.mode === 'follow_up' ? resolution?.state || 'following_up' : check.candidates.length ? 'following_up' : 'waiting_capacity';
      const nextAction = resolution?.clearance && resolution?.nextAction || (check.mode === 'human_reply' && task.resolution?.nextAction) || check.reason || (check.mode === 'investigate' ? '负责人核对失败原因，给出调整方案、修复步骤及验证命令；排查完成后交回原任务执行。' : 'Qwen 要求负责人调整失败方案，实际修复、重新调试并提交验证结果。');
      try { store.recordResolution(task.id, { version: task.version, owner, state, nextAction, nextCheckAt: iso(checkedAt + intervalMs) }); } catch {}
    }
    board = store.snapshot({ recoverLeases: false });
    const blocked = board.tasks.filter(task => task.status === 'blocked' && !resolutionPaused(task)).sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
    const offset = blocked.length ? state.cursor % blocked.length : 0;
    const batch = [...blocked.slice(offset), ...blocked.slice(0, offset)].slice(0, 12);
    const attendees = ['local-qwen', ...Object.keys(names).filter(key => key !== 'local-qwen' && runtime.providers?.[key]?.available && runtime.providers[key].authenticated)];
    state = { ...state, lastCheckedAt: iso(checkedAt), nextCheckAt: iso(checkedAt + intervalMs), phase: batch.length ? 'discussing' : 'idle',
      blockedCount: blocked.length, reviewedCount: batch.length, cursor: blocked.length ? (offset + batch.length) % blocked.length : 0,
      decisions: [], discussion: [], error: null,
      meeting: batch.length ? { active: true, startedAt: checkedAt, endsAt: checkedAt + meetingMs, attendees, topic: `Qwen 召集：本轮查看 ${batch.length} 个受阻任务 · 核对分工与额度` } : emptyMeeting() };
    save();
    if (!batch.length || stopped) return status();
    const assessments = batch.map(task => ({ task, ...assessment(task, board, runtime, quota, now(), providerConcurrency) }));
    const source = { tasks: assessments.map(({ task, candidates, reason, mode }) => ({ taskId: task.id, title: task.title.slice(0, 160),
      mode, kind: task.kind, role: task.role, provider: task.provider,
      blocker: `${task.error || ''}\n${task.result || ''}`.slice(0, 650), holdReason: reason, candidates })) };
    let advice = { suggestions: [] };
    controller = new AbortController();
    try {
      advice = await qwenClient.discussBlocked(source, { signal: controller.signal });
      if (advice.summary) state.discussion.push({ provider: 'local-qwen', text: advice.summary.slice(0, 900) });
      for (const suggestion of advice.suggestions || []) {
        if (batch.some(task => task.id === suggestion.taskId) && suggestion.reason) state.discussion.push({ provider: 'local-qwen', taskId: suggestion.taskId, text: suggestion.reason.slice(0, 400) });
      }
    } catch { state.error = 'Qwen 暂时忙碌或不可用；下面仅显示系统核对结果，没有虚构讨论。'; }
    finally { controller = null; }
    if (stopped) return status();
    let dispatched = 0;
    for (const task of batch) {
      const current = readFacts(), latest = current.board.tasks.find(item => item.id === task.id);
      let decision = { taskId: task.id, title: task.title, provider: null, action: 'wait', remainingPercent: null, reason: '' };
      if (!latest || latest.status !== 'blocked' || latest.version !== task.version) decision.reason = '讨论期间任务已被更新，未修改原卡。';
      else {
        const fresh = assessment(latest, current.board, current.runtime, current.quota, now(), providerConcurrency);
        const preferred = advice.suggestions?.find(item => item.taskId === task.id)?.preferredProvider;
        const bestFit = fresh.candidates[0]?.fit;
        const selected = fresh.candidates.find(item => item.provider === preferred && item.fit === bestFit) || fresh.candidates[0];
        if (!selected) { decision.reason = fresh.reason; decision.provider = fresh.owner || latest.resolution?.owner || defaultOwner(latest); decision.action = 'follow_up'; }
        else if (dispatched >= 2) decision.reason = '本轮已安排两项任务，其余留到下一轮，避免集中消耗额度。';
        else {
          const reason = `${names[selected.provider]} 最符合本轮任务分工且已登录，${selected.reason} ${fresh.mode === 'investigate' ? '核对失败经验并制定具体修复与验证步骤；诊断完成不代表原任务完成。' : '立即按调整后的方案行动：检查已有成果、修复、重新调试并记录结果。'}`;
          try {
            if (fresh.mode === 'investigate') {
              const investigation = store.investigateBlockedTask(task.id, { version: latest.version, provider: selected.provider, reason });
              if (investigation.created) dispatched++;
              decision = { ...decision, ...selected, action: 'investigate', investigationTaskId: investigation.task.id, reason };
            } else {
              store.retryBlockedTask(task.id, { version: latest.version, provider: selected.provider, reason });
              dispatched++;
              decision = { ...decision, ...selected, action: 'dispatch', reason };
            }
          } catch { decision.reason = '分派前状态或自动领取设置改变，未重新启动。'; }
        }
      }
      state.decisions.push(decision);
    }
    state.phase = state.error ? 'unavailable' : dispatched ? 'dispatched' : 'waiting';
    store.syncHumanRequests?.();
    save();
    if (dispatched && !stopped) await onDispatch();
    return status();
  }
  function tick() {
    if (stopped) return Promise.resolve(status());
    if (!pending) pending = scan().catch(() => {
      state.phase = 'unavailable'; state.error = '讨论数据暂不可用，本轮未完成，等待下一轮。';
      state.lastCheckedAt = iso(now()); state.nextCheckAt = iso(now() + intervalMs);
      try { save(); } catch {} return status();
    }).finally(() => { pending = null; });
    return pending;
  }
  function schedule() {
    if (stopped) return;
    const last = Date.parse(state.lastCheckedAt), delay = Number.isFinite(last) ? Math.max(0, last + intervalMs - now()) : 0;
    state.nextCheckAt = iso(now() + delay);
    timer = setTimeout(async () => { await tick(); schedule(); }, delay); timer.unref?.();
  }
  return { status, tick,
    start() { if (!stopped) return status(); stopped = false; schedule(); return status(); },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await pending; state.meeting = emptyMeeting(); },
  };
}
