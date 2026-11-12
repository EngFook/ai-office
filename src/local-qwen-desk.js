import { LOCAL_QWEN_TYPES } from '../server/local-qwen-policy.mjs';

export function qwenDutyState(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  if (value.enabled === false) return 'disabled';
  if (value.started === false || value.running === false || value.phase === 'stopped') return 'stopped';
  if (value.error || value.phase === 'unavailable' || value.logSummary?.error || value.logSummary?.phase === 'unavailable' && value.logSummary?.sourceErrors?.length) return 'unavailable';
  if (value.phase === 'attention') return 'attention';
  if (value.phase === 'waiting') return 'waiting';
  const started = value.started === true || value.running === true;
  if (started && value.logSummary?.phase === 'summarizing') return 'working';
  if (started && ['checking', 'discussing', 'summarizing', 'collecting', 'generating', 'running'].includes(value.phase)) return 'working';
  if (started) return 'scheduled';
  return value.enabled === true ? 'enabled' : 'unknown';
}

// Continuous supervision is a service activity, not an executing board worker.
// A loaded model or an enabled checkbox cannot establish a live heartbeat.
export function qwenContinuousDuty(state = {}, { stale = false, now = Date.now() } = {}) {
  const duty = state.qwenWatch?.duty;
  const provider = state.runtime?.providers?.['local-qwen'];
  const base = { configured: Boolean(duty && typeof duty === 'object'), heartbeatAt: duty?.heartbeatAt || null,
    lastCheckedAt: duty?.lastCheckedAt || null, nextCheckAt: duty?.nextCheckAt || null,
    intervalMs: duty?.intervalMs, checks: duty?.checks, error: duty?.error || null };
  if (!base.configured) return { ...base, status: 'unknown', live: false };
  if (stale || state.runtime?.unavailable) return { ...base, status: 'offline', live: false };
  if (duty.enabled === false || duty.phase === 'paused') return { ...base, status: 'paused', live: false };
  const heartbeat = typeof duty.heartbeatAt === 'number' ? duty.heartbeatAt : Date.parse(duty.heartbeatAt);
  const maxAge = Math.max(45000, Math.min(120000, Number(duty.intervalMs) * 3 || 45000));
  const live = duty.started === true && Number.isFinite(heartbeat) && heartbeat <= now + 5000 && now - heartbeat <= maxAge;
  if (!live || duty.phase === 'stopped') return { ...base, status: 'offline', live: false };
  const status = duty.error || duty.phase === 'degraded' ? 'degraded'
    : provider?.busy === true || duty.phase === 'working' ? 'working' : 'monitoring';
  return { ...base, status, live: true };
}

export function qwenContinuousDutyLabel(duty, lang = 'en') {
  const labels = lang === 'zh'
    ? { monitoring: '持续值守', working: '正在处理', degraded: '值守中 · 待恢复', offline: '连接中断', paused: '已暂停', unknown: '值守状态待确认' }
    : { monitoring: 'Continuously on duty', working: 'Processing now', degraded: 'On duty · recovery needed', offline: 'Connection interrupted', paused: 'Paused', unknown: 'Duty unconfirmed' };
  return labels[duty?.status] || labels.unknown;
}

const SOURCE_PROMPTS = {
  'log-triage': ['Paste the actual logs or test output, expected behavior and relevant timestamps.', '粘贴实际日志或测试输出、预期行为及相关时间。'],
  'image-tags': ['Paste a human-written image caption or metadata. Qwen cannot read the image itself.', '粘贴人工提供的图片说明或元数据；Qwen 无法读取图片本身。'],
  'copy-consistency': ['Paste the copy to compare, preferred terms and language requirements.', '粘贴需要比对的文案、约定用词及语言要求。'],
  'changelog-check': ['Paste the CHANGELOG entries and the change summary they should reflect.', '粘贴 CHANGELOG 条目及对应的实际改动摘要。'],
  'task-breakdown': ['Paste the real request, constraints and known dependencies to break into proposed steps.', '粘贴真实需求、约束与已知依赖，以拆分建议步骤。'],
  'handoff-summary': ['Paste completed work, evidence, remaining issues and the next owner to prepare a handoff draft.', '粘贴已完成工作、证据、剩余问题及下一位负责人，以整理交接草稿。'],
  'blocker-triage': ['Paste the blocker, failed attempts and their actual results to suggest a different next check.', '粘贴阻塞原因、已尝试的方法及实际结果，以建议调整后的排查步骤。'],
  'acceptance-checklist': ['Paste requirements and existing results to draft verifiable acceptance checks and missing evidence.', '粘贴需求及现有结果，以起草可验证的验收项和待补证据。'],
};
export function qwenSourcePrompt(supportType, lang = 'en') {
  return SOURCE_PROMPTS[supportType]?.[lang === 'zh' ? 1 : 0] || '';
}
export function qwenAssistanceDraft(supportType) {
  if (!Object.hasOwn(LOCAL_QWEN_TYPES, supportType)) return null;
  return { provider: 'local-qwen', role: 'Helper', supportType, title: LOCAL_QWEN_TYPES[supportType], description: '' };
}
