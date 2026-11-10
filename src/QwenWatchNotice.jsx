import React from 'react';
import { BellRing } from 'lucide-react';
import { useLang } from './i18n';
import { blockedOwnership } from './huddle-ui.js';
import './qwen-watch.css';

export default function QwenWatchNotice({ watch, huddle, tasks = [], onTasks }) {
  const zh = useLang() === 'zh';
  if (!watch?.started && !huddle?.enabled) return null;
  const blocked = blockedOwnership(tasks).filter(task => task.state !== 'paused');
  const owned = blocked.filter(task => task.owner).length;
  const unavailable = huddle?.phase === 'unavailable';
  const attention = blocked.length > 0 || unavailable;
  const checkedAt = huddle?.lastCheckedAt || watch?.lastCheckedAt;
  const status = huddle?.phase === 'discussing'
    ? (zh ? '正在召集与分析，按角色、额度和空闲状态分工' : 'Convening and analysing; matching roles, quota and availability')
    : unavailable
      ? (zh ? '本轮 Qwen 分析暂不可用 · 查看负责人跟进记录' : 'Qwen analysis unavailable this round · view owner follow-ups')
      : blocked.length
        ? (zh ? `${blocked.length} 项受阻 · ${owned} 项已有负责人 · 每 5 分钟跟进分工` : `${blocked.length} blocked · ${owned} with owners · reassessed every 5 minutes`)
        : (zh ? '每 5 分钟召集检查 · 暂无受阻任务' : 'Convenes checks every 5 minutes · no blocked tasks');
  return <aside className={`qwen-watch-notice${attention ? ' is-attention' : ''}`} role="status" aria-live="polite" data-no-i18n>
    <BellRing size={16} aria-hidden="true"/>
    <span><strong>{zh ? 'Qwen 协调员' : 'Qwen coordinator'}</strong> · {status}
      {checkedAt && <small>{zh ? '最近跟进：' : 'Last follow-up: '}{new Date(checkedAt).toLocaleTimeString(zh ? 'zh-SG' : 'en-SG', { timeZone: 'Asia/Singapore' })} SGT</small>}
    </span>
    <button onClick={onTasks}>{zh ? '查看受阻分工' : 'View blocked-task owners'}</button>
  </aside>;
}
