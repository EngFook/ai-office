import { createHash } from 'node:crypto';
import { quotaResetAt } from '../src/usage-utils.js';

export const USAGE_RISE_PERCENT = 10;
export const USAGE_RISE_TOKENS = 10000;
export const USAGE_COMPARE_MS = 30 * 60000;
const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'local-qwen': 'Local Qwen' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const number = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const time = value => number(value, 8640000000000000);
const kind = name => /week/i.test(name) ? 'weekly' : /5.hour|session/i.test(name) ? 'session' : /daily/i.test(name) ? 'daily' : 'other';
const day = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const comparable = (at, before, now) => time(at) !== null && time(before) !== null && at > before && at - before <= USAGE_COMPARE_MS && at <= now + 60000;
const finiteSum = items => items.length && items.every(value => number(value) !== null) ? number(items.reduce((a, b) => a + b, 0)) : null;

// Also applied to persisted reports on both write and read. No free-form source
// text, model prose, paths, reset-credit balance or credentials cross this boundary.
export function usageFact(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const key of ['observedAt', 'resetsAt', 'todayTokens', 'deltaTokens', 'averageTokPerSecond', 'periodMinutes', 'baselineAt', 'baselineTokens']) if (number(value[key]) !== null) result[key] = value[key];
  for (const key of ['usedPercent', 'remainingPercent', 'deltaPercent', 'baselineUsedPercent']) if (number(value[key], 100) !== null) result[key] = value[key];
  if (typeof value.windowId === 'string' && /^[a-f0-9]{24}$/.test(value.windowId)) result.windowId = value.windowId;
  if (['weekly', 'session', 'daily', 'other'].includes(value.windowKind)) result.windowKind = value.windowKind;
  return result;
}
export function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(names).filter(provider => value[provider] && typeof value[provider] === 'object').map(provider => {
    const item = value[provider];
    return [provider, { ...usageFact(item),
      quotaState: ['available', 'unknown', 'unavailable', 'no-quota'].includes(item.quotaState) ? item.quotaState : 'unavailable',
      tokensAvailable: item.tokensAvailable === true, online: typeof item.online === 'boolean' ? item.online : null,
      windows: (Array.isArray(item.windows) ? item.windows : []).filter(window => window && typeof window === 'object').slice(0, 40).map(window => ({ ...usageFact(window), resetsAt: time(window.resetsAt), resetDue: window.resetDue === true, resetEstimated: window.resetEstimated === true })),
    }];
  }));
}

export function observeUsage(data, previous = {}, now = Date.now()) {
  const usage = {}, events = [], issues = [];
  const generated = time(data?.generatedAt);
  const sourceFresh = generated !== null && generated <= now + 60000 && now - generated <= USAGE_COMPARE_MS;
  function emit(provider, type, fact, identity, severity = 'info', active = false) {
    const item = { key: `usage:${provider}:${type}:${hash(identity)}`, type, provider, taskId: null, severity, occurredAt: new Date(now).toISOString(), usage: usageFact(fact) };
    events.push(item);
    if (active) issues.push(item);
  }
  for (const [provider, displayName] of Object.entries(names)) {
    const raw = data?.providers?.find(item => item.provider === displayName);
    const old = previous[provider] || {};
    const quota = data?.quota?.[provider], observed = time(quota?.observedAt);
    const fresh = sourceFresh && !data?.quota?.[`${provider}Error`] && observed !== null && observed <= now + 60000 && now - observed <= (provider === 'grok' ? 6 * 3600000 : USAGE_COMPARE_MS);
    const tokens = !sourceFresh || raw?.usageError || raw?.error ? null : provider === 'local-qwen' ? number(raw?.todayTokens) : finiteSum((raw?.models || []).map(model => model.today?.total));
    const entry = usage[provider] = { observedAt: generated, quotaState: provider === 'local-qwen' ? 'no-quota' : fresh ? quota?.windows?.length ? 'available' : 'unknown' : 'unavailable', todayTokens: tokens, tokensAvailable: tokens !== null, online: typeof raw?.online === 'boolean' ? raw.online : null, averageTokPerSecond: number(raw?.averageTokPerSecond), windows: [] };
    if (provider !== 'local-qwen' && entry.quotaState !== 'available') {
      const issue = { key: `usage-unavailable:${provider}`, type: 'quota-unavailable', provider, taskId: null, severity: 'warning', usage: usageFact(entry) };
      issues.push(issue);
      if (entry.quotaState !== old.quotaState) emit(provider, 'quota-unavailable', entry, [generated, old.quotaState], 'warning');
    }
    if (!entry.tokensAvailable && provider === 'local-qwen') {
      issues.push({ key: 'usage-unavailable:local-qwen', type: 'usage-unavailable', provider, taskId: null, severity: 'warning' });
      if (old.tokensAvailable !== false) emit(provider, 'usage-unavailable', entry, [generated], 'warning');
    }
    if (tokens !== null) {
      const baseAt = time(old.baselineAt) ?? old.observedAt;
      const baseTokens = number(old.baselineTokens) ?? old.todayTokens;
      const compatible = old.tokensAvailable && number(baseTokens) !== null && comparable(generated, baseAt, now) && day(generated) === day(baseAt) && tokens >= baseTokens;
      entry.baselineAt = compatible ? baseAt : generated;
      entry.baselineTokens = compatible ? baseTokens : tokens;
      if (compatible && tokens - baseTokens >= USAGE_RISE_TOKENS && tokens - baseTokens >= baseTokens * .25) {
        emit(provider, 'usage-rise', { ...entry, deltaTokens: tokens - baseTokens, periodMinutes: (generated - baseAt) / 60000 }, [generated, tokens, baseTokens], 'warning', true);
        entry.baselineAt = generated; entry.baselineTokens = tokens;
      }
      // Identical samples retain the cumulative baseline, including after restart.
      if (generated === old.observedAt && old.tokensAvailable) { entry.baselineAt = old.baselineAt ?? generated; entry.baselineTokens = old.baselineTokens ?? tokens; }
    }
    // A stable hash of the source window name survives reordering without saving
    // arbitrary names. Duplicate names get an occurrence index.
    const occurrences = new Map();
    for (const rawWindow of fresh ? quota?.windows || [] : []) {
      const name = String(rawWindow.name || rawWindow.windowMinutes || 'quota');
      const index = occurrences.get(name) || 0; occurrences.set(name, index + 1);
      const windowId = hash([name, index]), before = old.windows?.find(item => item.windowId === windowId);
      const left = number(rawWindow.remainingPercent, 100), used = number(rawWindow.usedPercent, 100) ?? (left !== null ? 100 - left : null);
      if (used === null) continue;
      const remaining = left ?? 100 - used;
      const reset = quotaResetAt(rawWindow, observed), resetsAt = time(reset);
      const resetEstimated = /^(?:in\s+)?(?:\d+\s*(?:d|days?|h|hours?|m|minutes?)\s*)+$/i.test(String(rawWindow.resetsText || '').replace(/\(Asia\/Singapore\)|SGT/gi, '').trim());
      const window = { resetEstimated, windowId, windowKind: kind(name), usedPercent: used, remainingPercent: remaining, observedAt: observed, resetsAt, resetDue: resetsAt !== null && resetsAt <= now };
      entry.windows.push(window);
      const sameCycle = !before || before.resetEstimated && resetEstimated || time(before.resetsAt) === resetsAt || (time(before.resetsAt) !== null && resetsAt !== null && Math.abs(before.resetsAt - resetsAt) <= 60000);
      if (resetsAt !== null && (!before || !sameCycle)) emit(provider, 'quota-reset', window, [windowId, resetsAt]);
      if (window.resetDue) {
        const item = { key: `usage-reset-due:${provider}:${windowId}:${resetsAt}`, type: 'quota-reset-due', provider, taskId: null, severity: 'warning', usage: usageFact(window) };
        issues.push(item);
        if (!before?.resetDue || !sameCycle) emit(provider, 'quota-reset-due', window, [windowId, resetsAt]);
        continue; // A scheduled reset does not prove that capacity is available.
      }
      const category = remaining <= 0 ? 'quota-exhausted' : remaining <= 20 ? 'quota' : null;
      const priorCategory = before && !before.resetDue && old.quotaState === 'available' ? before.remainingPercent <= 0 ? 'quota-exhausted' : before.remainingPercent <= 20 ? 'quota' : null : null;
      if (category) {
        issues.push({ key: `usage-${category}:${provider}:${windowId}:${resetsAt || 'unknown'}`, type: category, provider, taskId: null, severity: category === 'quota-exhausted' ? 'critical' : 'warning', usage: usageFact(window) });
        if (category !== priorCategory || !sameCycle) emit(provider, category, window, [windowId, observed, category, old.quotaState], category === 'quota-exhausted' ? 'critical' : 'warning');
      }
      const baseAt = time(before?.baselineAt) ?? before?.observedAt;
      const baseUsed = number(before?.baselineUsedPercent, 100) ?? before?.usedPercent;
      const compatible = before && old.quotaState === 'available' && sameCycle && used >= before.usedPercent && comparable(observed, baseAt, now);
      window.baselineAt = compatible ? baseAt : observed;
      window.baselineUsedPercent = compatible ? baseUsed : used;
      if (compatible && used - baseUsed >= USAGE_RISE_PERCENT) {
        emit(provider, 'usage-rise', { ...window, deltaPercent: used - baseUsed, periodMinutes: (observed - baseAt) / 60000 }, [windowId, observed, used, baseUsed], 'warning', true);
        window.baselineAt = observed; window.baselineUsedPercent = used;
      }
      if (before && observed === before.observedAt && sameCycle) { window.baselineAt = before.baselineAt ?? observed; window.baselineUsedPercent = before.baselineUsedPercent ?? used; }
      if (before && old.quotaState === 'available' && comparable(observed, before.observedAt, now) && (used < before.usedPercent || !sameCycle)) emit(provider, 'quota-refreshed', window, [windowId, observed, resetsAt, used]);
    }
    if (entry.quotaState === 'available' && !entry.windows.length) {
      entry.quotaState = 'unknown';
      issues.push({ key: `usage-unavailable:${provider}`, type: 'quota-unavailable', provider, taskId: null, severity: 'warning' });
      if (old.quotaState !== 'unknown') emit(provider, 'quota-unavailable', entry, [generated, old.quotaState], 'warning');
    }
  }
  return { usage: sanitizeUsage(usage), events, issues };
}
