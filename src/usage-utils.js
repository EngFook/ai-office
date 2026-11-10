// Read-only display helpers; quota and routing data are never changed here.
export const QUOTA = { 'Claude Code': ['claude', 'claudeError'], Claude: ['claude', 'claudeError'], Codex: ['codex', 'codexError'], Gemini: ['gemini', 'geminiError'], Grok: ['grok', 'grokError'] };
export const boundedPercent = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

export function tightestQuota(data, provider) {
  const providers = provider ? [provider] : ['Claude Code', 'Codex', 'Gemini', 'Grok'];
  const windows = providers.flatMap(name => {
    const [key, errorKey] = QUOTA[name] || [];
    // An old value with a current provider error must not imply available quota.
    if (!key || data?.quota?.[errorKey]) return [];
    return (data?.quota?.[key]?.windows || []).flatMap(window => {
      const remaining = boundedPercent(window.remainingPercent);
      return remaining == null ? [] : [{ provider: name, window, remaining }];
    });
  });
  return windows.sort((a, b) => a.remaining - b.remaining)[0] || null;
}

// CLI windows may supply a timestamp or a human reset time in Singapore time.
export function quotaResetAt(window, observedAt = Date.now()) {
  if (window.resetsAt && Number.isFinite(Number(window.resetsAt))) return Number(window.resetsAt);
  const text = String(window.resetsText || '').replace(/\(Asia\/Singapore\)|SGT/gi, '').trim();
  const relative = text.match(/^(?:in\s+)?(?:(\d+)\s*(?:d|days?)\s*)?(?:(\d+)\s*(?:h|hours?)\s*)?(?:(\d+)\s*(?:m|minutes?)\s*)?$/i);
  if (relative && relative.slice(1).some(Boolean)) return Number(observedAt) + ((Number(relative[1] || 0) * 24 + Number(relative[2] || 0)) * 60 + Number(relative[3] || 0)) * 60000;
  const time = text.match(/^(?:(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May\w*|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(\d{4}))?[,\s]*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (time) {
    const date = new Date(Number(observedAt) + 8 * 36e5);
    const month = time[1] ? ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(time[1].slice(0,3).toLowerCase()) : date.getUTCMonth();
    const hour = time[6] ? Number(time[4]) % 12 + (/pm/i.test(time[6]) ? 12 : 0) : Number(time[4]);
    let reset = Date.UTC(Number(time[3] || date.getUTCFullYear()), month, Number(time[2] || date.getUTCDate()), hour, Number(time[5] || 0)) - 8 * 36e5;
    if (reset < observedAt && !time[1]) reset += 864e5;
    if (reset < observedAt && time[1] && !time[3]) reset = Date.UTC(date.getUTCFullYear() + 1, month, Number(time[2]), hour, Number(time[5] || 0)) - 8 * 36e5;
    return reset;
  }
  return null;
}
