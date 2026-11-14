// Explicitly selected, preliminary text assistance only. Never part of `any` routing.
export const LOCAL_QWEN_SOURCE_BYTES = 24000;
export const LOCAL_QWEN_TYPES = Object.freeze({
  'log-triage': 'Log / test output triage',
  'image-tags': 'Image tags from supplied captions',
  'copy-consistency': 'Copy consistency check',
  'changelog-check': 'CHANGELOG check',
  'task-breakdown': 'Task breakdown',
  'handoff-summary': 'Handoff summary',
  'blocker-triage': 'Blocker triage',
  'acceptance-checklist': 'Acceptance checklist',
});
// Shared by task validation and inference: budget the actual encoded user message,
// including only a clarification bound to the current answered question.
export function localQwenAssistanceContent(task = {}) {
  const requestId = task.humanGate?.requestId;
  const boundClarification = task.humanGate?.state === 'answered' && typeof requestId === 'string' && requestId.trim() && requestId === task.humanReply?.requestId;
  return JSON.stringify({ assistance: LOCAL_QWEN_TYPES[task.supportType], sourceText: task.description,
    ...(boundClarification ? { userClarification: { question: task.humanReply.question, reply: task.humanReply.userReply } } : {}) });
}
export function localQwenTaskError(task = {}) {
  if (task.kind && task.kind !== 'task') return 'Local Qwen cannot research or review; use a coding provider for review.';
  if (!Object.hasOwn(LOCAL_QWEN_TYPES, task.supportType || '')) return 'Local Qwen requires an explicitly supported assistance type for supplied text.';
  if (task.role && !['any', 'Helper'].includes(task.role)) return 'Local Qwen only supports the Helper role.';
  if (typeof task.description !== 'string' || !task.description.trim() || task.description.length > 20000) return 'Supply up to 20000 characters of source text; Local Qwen cannot read files or images.';
  if (new TextEncoder().encode(task.description).length > LOCAL_QWEN_SOURCE_BYTES) return '资料超过本地上下文预算：最多 20000 字符且不超过 24000 UTF-8 字节，请缩短或拆分。 Source text must fit both 20000 characters and 24000 UTF-8 bytes; shorten or split it.';
  if (new TextEncoder().encode(localQwenAssistanceContent(task)).length > LOCAL_QWEN_SOURCE_BYTES) return '资料及补充说明超过本地上下文预算，请缩短或拆分后再提交。 Local context budget exceeded: source and bound clarification must fit 24000 bytes; shorten or split them.';
  if (/^(?:pre-?review|review)\s*:|审查|代码审阅|最终产出|最终交付|写代码|修改代码|\b(code review|write code|implement|final deliverable|release sign.off)\b/i.test(task.title || '')) return 'Local Qwen cannot write code, review or produce final deliverables.';
  return null;
}
