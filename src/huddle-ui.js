import { humanRequestNeedsUser } from './human-relay-ui.js'

const PHASES = {
  idle: ['等待下次检查', 'Waiting for next check'],
  discussing: ['Qwen 正在分析', 'Qwen is analysing'],
  waiting: ['等待下一步条件', 'Waiting for next-step conditions'],
  dispatched: ['已提交分配，请查看任务状态', 'Assignment submitted — see task status'],
  unavailable: ['Qwen 暂不可用', 'Qwen unavailable'],
}
export const huddleProviderLabel = key => ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'grok-bot': 'Grok Bot', 'local-qwen': 'Qwen' })[key] || key || '—'
export function huddlePhaseLabel(huddle, zh = false) {
  if (!huddle?.enabled) return zh ? '集结检查尚未启用' : 'Huddle checks not enabled'
  return (PHASES[huddle.phase] || [ '状态待确认', 'Status unavailable' ])[zh ? 0 : 1]
}
export function huddleQuotaLabel(value, zh = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? (zh ? `剩余额度 ${Math.round(value)}%` : `${Math.round(value)}% quota remaining`)
    : (zh ? '额度未知' : 'Quota unknown')
}

const RESOLUTION_STATES = {
  queued: ['排队处理', 'Queued for action'],
  investigating: ['正在排查', 'Investigating'],
  repairing: ['正在修复', 'Repairing'],
  reviewing: ['正在审查', 'Reviewing'],
  changes_requested: ['审查要求修复', 'Review requires fixes'],
  waiting_capacity: ['等待额度或空闲席位', 'Waiting for quota or capacity'],
  awaiting_capacity: ['等待额度或空闲席位', 'Waiting for quota or capacity'],
  user_denied: ['用户已拒绝 · 保持暂停', 'Declined by user · paused'],
  needs_user: ['需要你补充或确认', 'Your input is needed'],
  following_up: ['等待下一次核查', 'Awaiting next check'],
  awaiting_execution: ['尚未确认执行', 'Execution not confirmed'],
  grok_check: ['待 Grok 核查', 'Awaiting Grok check'],
  awaiting_question: ['待核对用户问题', 'User question needs verification'],
  paused: ['自动处理已暂停', 'Automatic action paused'],
}
export const resolutionStateLabel = (state, zh = false) => (RESOLUTION_STATES[state] || ['等待分配负责人', 'Awaiting an owner'])[zh ? 0 : 1]
export function taskHumanStage(task, requests = []) {
  const gate = task?.humanGate
  const request = requests.find(item => item.id === gate?.requestId && item.taskId === task.id)
  // Count the same bound questions as the reply panel. Coordination notes alone
  // do not prove that a question exists or is waiting for the user.
  if (task?.status === 'blocked' && request && ['pending', 'delivered', 'denied'].includes(request.state)) {
    return request.state === 'denied' ? 'user_denied' : humanRequestNeedsUser(request) ? 'needs_user' : 'grok_check'
  }
  if (gate?.state === 'denied' || task?.resolution?.state === 'user_denied') return 'user_denied'
  return null
}
export function activeTaskJob(task, runtime = {}) {
  return task?.status === 'running' && runtime?.started === true && !runtime?.unavailable &&
    (runtime?.running || []).find(job => job.taskId === task.id && !job.finished && (!job.status || ['working', 'running'].includes(job.status))) || null
}
export function blockedWorkTask(original, tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const review = byId.get(original?.reviewTaskId)
  const repair = byId.get(original?.reviewRepairTaskId)
  const validReview = review && (review.reviewOf === original.id || review.reviewBinding?.rootId === original.id)
  const validRepair = repair && repair.repairOf === original.id
  if (original?.reviewState === 'pending' && validReview) return { task: review, kind: 'review' }
  if (validRepair) return { task: repair, kind: 'repair' }
  if (['blocked', 'stale'].includes(original?.reviewState) && validReview) return { task: review, kind: 'review' }
  const investigation = byId.get(original?.resolution?.investigationTaskId)
  return investigation ? { task: investigation, kind: 'investigation' } : { task: original, kind: 'task' }
}
export function blockedOwnership(tasks = [], runtime = {}, requests = []) {
  return tasks.filter(task => task.status === 'blocked').map(task => {
    const work = blockedWorkTask(task, tasks)
    const linked = work.task?.id !== task.id ? work.task : null
    const job = activeTaskJob(linked, runtime)
    const humanState = taskHumanStage(task, requests)
    const state = humanState === 'user_denied' ? 'user_denied'
      : task.paused || task.parked || task.resolution?.state === 'paused' ? 'paused'
      : humanState || (job ? ({ repair: 'repairing', review: 'reviewing' }[work.kind] || 'investigating') : linked?.status === 'pending' ? 'queued'
        : linked?.status === 'running' || ['investigating', 'repairing', 'reviewing'].includes(task.resolution?.state) ? 'awaiting_execution' : task.reviewState === 'changes_requested' ? 'changes_requested' : task.resolution?.state === 'needs_user' ? 'awaiting_question' : task.resolution?.state || null)
    return {
      taskId: task.id, title: task.title, owner: task.resolution?.owner || null,
      executor: ['investigating', 'repairing', 'reviewing'].includes(state) ? job?.provider || null : null,
      workTaskId: linked?.id || null, workKind: work.kind,
      state, nextAction: task.resolution?.nextAction || '',
      checkedAt: task.resolution?.checkedAt, nextCheckAt: task.resolution?.nextCheckAt,
      investigationTaskId: task.resolution?.investigationTaskId, finding: task.resolution?.finding,
    }
  })
}
export function blockedWorkSummary(tasks = [], runtime = {}, requests = []) {
  const ownership = blockedOwnership(tasks, runtime, requests)
  const active = ownership.filter(item => !['paused', 'user_denied'].includes(item.state))
  return {
    ownership, active, paused: ownership.length - active.length,
    actionable: active.filter(item => !['needs_user', 'grok_check'].includes(item.state)).length,
    needsUser: active.filter(item => item.state === 'needs_user').length,
    grokCheck: active.filter(item => item.state === 'grok_check').length,
    investigating: active.filter(item => item.state === 'investigating').length,
    repairing: active.filter(item => item.state === 'repairing').length,
    reviewing: active.filter(item => item.state === 'reviewing').length,
    working: active.filter(item => ['investigating', 'repairing', 'reviewing'].includes(item.state)).length,
  }
}
export function huddleActionLabel(action, zh = false) {
  const labels = {
    dispatch: ['提交分配', 'Assignment submitted'],
    investigate: ['已安排排查', 'Investigation assigned'],
    follow_up: ['负责人跟进', 'Owner follow-up'],
    wait: ['检查后继续跟进', 'Follow-up after check'],
  }
  return (labels[action] || ['查看处理记录', 'View action record'])[zh ? 0 : 1]
}

// Assignment and actual execution are separate facts. Prefer the bound worker
// task and the runner's current wait reason over a previous huddle's wording.
export function huddleTaskProgress(taskId, tasks = [], runtime = {}, settings = {}, zh = false, requests = []) {
  const original = tasks.find(task => task.id === taskId)
  if (!original) return { status: 'missing', label: zh ? '任务已移除' : 'Task removed', detail: '' }
  const work = blockedWorkTask(original, tasks), task = work.task
  const noun = zh ? ({ investigation:'排查', repair:'修复', review:'审查' }[work.kind] || '任务') : ({ investigation:'Investigation', repair:'Repair', review:'Review' }[work.kind] || 'Task')
  if (original.humanGate?.state === 'denied' || original.paused || original.parked || ['paused', 'user_denied'].includes(original.resolution?.state)) return { status: 'paused', label: zh ? '已暂停／拒绝' : 'Paused / declined', detail: original.resolution?.nextAction || '' }
  const humanState = taskHumanStage(original, requests)
  if (humanState === 'user_denied') return { status: 'paused', label: zh ? '已暂停／拒绝' : 'Paused / declined', detail: '' }
  if (humanState) return { status: humanState, label: humanState === 'needs_user' ? (zh ? '待你决定／补资料' : 'Your decision / information needed') : (zh ? '待 Grok 核查' : 'Awaiting Grok check'), detail: '' }
  if (task.status === 'running' && !activeTaskJob(task, runtime)) return { status: 'unconfirmed', label: zh ? '已记录运行 · 尚未确认执行' : 'Recorded running · execution unconfirmed', detail: zh ? '当前执行器没有对应工作记录，请查看任务详情。' : 'No matching job in the current runner snapshot. Check task details.' }
  if (activeTaskJob(task, runtime)) return { status: 'running', label: zh ? `${noun}正在执行` : `${noun} running`, detail: '' }
  if (task.status === 'pending') {
    const reason = runtime.started === false ? (zh ? '办公室执行器已停止，尚未启动。' : 'The office runner is stopped; execution has not started.')
      : settings.autoPickup === false ? (zh ? '自动领取已暂停，尚未启动。' : 'Automatic pickup is paused; execution has not started.')
      : runtime.pending?.find(item => item.taskId === task.id)?.reason || (zh ? '等待执行器核对额度、登录和空闲工作位。' : 'Waiting for the runner to check quota, authentication and worker capacity.')
    return { status: 'pending', label: zh ? `${work.kind === 'task' ? '' : noun}已排队 · 未开始` : `${work.kind === 'task' ? 'Queued' : noun + ' queued'} · not started`, detail: reason }
  }
  if (task.status === 'done') return { status: 'done', label: zh ? (work.kind === 'review' ? '审查已完成 · 查看结论' : work.kind !== 'task' ? `${noun}已完成 · 原任务待继续` : '任务已完成') : (work.kind === 'review' ? 'Review complete · check verdict' : work.kind !== 'task' ? `${noun} complete · original task remains` : 'Task complete'), detail: original.resolution?.nextAction || '' }
  return { status: 'blocked', label: zh ? `${noun}仍受阻` : `${noun} blocked`, detail: task.error || original.resolution?.nextAction || '' }
}
