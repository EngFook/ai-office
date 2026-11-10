import { createHash } from 'node:crypto';
import { quotaResetAt } from '../src/usage-utils.js';
import { isReviewLike } from './division-policy.mjs';
import { resolutionPaused, resolutionHumanGate } from './resolution-policy.mjs';

export const HUDDLE_INTERVAL_MS = 5 * 60000;
export const HUDDLE_MAX_RETRIES = 2;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const huddleInputHash = task => digest([task.title, task.description, task.projectPath, task.kind, task.reviewOf, task.role, task.supportType]);
export const huddleFingerprint = task => digest([huddleInputHash(task), task.error || '', task.result || '']);

// Only the recorded failure is evidence of a transient blocker. A task title,
// model suggestion, elapsed quota timer or lease expiry is never proof of recovery.
export function huddleRetryHold(task) {
  if (task.status !== 'blocked') return '任务状态已改变，留待下一轮核对。';
  if (['grok', 'grok-bot'].includes(task.provider)) return '此任务由外部 Grok 管理，等待原负责人处理。';
  if (task.role === 'Manager') return '管理职责不交给执行代理，等待管理团队处理。';
  if (resolutionPaused(task)) return '用户暂停或已被替代，保持暂停。';
  const failure = `${task.error || ''}\n${task.result || ''}`;
  const diagnosed = task.resolution?.fingerprint === huddleFingerprint(task) && ['resume', 'repair'].includes(task.resolution?.clearance);
  if (!diagnosed && resolutionHumanGate(task)) return '需要权限、登录或外部决定；先派负责人查明具体缺项。';
  const operational = /^(?:The office runner stopped\.|The task execution time limit was reached\.|(?:Codex|Claude Code) reported an execution failure\.|The agent ended without a structured completion confirmation\.|Gemini returned an empty research note\.)/.test(task.error || '');
  if (!diagnosed && !operational && /missing|not found|dependenc|lease expired|cancel|缺少|缺失|依赖|取消/i.test(failure)) return '先指派排查负责人，核实资料、依赖和原运行状态。';
  if (!diagnosed && !operational && !/\b429\b|rate.?limit|quota.{0,45}(?:exceed|exhaust|insufficient|limit)|(?:exceed|exhaust).{0,25}quota|usage limit|capacity (?:unavailable|exceeded|exhausted)|overload|temporar(?:y|ily) (?:unavailable|network|connection)|\b50[234]\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network error|connection (?:reset|refused)|额度.{0,12}(?:用完|耗尽|不足|超限)|限流|临时.*(?:连接|网络|故障)|连接.*(?:重置|拒绝)/i.test(failure)) return '先指派排查负责人，查清原因再恢复执行。';
  const previous = task.huddleRetry;
  if (previous?.inputHash === huddleInputHash(task)) {
    if (previous.attempts >= HUDDLE_MAX_RETRIES) return '已达到本任务的两次自动重试上限，需人工检查。';
    if (previous.fingerprints?.includes(huddleFingerprint(task)) && !(diagnosed && task.resolution.clearance === 'repair' && task.resolution.nextAction && task.resolution.nextAction !== previous.recoveryPlan)) return '相同阻塞已经重试过，等待新的信息，避免反复消耗额度。';
  }
  return null;
}

export function huddleQuota(provider, quota, task, now = Date.now()) {
  if (provider === 'local-qwen') return { allowed: true, remainingPercent: null, reason: '本地 Qwen 无订阅额度；仅承接已许可的辅助任务。' };
  const value = quota?.[provider], observed = typeof value?.observedAt === 'number' ? value.observedAt : Date.parse(value?.observedAt);
  if (quota?.[`${provider}Error`] || !Number.isFinite(observed) || observed > now + 60000 || now - observed > 30 * 60000 || !Array.isArray(value?.windows) || !value.windows.length) return { allowed: false, remainingPercent: null, reason: '额度未知或观测已过期，等待可靠的额度数据。' };
  const left = [];
  for (const window of value.windows) {
    const remaining = window.remainingPercent;
    const reset = quotaResetAt(window, observed);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100 || Number.isFinite(reset) && reset <= now) return { allowed: false, remainingPercent: null, reason: '额度窗口数据不完整或等待重置后的新观测。' };
    left.push(remaining);
  }
  const remainingPercent = Math.min(...left);
  if (remainingPercent <= 0) return { allowed: false, remainingPercent, reason: '至少一个额度窗口已耗尽，等待额度恢复。' };
  if (provider === 'claude' && remainingPercent < 20 && task.priority !== 'high' && !isReviewLike(task)) return { allowed: false, remainingPercent, reason: 'Claude 剩余额度不足 20%，保留给高优先级及审查任务。' };
  return { allowed: true, remainingPercent, reason: `最低额度窗口剩余 ${remainingPercent}%。` };
}
