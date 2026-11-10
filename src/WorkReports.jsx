import React, { useEffect, useState } from 'react';
import './work-reports.css';

const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', 'local-qwen': 'Qwen' };
const PHASES = { stopped: '已停止', waiting: '等待两张前置卡完成', generating: '本地 Qwen 正在摘录', backfill: '正在补齐历史卡片', ready: '报告已更新', unavailable: '本地报告暂不可用' };
export function WorkReportContent({ report }) {
  return <section className="work-reports" aria-label="AI 工作报告" data-no-i18n>
    <div className="list-header"><h2>AI 工作报告</h2><span>Qwen · 本地运行 · 无付费额度</span></div>
    <p role="status">{PHASES[report.phase] || '正在读取报告'}{report.generatedAt && ` · 最近生成 ${new Date(report.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })} SGT`}</p>
    <p className="work-reports__note">约每 5 分钟更新，每次最多摘录 4 张卡，暂不可用时 30 秒后重试；仅整理任务板已完成卡片。结果和文件记录均为原卡摘录，不代表独立核验。原生会话未挂任务板的工作不在此范围。</p>
    {report.error && <p role="alert">{report.error}</p>}
    {(report.providers || []).map(group => <article className="work-reports__provider" key={group.provider}>
      <h3>{NAMES[group.provider] || group.provider} <small>{group.tasks.filter(task => task.extracted).length}/{group.tasks.length} 张已完成卡已摘录</small></h3>
      {!group.tasks.length && <p>暂无已完成卡记录。</p>}
      {group.tasks.map(task => <details className="work-reports__task" key={task.id}>
        <summary>{task.title} <small>{task.extracted ? '已摘录' : '待 Qwen 摘录'}</small></summary>
        <p><code>{task.id}</code> · {task.kind === 'review' ? '审查卡' : '任务卡'} · {task.completionSource === 'manual' ? '用户手动标记完成' : '原卡状态：已完成'}</p>
        <p>原卡更新时间：{task.completedAt}</p>{task.sourceTruncated && <p>结果较长：Qwen 本轮只摘录开头至多 6000 字符，完整结果见下方。</p>}
        {task.extracted && <><h4>结果摘录</h4><blockquote>{task.quote || '原卡未记录结果。'}</blockquote>
          <h4>变更文件记录（原卡陈述）</h4>{task.files.length ? <ul>{task.files.map((file, index) => <li key={`${file.path}-${index}`}><code>{file.path}</code><blockquote>{file.evidence}</blockquote></li>)}</ul> : <p>原卡结果中未摘录到明确的变更文件；不据此推断没有改动。</p>}</>}
        <details><summary>查看原卡完整结果</summary><pre>{task.sourceResult || '未记录结果。'}</pre></details>
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
        const value = await response.json(); if (active) setReport(value);
      } catch { if (active) setReport(previous => ({ ...previous, phase: 'unavailable', error: '无法读取本地工作报告；以下保留上次读取的内容。' })); }
      finally { clearTimeout(timeout); running = false; }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { active = false; clearInterval(timer); controller?.abort(); };
  }, []);
  return <WorkReportContent report={report}/>;
}
