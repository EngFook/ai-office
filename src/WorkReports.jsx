import { useOfficeDate, useOfficeIdentity } from './OfficeIdentity';
import React, { useEffect, useState } from 'react';
import { useLang } from './i18n';
import './work-reports.css';

const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'local-qwen': 'Qwen' };
const PHASES = {
  stopped: ['Stopped', '已停止'], waiting: ['Waiting for prerequisites', '等待前置条件'], generating: ['Local Qwen is selecting excerpts', '本地 Qwen 正在选择摘录'],
  backfill: ['Filling in historical cards', '正在补齐历史卡片'], ready: ['Reports updated', '报告已更新'], unavailable: ['Local reports unavailable', '本地报告暂不可用'],
};
export function RunningLogSummary({ report }) {
  const zh = useLang() === 'zh';
  const say = (en, cn) => zh ? cn : en;
  const time = useOfficeDate({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const value = report.logSummary;
  if (!value) return null;
  const rows = Array.isArray(report.runningLogs) ? report.runningLogs : [];
  const labels = zh ? { working: '执行中', waiting: '等待', failed: '失败', idle: '空闲', offline: '离线', unconfirmed: '待确认',
    task_started: '任务开始', task_done: '任务返回', task_blocked: '任务受阻', session_started: '会话开始', turn_started: '回合开始', turn_completed: '回合完成', turn_failed: '回合失败', tool_started: '工具开始', tool_completed: '工具返回' }
    : { working: 'Working', waiting: 'Waiting', failed: 'Failed', idle: 'Idle', offline: 'Offline', unconfirmed: 'Unconfirmed',
      task_started: 'Task started', task_done: 'Task returned', task_blocked: 'Task blocked', session_started: 'Session started', turn_started: 'Turn started', turn_completed: 'Turn completed', turn_failed: 'Turn failed', tool_started: 'Tool started', tool_completed: 'Tool returned' };
  const modelSummary = value.source === 'local-qwen' && Boolean(value.summary);
  return <article className="work-reports__live" aria-label={say('Live records and Qwen summary', '运行记录与 Qwen 整理')}>
    <h3>{say('Live records and Qwen summary', '运行记录与 Qwen 整理')}</h3>
    <p className="work-reports__note">{say('Actual session states and runner events; this panel does not include private chats, prompts or tool output.', '原生会话状态与任务执行事件；这里不收集私聊、指令正文或工具输出。')}</p>
    <p role="status">{value.phase === 'summarizing' ? say('Qwen is summarizing changes', 'Qwen 正在整理变化') : modelSummary ? say('Qwen draft · not independently verified', 'Qwen 整理草稿 · 未独立核验') : say('Observed records · awaiting Qwen summary', '已观测记录 · 等待 Qwen 整理')}{value.stale && ` · ${say('Previous summary · awaiting refresh', '上次摘要 · 等待更新')}`}</p>
    <small>{say('Last read: ', '最近读取：')}{time(value.checkedAt)}{value.generatedAt && ` · ${say('Summary generated: ', '摘要生成：')}${time(value.generatedAt)}`}</small>
    {modelSummary && <><p className="work-reports__summary">{value.summary}</p>{Array.isArray(value.highlights) && value.highlights.length > 0 && <ul>{value.highlights.map((text, index) => <li key={index}>{text}</li>)}</ul>}</>}
    {value.error && <p role="status">{value.error}</p>}
    {value.sourceErrors?.length > 0 && <p className="work-reports__note">{say('Sources needing recovery: ', '待恢复的数据来源：')}{value.sourceErrors.map(key => NAMES[key] || key).join('、')}</p>}
    <details><summary>{say(`Inspect ${rows.length} observed records`, `查看 ${rows.length} 条实际记录`)}</summary>
      <div className="work-reports__logs">{rows.length ? rows.map((row, index) => <div key={`${row.key}-${index}`}><strong>{NAMES[row.provider] || row.provider} · {labels[row.status || row.type] || say('Recorded event', '已记录事件')}</strong><span>{row.isSubagent ? say('Subagent', '子代理') : row.category === 'native-state' ? say('Session', '会话') : say('Task', '任务')} · <code>{row.agentId || row.taskId || '—'}</code>{row.tool && ` · ${row.tool}`}</span><small>{time(row.occurredAt)}</small></div>) : <p>{say('No activity records received.', '尚未收到活动记录。')}</p>}</div>
      {value.facts?.omitted > 0 && <p className="work-reports__note">{say(`${value.facts.omitted} additional records omitted from this bounded view.`, `另有 ${value.facts.omitted} 条记录未纳入本次限量视图。`)}</p>}
    </details>
  </article>;
}

export function DailyReportStatus({ value }) {
  const zh = useLang() === 'zh';
  const officeTimeZone = useOfficeIdentity().timeZone;
  const say = (en, cn) => zh ? cn : en;
  const format = date => { try { return date ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { timeZone: value?.timeZone || officeTimeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : '—'; } catch { return '—'; } };
  if (!value) return null;
  const report = value.latest;
  const receipt = report && value.notifications?.[report.id];
  const delivered = report?.state === 'delivered' || report?.status === 'delivered';
  const phases = { 'waiting-model': say('Qwen is finishing another local job', 'Qwen 正在完成另一项本地工作'), stopped: say('Stopped', '已停止'), disabled: say('Disabled', '未启用'), scheduled: say('Scheduled', '已安排'), waiting: say('Scheduled', '已安排'), generating: say('Qwen is writing the daily report', 'Qwen 正在整理日报'), retrying: say('Will retry generation', '生成失败，等待重试'), unavailable: say('Daily report unavailable', '日报暂不可用'), 'scope-changed': say('Project scope changed; forwarding held', '项目范围已变更，暂停转告'), ready: say('Report ready', '日报已生成'), pending: say('Awaiting Grok forwarding', '等待 Grok 转告'), delivered: say('Grok confirmed forwarding', 'Grok 已确认转告') };
  return <article className="work-reports__live" aria-label={say('Qwen daily report', 'Qwen 每日日报')}>
    <h3>{say('Qwen daily report → Grok → You', 'Qwen 每日日报 → Grok → 你')}</h3>
    <p role="status">{phases[value.phase] || value.phase}{value.enabled && ` · ${say('Daily at', '每天')} ${String(value.hour ?? 8).padStart(2, '0')}:00 · ${value.timeZone || officeTimeZone}`}</p>
    {value.enabled && <p>{say('Next report: ', '下次汇总：')}{format(value.nextDueAt)}</p>}
    <p className="work-reports__note">{say('Summarizes the preceding 24 hours from recorded board activity, plus current blockers and questions. Native agents’ complete daily history is not collected. A webhook receipt is not proof of forwarding.', '汇总前 24 小时的任务板记录、当前受阻与待答问题；不包含全部原生代理的完整历史。Webhook 接收成功不等于已转告。')}</p>
    {value.error && <p role="alert">{value.error}</p>}
    {value.notification?.error && <p role="alert">{say('Grok notification needs recovery. The report remains queued.', 'Grok 通知暂未成功，日报保留在队列。')}</p>}
    {value.enabled && !value.notification?.configured && <p>{say('Grok webhook is not configured; generated reports will remain queued.', 'Grok Webhook 尚未配置；生成后的日报会留在队列。')}</p>}
    {report && <details><summary>{say('Latest daily report', '最近日报')} · {format(report.generatedAt || report.period?.endAt)}</summary>
      <p role="status">{delivered ? say('Grok confirmed actual forwarding', 'Grok 已确认实际转告') : receipt?.state === 'accepted' ? say('Notification accepted · awaiting Grok forwarding confirmation', '通知已接受 · 等待 Grok 实际转告确认') : say('Not yet confirmed forwarded', '尚未确认转告')}</p>
      {report.text ? <pre>{report.text}</pre> : <p>{say('Waiting for Qwen to finish the report.', '等待 Qwen 完成日报。')}</p>}
      {delivered && <small>{say('Forwarded: ', '转告时间：')}{format(report.delivery?.deliveredAt)}</small>}
    </details>}
  </article>;
}

export function WorkReportContent({ report }) {
  const zh = useLang() === 'zh';
  const say = (en, cn) => zh ? cn : en;
  const dateLabel = useOfficeDate({dateStyle:'medium',timeStyle:'short'});
  return <section className="work-reports" aria-label={say('AI work reports', 'AI 工作报告')} data-no-i18n>
    <div className="list-header"><h2>{say('AI work reports', 'AI 工作报告')}</h2><span>{say('Local records · source attribution', '本地整理 · 标明摘录来源')}</span></div>
    <p role="status">{PHASES[report.phase]?.[zh ? 1 : 0] || say('Reading reports', '正在读取报告')}{report.generatedAt && ` · ${say('Last generated', '最近生成')} ${dateLabel(report.generatedAt)}`}</p>
    <p className="work-reports__note">{say('Continuously checks new activity and completed results, organizing completed cards in batches. Qwen selects exact source excerpts; if it is unavailable, the system preserves clearly labeled source excerpts. These excerpts are not independent verification. Session activity and runner events appear separately below when available.', '持续检查新活动与完成结果，分批整理已完成卡。Qwen 选择原文摘录；模型暂不可用时，系统保留原文并标明来源。摘录不代表独立核验；原生会话活动与执行事件可在下方单独查看。')}</p>
    {report.model && <p>{say('Configured model: ', '配置模型：')}<code>{report.model}</code></p>}
    {report.notice && <p role="status">{report.notice}</p>}
    {report.warning && <p role="status">{report.warning}</p>}
    {report.error && <p role="alert">{report.error}</p>}
    <DailyReportStatus value={report.dailyReport}/>
    <RunningLogSummary report={report}/>
    {(report.providers || []).map(group => <article className="work-reports__provider" key={group.provider}>
      <h3>{NAMES[group.provider] || group.provider} <small>{group.tasks.filter(task => task.extracted).length}/{group.tasks.length} {say('completed cards excerpted', '张已完成卡已摘录')}</small></h3>
      {!group.tasks.length && <p>{say('No completed cards yet.', '暂无已完成卡记录。')}</p>}
      {group.tasks.map(task => <details className="work-reports__task" key={task.id}>
        <summary>{task.title} <small>{task.extracted ? task.extractionSource === 'source-fallback' ? say('System source excerpt', '系统原文摘录') : say('Qwen-selected excerpt', 'Qwen 选择摘录') : say('Awaiting excerpt', '待整理')}</small></summary>
        <p><code>{task.id}</code> · {task.kind === 'review' ? say('Review card', '审查卡') : say('Task card', '任务卡')} · {task.completionSource === 'manual' ? say('Manually marked done by user', '用户手动标记完成') : say('Original card status: done', '原卡状态：已完成')}</p>
        <p>{say('Original card updated: ', '原卡更新时间：')}{dateLabel(task.completedAt) || task.completedAt}</p>{task.sourceTruncated && <p>{say('Long result: excerpts use at most the first 6,000 characters. The full result remains below.', '结果较长：摘录范围为开头至多 6000 字符，完整结果保留在下方。')}</p>}
        {task.extracted && <><h4>{say('Result excerpt', '结果摘录')}</h4><blockquote>{task.quote || say('No result recorded on the original card.', '原卡未记录结果。')}</blockquote>
          <h4>{say('Changed files stated by the original card', '变更文件记录（原卡陈述）')}</h4>{task.files.length ? <ul>{task.files.map((file, index) => <li key={`${file.path}-${index}`}><code>{file.path}</code><blockquote>{file.evidence}</blockquote></li>)}</ul> : <p>{say('No explicit changed-file evidence was excerpted; this does not imply that nothing changed.', '未摘录到明确的变更文件证据；不据此推断没有改动。')}</p>}</>}
        <details><summary>{say('Full original result', '查看原卡完整结果')}</summary><pre>{task.sourceResult || say('No result recorded.', '未记录结果。')}</pre></details>
      </details>)}
    </article>)}
  </section>;
}
export default function WorkReports() {
  const [report, setReport] = useState({ phase: 'loading', providers: [] });
  useEffect(() => {
    let active = true, running = false, controller;
    const refresh = async () => {
      if (running) return; running = true; controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch('/api/office/work-reports', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error();
        const value = await response.json();
        try {
          const dailyResponse = await fetch('/api/office/daily-reports', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
          if (!dailyResponse.ok) throw new Error();
          value.dailyReport = await dailyResponse.json();
        } catch { value.dailyReport = { phase: 'unavailable', error: '无法读取每日日报状态。' }; }
        if (active) setReport(value);
      } catch { if (active) setReport(previous => ({ ...previous, phase: 'unavailable', error: '无法读取本地工作报告；以下保留上次读取的内容。', ...(previous.logSummary ? { logSummary: { ...previous.logSummary, stale: true, phase: 'unavailable' } } : {}) })); }
      finally { clearTimeout(timeout); running = false; }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { active = false; clearInterval(timer); controller?.abort(); };
  }, []);
  return <WorkReportContent report={report}/>;
}
