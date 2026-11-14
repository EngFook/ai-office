import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { qwenContinuousDuty, qwenContinuousDutyLabel, qwenDutyState } from '../src/local-qwen-desk.js';
import { connectedProviderResidents, residentStatusLabel } from '../src/office-ui.js';
import { officeOperations, operationsHeadline } from '../src/office-operations.js';
import { buildSharedRoster, workingOfficeAgents } from '../src/unified-office.js';

const now = Date.now();
const duty = (extra = {}) => ({ enabled: true, started: true, phase: 'monitoring', heartbeatAt: now,
  lastCheckedAt: now, nextCheckAt: now + 15000, intervalMs: 15000, checks: 4, ...extra });
const state = (extra = {}, provider = {}) => ({ qwenWatch: { started: true, duty: duty(extra) }, runtime: {
  started: true, agents: [], running: [], providers: { 'local-qwen': { available: true, authenticated: true, model: 'actual-model', ...provider } } } });

test('continuous supervision requires a current service heartbeat, never model residency or an enabled setting', () => {
  assert.equal(qwenContinuousDuty({ runtime: state().runtime }).status, 'unknown');
  assert.equal(qwenContinuousDuty(state({ heartbeatAt: null }), { now }).status, 'offline');
  assert.equal(qwenContinuousDuty(state({ heartbeatAt: now - 45001 }), { now }).status, 'offline');
  assert.equal(qwenContinuousDuty(state({ heartbeatAt: now + 5001 }), { now }).status, 'offline');
  assert.equal(qwenContinuousDuty(state({ started: false }), { now }).status, 'offline');
  assert.equal(qwenContinuousDuty(state({ enabled: false }), { now }).status, 'paused');
  assert.equal(qwenContinuousDuty(state(), { now, stale: true }).status, 'offline');
  assert.equal(qwenContinuousDuty({ ...state(), runtime: { unavailable: true } }, { now }).status, 'offline');
  assert.equal(qwenContinuousDuty(state({}, { loaded: true, busy: false }), { now }).status, 'monitoring');
});

test('supervisor work, model work and recovery are distinct states with bounded heartbeat expiry', () => {
  assert.equal(qwenContinuousDuty(state({ phase: 'checking' }), { now }).status, 'monitoring');
  assert.equal(qwenContinuousDuty(state({}, { busy: true }), { now }).status, 'working');
  assert.equal(qwenContinuousDuty(state({ phase: 'working' }), { now }).status, 'working');
  assert.equal(qwenContinuousDuty(state({ phase: 'degraded', error: 'source unavailable' }), { now }).status, 'degraded');
  assert.equal(qwenContinuousDuty(state({ intervalMs: 3600000, heartbeatAt: now - 120001 }), { now }).status, 'offline');
  assert.equal(qwenContinuousDutyLabel({ status: 'monitoring' }, 'zh'), '持续值守');
  assert.equal(qwenContinuousDutyLabel({ status: 'paused' }, 'en'), 'Paused');
  assert.equal(qwenDutyState({ started: true, phase: 'ready', logSummary: { phase: 'unavailable', sourceErrors: ['claude'] } }), 'unavailable');
  assert.equal(qwenDutyState({ started: true, phase: 'ready', logSummary: { phase: 'unavailable', error: 'read failed' } }), 'unavailable');
});

test('Qwen resident stays visible while supervising without creating workers or board claims, then exposes lost connection', () => {
  const current = state();
  const roster = buildSharedRoster({ 'local-qwen': { connected: true, agents: [] } });
  const resident = connectedProviderResidents({ ...current, roster })[0];
  assert.equal(resident.provider, 'Local Qwen');
  assert.equal(resident.status, 'monitoring');
  assert.equal(residentStatusLabel(resident, 'zh'), '持续值守');
  assert.equal(resident.workingCount, 0);
  assert.equal(resident.activeTaskCount, 0);
  assert.equal(workingOfficeAgents(roster).length, 0);
  const model = officeOperations({ ...current, roster, autoPickup: true });
  assert.equal(model.execution.confirmed, 0);
  assert.equal(model.claimed.length, 0);
  assert.match(operationsHeadline(model), /0 位代理运行.*任务板 0 项执行/);
  const offline = connectedProviderResidents({ qwenWatch: current.qwenWatch, runtime: { unavailable: true } })[0];
  assert.equal(offline.id, resident.id);
  assert.equal(offline.status, 'offline');
  assert.equal(residentStatusLabel(offline, 'zh'), '连接中断');
  const processing = connectedProviderResidents(state({}, { busy: true }))[0];
  assert.equal(processing.status, 'assisting');
  assert.equal(processing.workingCount, 0);
  assert.equal(residentStatusLabel(processing, 'zh'), '正在处理');
  const realJob = connectedProviderResidents({ ...current, runtime: { ...current.runtime, running: [{ provider: 'local-qwen', taskId: 'real-task' }] } })[0];
  assert.equal(realJob.status, 'working');
  assert.equal(realJob.activeTaskCount, 1);
});

test('homepage, assistant desk and notice show duty heartbeat and do not call supervision a running agent', async () => {
  const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { default: LocalQwenDesk } = await vite.ssrLoadModule('/src/LocalQwenDesk.jsx');
    const { default: QwenWatchNotice } = await vite.ssrLoadModule('/src/QwenWatchNotice.jsx');
    const { default: OfficeOperations } = await vite.ssrLoadModule('/src/OfficeOperations.jsx');
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      const current = state();
      const model = officeOperations({ ...current, autoPickup: true });
      const html = renderToStaticMarkup(React.createElement(OfficeOperations, { model, board: { state: current, stale: false }, roster: [], lang }));
      const desk = renderToStaticMarkup(React.createElement(LocalQwenDesk, { state: current }));
      const notice = renderToStaticMarkup(React.createElement(QwenWatchNotice, { watch: current.qwenWatch, runtime: current.runtime }));
      for (const content of [html, desk, notice]) {
        assert.match(content, lang === 'zh' ? /持续值守/ : /Continuously on duty/);
        assert.match(content, lang === 'zh' ? /心跳/ : /[Hh]eartbeat/);
        assert.doesNotMatch(content, /1 位运行|1 running/);
      }
      assert.match(desk, lang === 'zh' ? /下次巡检/ : /Next inspection/);
      const staleDesk = renderToStaticMarkup(React.createElement(LocalQwenDesk, { state: current, stale: true }));
      const staleNotice = renderToStaticMarkup(React.createElement(QwenWatchNotice, { watch: current.qwenWatch, runtime: { unavailable: true } }));
      assert.match(staleDesk, lang === 'zh' ? /连接中断/ : /Connection interrupted/);
      assert.match(staleNotice, lang === 'zh' ? /连接中断/ : /Connection interrupted/);
      assert.doesNotMatch(staleDesk, /is-ready/);
      const expired = renderToStaticMarkup(React.createElement(QwenWatchNotice, { watch: { duty: duty({ heartbeatAt: now - 90000 }) }, huddle: { enabled: true, phase: 'discussing' } }));
      assert.doesNotMatch(expired, /Qwen 正在分析分工|Qwen is analysing assignments/);
    }
  } finally { await vite.close(); }
});


test('activity reports separate raw facts, model drafts, stale summaries and source outages', async () => {
  const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { RunningLogSummary } = await vite.ssrLoadModule('/src/WorkReports.jsx');
    const facts = { logSummary: { source: 'structured-facts', phase: 'watching', checkedAt: now, facts: { omitted: 2 } },
      runningLogs: [{ key: 'native:c', provider: 'claude', category: 'native-state', agentId: 'actual-subagent', isSubagent: true, status: 'working', tool: 'Read', occurredAt: now }] };
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      const raw = renderToStaticMarkup(React.createElement(RunningLogSummary, { report: facts }));
      assert.match(raw, lang === 'zh' ? /等待 Qwen 整理/ : /awaiting Qwen summary/);
      assert.match(raw, /actual-subagent/);
      assert.match(raw, lang === 'zh' ? /查看 1 条实际记录/ : /Inspect 1 observed records/);
      assert.doesNotMatch(raw, /整理草稿|Qwen draft/);
      const draft = { ...facts, logSummary: { ...facts.logSummary, source: 'local-qwen', summary: 'Actual generated draft', highlights: ['Observed output'], stale: true, sourceErrors: ['codex'], generatedAt: now } };
      const html = renderToStaticMarkup(React.createElement(RunningLogSummary, { report: draft }));
      assert.match(html, /Actual generated draft/);
      assert.match(html, lang === 'zh' ? /未独立核验/ : /not independently verified/);
      assert.match(html, lang === 'zh' ? /上次摘要 · 等待更新/ : /Previous summary · awaiting refresh/);
      assert.match(html, lang === 'zh' ? /待恢复的数据来源：.*Codex/ : /Sources needing recovery: .*Codex/);
      assert.equal(renderToStaticMarkup(React.createElement(RunningLogSummary, { report: {} })), '');
    }
  } finally { await vite.close(); }
});
