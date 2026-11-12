// Read-only display helpers; quota and routing data are never changed here.
export const QUOTA = { 'Claude Code': ['claude', 'claudeError'], Claude: ['claude', 'claudeError'], Codex: ['codex', 'codexError'], Gemini: ['gemini', 'geminiError'], Grok: ['grok', 'grokError'] };
export const boundedPercent = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
// Legacy sources can turn a missing usedPercent into 100% remaining. A present
// but invalid source value must invalidate that derived balance at the UI edge.
export const validQuotaUsed = window => window && (!Object.hasOwn(window, 'usedPercent') || typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100);
export const quotaRemaining = window => validQuotaUsed(window) ? boundedPercent(window.remainingPercent) : null;
export function quotaFresh(quota, provider, now = Date.now()) {
  const observed = typeof quota?.observedAt === 'number' ? quota.observedAt : Date.parse(quota?.observedAt);
  const key = QUOTA[provider]?.[0];
  const maxAge = key === 'codex' ? 3 * 60000 : key === 'grok' ? 6 * 3600000 : 15 * 60000;
  return Number.isFinite(observed) && observed <= now + 60000 && now - observed <= maxAge;
}

export function tightestQuota(data, provider, now = Date.now()) {
  const providers = provider ? [provider] : ['Claude Code', 'Codex', 'Gemini', 'Grok'];
  const windows = providers.flatMap(name => {
    const [key, errorKey] = QUOTA[name] || [];
    // An old value with a current provider error must not imply available quota.
    if (!key || data?.quota?.[errorKey] || !quotaFresh(data?.quota?.[key],name,now)) return [];
    return (data?.quota?.[key]?.windows || []).flatMap(window => {
      const reset=quotaResetAt(window,data.quota[key].observedAt);
      if(reset && reset<=now)return [];
      const remaining = quotaRemaining(window);
      return remaining == null ? [] : [{ provider: name, window, remaining }];
    });
  });
  return windows.sort((a, b) => a.remaining - b.remaining)[0] || null;
}

// Connection health and a provider's quota are separate facts. In particular,
// successful Gemini model discovery is never evidence of unlimited capacity.
export function providerQuotaStatus(data, provider, { now = Date.now(), error = null, loading = false } = {}) {
  const [key, errorKey] = QUOTA[provider] || [];
  const quota = key && data?.quota?.[key];
  const providerError = error || (errorKey && data?.quota?.[errorKey]);
  if (error) return { state: 'unavailable', quota: null };
  if (tightestQuota(data, provider, now)) return { state: 'ready', quota };
  if (key === 'gemini') {
    const connection = data?.quota?.geminiStatus;
    const checkedAt = connection?.checkedAt || quota?.observedAt || null;
    if (connection?.needsLogin || connection?.authState === 'needs-login' || /needs login|please (?:sign|log) ?in|not (?:signed|logged) ?in/i.test(providerError || '')) {
      return { state: 'needs-login', quota, checkedAt, loginCommand: connection?.loginCommand || null };
    }
    if (!providerError && quotaFresh(quota, provider, now) && (quota?.authenticated || quota?.authState === 'ready' || quota?.status === 'Subscription login')) {
      return { state: 'quota-unsupported', quota, checkedAt };
    }
    return { state: loading ? 'checking' : providerError ? 'unavailable' : quota ? 'stale' : 'unconfirmed', quota, checkedAt };
  }
  if (key === 'grok') {
    const report = data?.quota?.grokStatus;
    const resetExpired = quota?.windows?.some(window => { const reset = quotaResetAt(window, quota.observedAt); return reset && reset <= now; });
    return { state: resetExpired ? 'reset-expired' : report?.state && report.state !== 'fresh' ? report.state : providerError === 'stale' || quota && !quotaFresh(quota, provider, now) ? 'stale' : loading ? 'checking' : providerError ? 'unavailable' : 'missing', quota, checkedAt: report?.checkedAt, observedAt: report?.observedAt || quota?.observedAt || null };
  }
  return { state: providerError === 'stale' || quota && !quotaFresh(quota, provider, now) ? 'stale' : loading ? 'checking' : /needs login|sign.?in|not logged in/i.test(providerError || '') ? 'needs-login' : 'unavailable', quota };
}

// Interpret wall-clock reset text in its source zone. Unknown/nonexistent local
// times stay unknown; a repeated DST hour uses its next occurrence after observation.
export function quotaResetAt(window, observedAt = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (window.resetsAt != null && Number.isFinite(Number(window.resetsAt))) return Number(window.resetsAt);
  const source = String(window.resetsText || '').trim();
  const zoneTag = source.match(/\s*\(?((?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+|SGT|UTC|GMT)\)?\s*$/i);
  const zone = zoneTag ? (/^SGT$/i.test(zoneTag[1]) ? 'Asia/Singapore' : /^(UTC|GMT)$/i.test(zoneTag[1]) ? 'UTC' : zoneTag[1]) : (window.timeZone || window.timezone || timeZone);
  const text = (zoneTag ? source.slice(0, zoneTag.index) : source).trim();
  const observed = Number(observedAt);
  if (!Number.isFinite(observed)) return null;
  const relative = text.match(/^(?:in\s+)?(?:(\d+)\s*(?:d|days?)\s*)?(?:(\d+)\s*(?:h|hours?)\s*)?(?:(\d+)\s*(?:m|minutes?)\s*)?$/i);
  if (relative && relative.slice(1).some(Boolean)) return observed + ((Number(relative[1] || 0) * 24 + Number(relative[2] || 0)) * 60 + Number(relative[3] || 0)) * 60000;
  const time = text.match(/^(?:(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May\w*|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(\d{4}))?[,\s]*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!time) return null;
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }); }
  catch { return null; }
  const parts = ms => Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const civil = parts(observed), inputHour = Number(time[4]), minute = Number(time[5] || 0);
  if (minute > 59 || (time[6] ? inputHour < 1 || inputHour > 12 : inputHour > 23)) return null;
  const hour = time[6] ? inputHour % 12 + (/pm/i.test(time[6]) ? 12 : 0) : inputHour;
  const date = { year: Number(time[3] || civil.year), month: time[1] ? ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(time[1].slice(0,3).toLowerCase()) + 1 : civil.month, day: Number(time[2] || civil.day), hour, minute };
  function occurrences(value) {
    const nominal = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    const check = new Date(nominal);
    if (check.getUTCFullYear() !== value.year || check.getUTCMonth() + 1 !== value.month || check.getUTCDate() !== value.day) return [];
    const offsets = new Set();
    // Nearby offsets cover both sides of a DST transition without assuming a
    // 24-hour civil day or that every region has a whole-hour offset.
    for (let delta = -36; delta <= 36; delta += 6) {
      const sample = nominal + delta * 3600000, p = parts(sample);
      offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample);
    }
    return [...offsets].map(offset => nominal - offset).filter(ms => {
      const p = parts(ms); return Object.entries(value).every(([key, val]) => p[key] === val);
    }).sort((a,b) => a-b);
  }
  let matches = occurrences(date);
  if (!matches.length) return null;
  const future = matches.find(ms => ms >= observed);
  if (future !== undefined) return future;
  if (time[3]) return matches[0];
  if (time[1]) date.year++;
  else {
    const tomorrow = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    date.year = tomorrow.getUTCFullYear(); date.month = tomorrow.getUTCMonth() + 1; date.day = tomorrow.getUTCDate();
  }
  matches = occurrences(date);
  return matches[0] ?? null;
}
