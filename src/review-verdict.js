// A review completing is distinct from approval. Only an explicit leading
// verdict is machine-actionable; prose mentioning an approval is not one.
export function parseReviewVerdict(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim().split(/\r?\n/, 1)[0].replace(/^#{1,6}\s+/, '').replace(/^\*\*/, '');
  if (/^APPROVED(?:\*\*)?\s*(?:[:：]|$)/i.test(line)) return 'approved';
  if (/^FIX NOTES(?:\*\*)?\s*(?:[:：]|$)/i.test(line)) return 'changes_requested';
  return null;
}
