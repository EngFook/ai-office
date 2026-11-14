// Default division of work between providers:
// - Claude: main implementation work.
// - Codex: game balance, serious bugs, release sign-off, and the final review of Claude's work.
// - Gemini: read-only research only; it never reviews or pre-reviews and never proposes balance changes.
// codexTier is informational only: routing holds Codex back only when its quota is exhausted (task-runner isLow).
// Free quota resets are never used automatically.
export const CODEX_LOW_PERCENT = 20;
export const CODEX_CRITICAL_PERCENT = 5;
const textOf = task => `${task?.title || ''}\n${task?.description || ''}`;
// Game-balance detection looks at the TITLE only (plus an explicit `Type: balance` line). Matching the whole
// description misrouted UI work to Codex when it merely mentioned names like "Codex Review & Balance".
export const isBalance = task => /^Type: balance$/mi.test(task?.description || '')
  || /\b(balance|balancing|tuning|economy|difficulty|drop rate)\b|平衡|数值|难度|掉落率|经济系统/i.test(String(task?.title || '').replace(/Review\s*&\s*Balance|审查与平衡/gi, ''));
export const isRelease = task => /\b(release|sign[- ]?off|ship|publish)\b|发布|上线验收|发版/i.test(textOf(task));
export const isHighRisk = task => task?.priority === 'high' || /^Risk: high$/m.test(task?.description || '') || isRelease(task)
  || /\b(security|auth|payment|purchase|save data|savegame|migration|data loss)\b|安全|支付|内购|存档|迁移|登录/i.test(textOf(task));
export function codexTier(remaining) {
  if (remaining == null) return 'normal';
  if (remaining < CODEX_CRITICAL_PERCENT) return 'critical';
  return remaining < CODEX_LOW_PERCENT ? 'low' : 'normal';
}
export const PRE_REVIEW_SUFFIX = ':prereview';
// Gemini does research only: it never reviews or pre-reviews. Kept as a no-op for old callers.
export function preReviewTaskFor() { return null; }
export const isReviewLike = task => (task?.kind === 'review') || /^(Pre-review|Review)\s*:/i.test(String(task?.title || '')) || /:(pre)?review$/.test(String(task?.id || ''));
