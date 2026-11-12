import { useOfficeDate } from './OfficeIdentity';
import React from 'react';
import { BellRing } from 'lucide-react';
import { useLang } from './i18n';
import { blockedWorkSummary } from './huddle-ui.js';
import { qwenContinuousDuty, qwenContinuousDutyLabel } from './local-qwen-desk.js';
import './qwen-watch.css';

export default function QwenWatchNotice({ watch, huddle, tasks = [], runtime = {}, humanRequests = [], onTasks }) {
  const zh = useLang() === 'zh';
  const timeLabel = useOfficeDate({month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
  if (!watch?.started && !huddle?.enabled && !watch?.duty) return null;
  const summary = blockedWorkSummary(tasks, runtime, humanRequests);
  const stale = runtime.unavailable === true;
  const unavailable = !stale && huddle?.phase === 'unavailable';
  const duty = qwenContinuousDuty({ qwenWatch: watch, runtime }, { stale });
  const attention = summary.active.length > 0 || unavailable || ['degraded', 'offline', 'paused'].includes(duty.status);
  const checkedAt = huddle?.lastCheckedAt || watch?.lastCheckedAt;
  const status = stale ? (zh ? '连接待恢复 · 上次检查记录仅供参考' : 'Connection unavailable · previous check for reference') : summary.active.length
    ? (zh ? `可排查 ${summary.actionable} · 待你处理 ${summary.needsUser} · 待 Grok 核查 ${summary.grokCheck} · 实际处理 ${summary.working}` : `${summary.actionable} to investigate · ${summary.needsUser} need you · ${summary.grokCheck} await Grok · ${summary.working} working now`)
    : (zh ? '暂无需要推进的受阻任务' : 'No active blocked tasks');
  return <aside className={`qwen-watch-notice${attention ? ' is-attention' : ''}`} role="status" aria-live="polite" data-no-i18n>
    <BellRing size={16} aria-hidden="true"/>
    <span><strong>{zh ? 'Qwen 本地助手' : 'Qwen local assistant'} · {qwenContinuousDutyLabel(duty, zh ? 'zh' : 'en')}</strong><span className="qwen-watch-notice__summary">{status}</span>
      {duty.configured && <small>{zh ? '最近心跳：' : 'Last heartbeat: '}{timeLabel(duty.heartbeatAt) || '—'} · {zh ? '下次巡检：' : 'Next inspection: '}{timeLabel(duty.nextCheckAt) || '—'}</small>}
      {!stale && (!duty.configured || duty.live) && huddle?.phase === 'discussing' && <small>{zh ? 'Qwen 正在分析分工；分配不代表已开始执行。' : 'Qwen is analysing assignments; assignment does not mean execution.'}</small>}
      {unavailable && <small>{zh ? '本轮分析不可用，查看受阻任务的下一步。' : 'Analysis unavailable this round. Check the next action on blocked tasks.'}</small>}
      {duty.error && <small>{String(duty.error)}</small>}
      {checkedAt && <small>{zh ? '最近检查：' : 'Last check: '}{timeLabel(checkedAt)}</small>}
    </span>
    <button onClick={onTasks}>{zh ? '查看受阻与下一步' : 'View blockers and next steps'}</button>
  </aside>;
}
