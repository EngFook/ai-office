import { createHash } from 'node:crypto';

export const WATCH_RECIPIENTS = ['claude', 'codex', 'gemini'];
// User-paused cards predate a dedicated pause field. Keep IDs as well as labels,
// including reviews/retry cards referring to one of these original cards.
const PAUSED_IDS = ['254f2a15', '6be29085', 'e7fa33c3', '847fec28', '2d278b15', '01de6905', '720668dc', '12e8a2d5', 'd7e12489', '8da3ec84'];
export function watchHoldReason(task) {
  const title = String(task.title || '');
  const text = [task.id, task.reviewOf, title, task.description, task.error, task.result].filter(Boolean).join('\n');
  if (task.status === 'parked' || task.parked === true || task.paused === true || /\bparked\b/i.test(title) || /(?:^|\n)\s*(?:\[|【)?parked(?:\]|】|[:：\s]|$)/i.test(text) || /用户暂停|用户叫停|已停用|superseded/i.test(title) || /(?:\[(?:用户暂停|用户叫停|已停用)[^\]]*\]|【(?:用户暂停|用户叫停|已停用)[^】]*】)/.test(text) || /(?:^|\n)\s*(?:\[|【)?(?:用户暂停|用户叫停|已停用)(?:\]|】|[:：\s]|$)/.test(text)) return '用户暂停或已停用，不能自动运行或重试。';
  if (PAUSED_IDS.some(id => text.includes(id)) || /(?:退界|tuijie|walkalone).*(?:一致性|text.consistency)/i.test(title)) return '退界一致性与既定调研卡由用户暂停。';
  return null;
}
export const watchOwners = task => task.provider === 'any' ? ['claude', 'codex'] : [task.provider];
export const watchFingerprint = task => createHash('sha256').update(JSON.stringify([task.id, task.provider, task.title, task.description, task.projectPath, task.error, task.result])).digest('hex');
