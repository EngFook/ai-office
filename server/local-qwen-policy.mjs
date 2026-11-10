// Explicitly selected, preliminary text assistance only. Never part of `any` routing.
export const LOCAL_QWEN_TYPES = Object.freeze({
  'log-triage': 'Log / test output triage',
  'image-tags': 'Image tags from supplied captions',
  'copy-consistency': 'Copy consistency check',
  'changelog-check': 'CHANGELOG check',
});
export function localQwenTaskError(task = {}) {
  if (task.kind && task.kind !== 'task') return 'Local Qwen cannot research or review; use a coding provider for review.';
  if (!Object.hasOwn(LOCAL_QWEN_TYPES, task.supportType || '')) return 'Local Qwen requires one of the four supported assistance types.';
  if (task.role && !['any', 'Helper'].includes(task.role)) return 'Local Qwen only supports the Helper role.';
  if (typeof task.description !== 'string' || !task.description.trim() || task.description.length > 20000) return 'Supply up to 20000 characters of source text; Local Qwen cannot read files or images.';
  if (/^(?:pre-?review|review)\s*:|审查|代码审阅|最终产出|最终交付|写代码|修改代码|\b(code review|write code|implement|final deliverable|release sign.off)\b/i.test(task.title || '')) return 'Local Qwen cannot write code, review or produce final deliverables.';
  return null;
}
