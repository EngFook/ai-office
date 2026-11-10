import { createHash } from 'node:crypto';
import { WATCH_RECIPIENTS, watchHoldReason } from './watch-task-policy.mjs';

const normalize = value => String(value || '').trim().replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/g, '<time>')
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/\b(?:session|worker|request)[_-]?(?:id)?\s*[:=]\s*\S+/gi, '<session>').replace(/\s+/g, ' ');
// Versions and timestamps are delivery metadata, never a new blocking point.
// A shared concrete error/result in the same project gets one consultation.
export const meetingScope = task => createHash('sha256').update(JSON.stringify([task.title, task.description, task.provider, task.role, task.projectPath])).digest('hex');
export function blockingKey(task) {
  const detail = normalize([task.error, task.result].filter(Boolean).join('\n')) || normalize([task.title, task.description].join('\n'));
  return createHash('sha256').update(JSON.stringify([task.projectPath, detail])).digest('hex');
}
export const meetingBlocked = task => task.status === 'blocked' && !watchHoldReason(task);
export function meetingBarrierAllows(task, record, retryAvailable = true) {
  if (!record || record.status !== 'resolved' || record.contextComplete === false) return false;
  const resolution = record.resolutions?.[task.id];
  if (resolution) return resolution.status === 'split' && resolution.scope === meetingScope(task);
  const representative = record.agendaRepresentatives?.find(card => card.scope === meetingScope(task));
  return retryAvailable && !!representative && WATCH_RECIPIENTS.includes(representative.provider === 'any' ? 'claude' : representative.provider);
}
const clean = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export function parseMeetingDecisions(value) {
  if (!Array.isArray(value?.decisions) || value.decisions.length > 100) throw new Error('Invalid meeting decisions.');
  const seen = new Set();
  return value.decisions.map(item => {
    if (!item || !clean(item.taskId, 240) || seen.has(item.taskId) || typeof item.resolved !== 'boolean' || !clean(item.evidence, 2000) || !['wait', 'retry', 'split'].includes(item.action)) throw new Error('Invalid meeting decision.');
    seen.add(item.taskId);
    const subtasks = item.subtasks || [];
    if (!Array.isArray(subtasks) || subtasks.length > 6 || subtasks.some(task => !clean(task.title, 200) || !clean(task.description, 4000) || !WATCH_RECIPIENTS.includes(task.provider))) throw new Error('Invalid meeting split.');
    if (item.action === 'split' && !subtasks.length) throw new Error('Empty meeting split.');
    return { taskId: item.taskId, resolved: item.resolved, evidence: item.evidence.trim(), action: item.action,
      subtasks: subtasks.map(({ title, description, provider }) => ({ title: title.trim(), description: description.trim(), provider })) };
  });
}
