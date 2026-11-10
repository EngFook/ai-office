const PHASES = {
  idle: ['等待下次检查', 'Waiting for next check'],
  discussing: ['Qwen 正在分析', 'Qwen is analysing'],
  waiting: ['负责人持续跟进中', 'Owners are following up'],
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
  waiting_capacity: ['等待额度或空闲席位', 'Waiting for quota or capacity'],
  needs_user: ['需要你补充或确认', 'Your input is needed'],
  following_up: ['持续跟进', 'Following up'],
  paused: ['自动处理已暂停', 'Automatic action paused'],
}
export const resolutionStateLabel = (state, zh = false) => (RESOLUTION_STATES[state] || ['等待分配负责人', 'Awaiting an owner'])[zh ? 0 : 1]
export function blockedOwnership(tasks = []) {
  return tasks.filter(task => task.status === 'blocked').map(task => ({
    taskId: task.id, title: task.title, owner: task.resolution?.owner || null,
    state: task.resolution?.state || null, nextAction: task.resolution?.nextAction || '',
    checkedAt: task.resolution?.checkedAt, nextCheckAt: task.resolution?.nextCheckAt,
    investigationTaskId: task.resolution?.investigationTaskId, finding: task.resolution?.finding,
  }))
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
