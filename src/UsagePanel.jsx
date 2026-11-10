import React, { useEffect, useState } from 'react';
import { CheckCircle2, CircleHelp, Clock3 } from 'lucide-react';
import { t, uiLocale, useLang } from './i18n';
import { QUOTA, boundedPercent, quotaResetAt, tightestQuota } from './usage-utils.js';

const fmt = n => n >= 1e9 ? `${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : String(n || 0);
const when = ms => ms ? new Date(ms).toLocaleString(uiLocale(), { timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' SGT' : '—';
const percent = value => Math.round(value * 10) / 10;

// Header, drawer and panel share one read-only request and one refresh timer.
let usageState = { data: null, error: null, loading: true };
const usageListeners = new Set();
let usageTimer, usageRequest;
function refreshUsage() {
  if (usageRequest) return usageRequest;
  usageRequest = fetch('/api/usage', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(response.status)))
    .then(data => { usageState = { data, error: null, loading: false }; })
    .catch(() => { usageState = { ...usageState, error: 'Usage data unavailable', loading: false }; })
    .finally(() => { usageRequest = null; usageListeners.forEach(listener => listener(usageState)); });
  return usageRequest;
}
export function useUsage(active = true) {
  const [state, setState] = useState(usageState);
  useEffect(() => {
    if (!active) return;
    usageListeners.add(setState);
    setState(usageState);
    if (!usageTimer) { refreshUsage(); usageTimer = setInterval(refreshUsage, 30000); }
    return () => { usageListeners.delete(setState); if (!usageListeners.size) { clearInterval(usageTimer); usageTimer = null; } };
  }, [active]);
  return state;
}
function useClock() {
  const [now, setNow] = useState(Date.now);
  useLang();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  return now;
}


function relativeTime(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return t('{x} min').replace('{x}', minutes);
  const hours = Math.ceil(minutes / 60);
  return hours < 48 ? t('{x} hours').replace('{x}', hours) : t('{x} days').replace('{x}', Math.ceil(hours / 24));
}
function resetLabel(window, observedAt, now) {
  const reset = quotaResetAt(window, observedAt);
  if (reset && window.absoluteReset) return t('Resets {x}').replace('{x}', when(reset).replace(' SGT', ''));
  return reset ? reset > now ? t('Resets in {x}').replace('{x}', relativeTime(reset - now)) : t('Reset due') : t('Reset time unavailable');
}
function updatedLabel(at, now) {
  return !at ? t('Update time unavailable') : now - at < 60000 ? t('Updated just now') : t('Updated {x} ago').replace('{x}', relativeTime(now - at));
}
function QuotaWindow({ window, observedAt, now }) {
  const remaining = boundedPercent(window.remainingPercent);
  if (remaining == null) return null;
  return <div className="usage-limit"><div className="usage-limit__row"><span>{window.name}</span><strong>{t(`${percent(remaining)}% left`)}</strong></div>
    <div className="usage-bar" role="meter" aria-label={t('Remaining quota for {x}').replace('{x}', t(window.name))} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><i style={{ width: `${remaining}%`, background: remaining < 15 ? '#e0574f' : remaining < 40 ? '#e3a53b' : '#4caf7a' }}/></div>
    <small title={when(quotaResetAt(window, observedAt))}>{resetLabel(window, observedAt, now)}</small></div>;
}

export function QuotaIndicator({ onOpen }) {
  const { data, loading, error } = useUsage();
  useLang();
  const quota = !error && tightestQuota(data);
  const label = quota ? `${quota.provider} · ${quota.window.name} · ${percent(quota.remaining)}% left` : loading ? 'Reading quota…' : 'Usage data unavailable';
  return <button type="button" className={`quota-indicator${quota && quota.remaining < 20 ? ' is-low' : ''}`} onClick={onOpen} aria-label={`${t('Model usage')}: ${t(label)}`} title={t(label)}>
    <span className="quota-indicator__ring" style={{ '--quota': `${quota ? quota.remaining : 0}%` }} aria-hidden="true"><span>{quota ? `${Math.round(quota.remaining)}%` : '—'}</span></span><span className="quota-indicator__label">Quota<small>{quota ? quota.provider : loading ? 'Checking' : 'unavailable'}</small></span>
  </button>;
}

export function AgentQuota({ provider, ready, onOpen }) {
  const { data, error, loading } = useUsage();
  useLang();
  const quota = !error && tightestQuota(data, provider);
  if (provider === 'Local Qwen') return <section className="agent-quota"><LocalQwenUsage provider={data?.providers?.find(item => item.provider === provider)}/><button type="button" onClick={onOpen}>{t('Model usage')}</button></section>;
  const [key, errorKey] = QUOTA[provider] || [];
  const signIn = /needs login|sign.?in|not logged in/i.test(data?.quota?.[errorKey] || '');
  const readyLabel = typeof ready === 'string' ? ready : ready === true ? 'Ready' : signIn ? 'Sign-in needed' : ready === false ? 'Not ready' : 'Readiness unavailable';
  const Icon = readyLabel === 'Ready' ? CheckCircle2 : readyLabel === 'Sign-in needed' ? CircleHelp : Clock3;
  return <section className="agent-quota" aria-label="Model readiness and quota"><div className="agent-quota__heading"><span><Icon size={14}/>{readyLabel}</span><button type="button" onClick={onOpen}>Model usage</button></div>
    <div className="agent-quota__value"><span>{provider}</span><strong>{quota ? `${percent(quota.remaining)}% left` : loading ? 'Checking' : 'Quota unavailable'}</strong></div>
    <div className="usage-bar" aria-hidden="true"><i style={{ width: `${quota?.remaining || 0}%` }}/></div>
    {quota && <small>{quota.window.name}</small>}{!quota && key && data?.quota?.[key]?.status && <small>{data.quota[key].status}</small>}
  </section>;
}

function LocalQwenUsage({ provider }) {
  return <div className="usage-limit"><strong>{t('Local Qwen')} · {provider?.model || '—'}</strong>
    <p>{t(provider ? provider.online ? 'Online' : 'Offline' : 'Checking')} · {t(!provider || provider.loaded === null ? 'Model load unknown' : provider.loaded ? 'Model loaded' : 'Model not loaded')}</p>
    {provider && !provider.installed && <small>{t('Model not installed')}</small>}
    <p>{t('Today tokens')}: {provider?.todayTokens == null ? '—' : fmt(provider.todayTokens)} · {t('Average tok/s')}: {provider?.averageTokPerSecond == null ? '—' : provider.averageTokPerSecond.toFixed(1)}</p>
    <strong>{t('No quota')}</strong><small className="usage-note">{t('AI Office requests only · Asia/Singapore')}</small>
    {provider?.usageError && <small>{t(provider.usageError)}</small>}
  </div>;
}

export default function UsagePanel() {
  const { data, error, loading } = useUsage();
  const now = useClock();
  return <div className="usage-panel">
    {loading && !data && <p className="dialog-copy">Reading quota…</p>}
    {error && <p className="usage-na">{error}</p>}
    {data?.providers?.map(provider => {
      if (provider.noQuota) return <section className="usage-provider" key={provider.provider}><LocalQwenUsage provider={provider}/></section>;
      const [key, errorKey] = QUOTA[provider.provider] || [];
      const quota = key && data.quota?.[key];
      const quotaError = key && data.quota?.[errorKey];
      const signIn = /needs login|sign.?in|not logged in/i.test(quotaError || provider.limitsNote || '');
      return <section className="usage-provider" key={provider.provider}>
        <h3>{provider.provider}{quota?.plan && <small> · {t('Plan: {x}').replace('{x}', quota.plan)}</small>}</h3>
        {quota?.windows?.length && !quotaError ? <><div className="usage-windows">{quota.windows.map((window, index) => <QuotaWindow key={`${window.name}-${index}`} window={window} observedAt={quota.observedAt} now={now}/>)}</div>
          {quota.credits != null && <small>{t('Credits balance: {x}').replace('{x}', quota.credits)}{quota.resetCredits ? ` · ${t('{x} free full resets available').replace('{x}', quota.resetCredits)}` : ''}</small>}
          <small className="usage-note" title={when(quota.observedAt)}>{quota.reporter ? `${t('Reported by {x}').replace('{x}', quota.reporter)} · ` : ''}{updatedLabel(quota.observedAt, now)}</small></>
          : quota?.status && !quotaError ? <div className="usage-limit"><span>Status: </span><strong>{quota.status}</strong>{quota.model && <small> · {quota.model}</small>}<small className="usage-note">{quota.note}</small><small className="usage-note" title={when(quota.observedAt)}>{updatedLabel(quota.observedAt, now)}</small></div>
          : <div className="usage-limit"><span>Remaining quota: </span><strong className="usage-na">{quotaError === 'stale' ? t('Awaiting update') : signIn ? 'Sign-in needed' : key && !quotaError ? 'checking…' : 'unavailable'}</strong></div>}
        {provider.models?.length > 0 && <details className="usage-tokens"><summary>Token usage</summary><div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>Model</th><th>Last 5h</th><th>Today</th><th>7 days</th></tr></thead>
          <tbody>{provider.models.map(model => <tr key={model.model}><td>{model.model}</td><td>{fmt(model.last5h.total)}</td><td>{fmt(model.today.total)}</td><td>{fmt(model.week.total)}</td></tr>)}</tbody></table></div></details>}
      </section>;
    })}
    {data && <small className="usage-note">Quota updates automatically. This view refreshes every 30 seconds.</small>}
  </div>;
}
