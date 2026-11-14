import React from 'react';
import { BookOpen, Plus, RefreshCw } from 'lucide-react';
import { useLang } from './i18n';
import { GEMINI_RESEARCH_TYPES, geminiReadiness, geminiTaskCounts } from './gemini-desk.js';
import './gemini-desk.css';

const STATES = {
  'model-unavailable': ['Configured model unavailable', '配置模型不可用'],
  ready: ['Ready for research', '可接研究任务'], 'needs-login': ['Sign-in needed', '需要本人登录'],
  unavailable: ['Connection unavailable', '连接暂不可用'], disabled: ['Disabled', '未启用'], unknown: ['Status unconfirmed', '连接状态待确认'],
};
export default function GeminiResearchDesk({ state = {}, stale = false, readOnly = false, onCreate, onRefresh, loading = false }) {
  const zh = useLang() === 'zh';
  const provider = state.runtime?.providers?.gemini;
  const readiness = geminiReadiness(provider, stale);
  const counts = geminiTaskCounts(state.tasks, state.runtime?.running);
  const slots = state.runtime?.parallelCapabilities?.gemini?.taskSlots;
  return <details id="gemini-research-desk" className="gemini-desk" data-no-i18n>
    <summary><span><BookOpen size={17}/><strong>{zh ? 'Gemini 研究助手' : 'Gemini research desk'}</strong></span><b className={`is-${readiness}`}>{STATES[readiness][zh ? 1 : 0]}</b></summary>
    <div className="gemini-desk__body">
      <p>{zh ? '查官方资料、核对事实、比较方案并整理带来源的研究笔记。代码实现、独立代码审查及批准交给对应负责人。' : 'Find official documentation, verify facts, compare options and prepare sourced research notes. Implementation, independent code review and approval stay with their assigned owners.'}</p>
      <div className="gemini-desk__facts"><span>{zh ? '实际运行' : 'Observed running'} <strong>{stale ? '—' : counts.running}</strong></span><span>{zh ? '待处理' : 'Pending'} <strong>{counts.pending}</strong></span><span>{zh ? '受阻' : 'Blocked'} <strong>{counts.blocked}</strong></span>{Number.isFinite(slots) && <span>{zh ? '并行任务上限' : 'Parallel task limit'} <strong>{slots}</strong></span>}</div>
      {provider?.model && <p className="gemini-desk__model">{zh ? '配置模型：' : 'Configured model: '}<code>{provider.model}</code>{provider.highModel && provider.highModel !== provider.model && <span> · {zh ? '高优先级：' : 'High priority: '}<code>{provider.highModel}</code></span>}{readiness !== 'ready' && <span> · {readiness === 'model-unavailable' ? (zh ? '客户端模型列表未包含此配置' : 'Not listed by the client') : (zh ? '连接恢复后再验证可用性' : 'Availability needs verification after connection')}</span>}</p>}
      {provider?.reason && readiness !== 'ready' && <p className="gemini-desk__reason">{provider.reason}</p>}
      {readiness === 'needs-login' && <div className="gemini-desk__login"><strong>{zh ? '完成一次本人登录' : 'Sign in with your account'}</strong><p>{zh ? '在已安装的客户端中完成登录，回来刷新。无需把密码或密钥贴到任务里。' : 'Finish sign-in in the installed client, then refresh here. Do not paste passwords or keys into tasks.'}</p>{provider?.loginCommand && <><small>{zh ? '已检测到的客户端登录命令（在终端运行）：' : 'Detected client sign-in command (run in Terminal):'}</small><code>{provider.loginCommand}</code></>}</div>}
      {readiness !== 'ready' && <p className="gemini-desk__note">{zh ? '可以先整理研究请求；连接就绪、额度和席位可用后才会执行。' : 'Research requests can be prepared now. Execution waits for a ready connection, available quota and a task slot.'}</p>}
      <div className="gemini-desk__actions">{Object.entries(GEMINI_RESEARCH_TYPES).map(([id, label]) => <button key={id} type="button" disabled={readOnly || !onCreate} onClick={() => onCreate?.(id)}><Plus size={13}/>{label[zh ? 1 : 0]}</button>)}</div>
      <p className="gemini-desk__note">{zh ? '选择后填写真实问题再提交。要求附原始链接与相关日期，区分已证实结论、推断及未找到的资料。选择类型不会创建任务。' : 'Choose a type, then supply actual questions before submitting. Request original links and relevant dates; distinguish confirmed findings, inferences and missing evidence. Choosing a type does not create a task.'}</p>
      {onRefresh && <button type="button" className="gemini-desk__refresh" disabled={loading} onClick={onRefresh}><RefreshCw size={13}/>{zh ? '刷新连接状态' : 'Refresh connection status'}</button>}
    </div>
  </details>;
}
