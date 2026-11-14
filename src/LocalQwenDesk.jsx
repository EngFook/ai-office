import React from 'react';
import { Bot, ChevronDown, Plus } from 'lucide-react';
import { useLang, t } from './i18n';
import { useOfficeDate } from './OfficeIdentity';
import { LOCAL_QWEN_TYPES } from '../server/local-qwen-policy.mjs';
import { qwenDutyState, qwenContinuousDuty, qwenContinuousDutyLabel } from './local-qwen-desk.js';
import './local-qwen-desk.css';

const STATUS = {
  unknown: ['Not reported', '尚未上报'], disabled: ['Disabled', '未启用'], stopped: ['Stopped', '已停止'],
  unavailable: ['Needs recovery', '等待恢复'], attention: ['Follow-up needed', '有事项待跟进'], waiting: ['Following up', '等待条件并跟进'],
  working: ['Checking now', '正在处理'], scheduled: ['Scheduled', '自动值守中'], enabled: ['Enabled · awaiting runtime', '已配置 · 等待运行信息'],
};

export default function LocalQwenDesk({ state = {}, onCreate, readOnly = false, stale = false }) {
  const lang = useLang(), zh = lang === 'zh';
  const dateLabel = useOfficeDate({ hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  const provider = state.runtime?.providers?.['local-qwen'];
  const ready = provider?.available === true && provider?.authenticated === true;
  const continuous = qwenContinuousDuty(state, { stale });
  const dutyData = [
    { id: 'watch', title: zh ? '任务与额度巡检' : 'Task & quota watch', value: state.qwenWatch, detail: zh ? '检查进度、异常和已知额度；不把旧失败当成当前状态。' : 'Check progress, issues and known quota using current evidence.' },
    { id: 'huddle', title: zh ? '受阻集结与分工' : 'Blocker huddle & ownership', value: state.huddle, detail: zh ? '按能力、空闲和额度安排负责人，持续跟进；需你补资料或批准时进入问询队列。' : 'Match owners by capability, availability and quota, then follow up. Missing user information or approval enters the question queue.' },
    { id: 'reports', title: zh ? '运行记录与交接整理' : 'Activity & handoff records', value: state.workReportsSummary, detail: zh ? '整理真实会话状态、执行事件与完成结果，保留来源；不代替验收或批准。' : 'Organize actual session states, execution events and results with their sources; acceptance and approval remain separate.' },
  ];
  return <section id="qwen-local-desk" className="qwen-desk" aria-labelledby="qwen-desk-title" data-no-i18n>
    <div className="qwen-desk__heading"><div><Bot size={19}/><h2 id="qwen-desk-title">{zh ? 'Qwen 本地助手' : 'Qwen local assistance'}</h2></div><span className={continuous.live && continuous.status !== 'degraded' ? 'is-ready' : ''}>{qwenContinuousDutyLabel(continuous, lang)}</span></div>
    <p className="qwen-desk__pulse" role="status">{continuous.status === 'paused' ? (zh ? '值守服务已暂停，恢复启用后继续巡检。' : 'Supervision is paused and will resume when enabled.') : continuous.live ? (zh ? '值守服务正在巡检任务、跟进受阻和整理结果。' : 'The duty service checks tasks, follows blockers and organizes results.') : (zh ? '等待值守服务的有效心跳；不会将旧记录显示为运行中。' : 'Waiting for a live duty heartbeat; old records are not shown as running.')}<span>{zh ? '最近心跳：' : 'Last heartbeat: '}{dateLabel(continuous.heartbeatAt) || '—'} · {zh ? '最近巡检：' : 'Last inspection: '}{dateLabel(continuous.lastCheckedAt) || '—'} · {zh ? '下次巡检：' : 'Next inspection: '}{dateLabel(continuous.nextCheckAt) || '—'}</span>{continuous.error && <span className="qwen-desk__error">{String(continuous.error)}</span>}</p>
    <p className="qwen-desk__model">{zh ? '当前配置模型：' : 'Configured model: '}<strong>{provider?.model || (zh ? '后台尚未上报' : 'Not reported by service')}</strong><span> · {stale ? (zh ? '模型状态待刷新' : 'Model status needs refresh') : ready ? provider.busy ? (zh ? '模型正在推理' : 'Model is processing') : (zh ? '有实际工作时调用模型' : 'Model available on demand') : (zh ? '模型连接待恢复' : 'Model connection needs recovery')}</span>{Number.isFinite(provider?.contextWindow) && <span> · {zh ? '上下文' : 'Context'} {provider.contextWindow.toLocaleString()}</span>}</p>
    <div className="qwen-desk__duties">{dutyData.map(({ id, title, value, detail }) => {
      const status = stale ? 'unknown' : qwenDutyState(value);
      return <details key={id} className={`qwen-desk__duty is-${status}`}><summary><span>{title}</span><b>{STATUS[status][zh ? 1 : 0]}</b></summary><p>{detail}</p><small>{Number.isFinite(value?.intervalMs) && value.intervalMs > 0 && <span>{zh ? '检查周期：' : 'Check interval: '}{Math.round(value.intervalMs / 60000 * 10) / 10}{zh ? ' 分钟' : ' min'} · </span>}{zh ? '最近检查：' : 'Last check: '}{dateLabel(value?.lastCheckedAt) || '—'}</small><small>{zh ? '下次检查：' : 'Next check: '}{dateLabel(value?.nextCheckAt) || '—'}</small>{value?.notice && <p>{String(value.notice)}</p>}{value?.warning && <p className="qwen-desk__error">{String(value.warning)}</p>}{value?.error && <p className="qwen-desk__error">{String(value.error)}</p>}</details>;
    })}</div>
    <details className="qwen-desk__choices"><summary><span>{zh ? '交给 Qwen 的 8 类文字辅助' : '8 kinds of text assistance for Qwen'}</span><ChevronDown size={15}/></summary><p>{zh ? '选择类型，粘贴真实资料后再添加。这里只准备请求，不会立即创建或执行任务。' : 'Choose a type, then paste actual source material and add the request. Choosing a type only prepares a draft.'}</p><div>{Object.entries(LOCAL_QWEN_TYPES).map(([id, label]) => <button key={id} type="button" disabled={readOnly || !onCreate} onClick={() => onCreate?.(id)}><Plus size={13}/>{t(label)}</button>)}</div></details>
    <p className="qwen-desk__resources">{Number.isFinite(provider?.concurrency) ? (zh ? `本机推理并发 ${provider.concurrency}；` : `Local inference concurrency: ${provider.concurrency}. `) : ''}{zh ? '启用后持续值守；有实际工作才调用模型，辅助整理让位给手动任务。值守不计入任务执行人数。' : 'When enabled, supervision remains active and invokes the model for actual work; summaries yield to your tasks. Supervision does not add an executing worker.'}</p>
  </section>;
}
