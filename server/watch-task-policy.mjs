import { createHash } from 'node:crypto';

export const WATCH_RECIPIENTS = ['claude', 'codex', 'gemini'];
// User-specific legacy holds belong to local configuration, never published source.
let pausedIds = [];
export function configureWatchHolds(ids = []) { pausedIds = [...ids]; }
export function watchHoldReason(task) {
  const title = String(task.title || '');
  const text = [task.id, task.reviewOf, title, task.description, task.error, task.result].filter(Boolean).join('\n');
  if (task.status === 'parked' || task.parked === true || task.paused === true || /\bparked\b/i.test(title) || /(?:^|\n)\s*(?:\[|【)?parked(?:\]|】|[:：\s]|$)/i.test(text) || /用户暂停|用户叫停|已停用|superseded/i.test(title) || /(?:\[(?:用户暂停|用户叫停|已停用)[^\]]*\]|【(?:用户暂停|用户叫停|已停用)[^】]*】)/.test(text) || /(?:^|\n)\s*(?:\[|【)?(?:用户暂停|用户叫停|已停用)(?:\]|】|[:：\s]|$)/.test(text)) return '用户暂停或已停用，不能自动运行或重试。';
  if (pausedIds.some(id => [task.id, task.reviewOf, task.resolutionOf].some(value => value === id || String(value || '').startsWith(id + ':')))) return '本机配置明确暂停此任务。';
  return null;
}
export const watchOwners = task => task.provider === 'any' ? ['claude', 'codex'] : [task.provider];
export const watchFingerprint = task => createHash('sha256').update(JSON.stringify([task.id, task.provider, task.title, task.description, task.projectPath, task.error, task.result])).digest('hex');
