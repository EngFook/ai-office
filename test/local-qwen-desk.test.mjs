import test from 'node:test';
import assert from 'node:assert/strict';
import { qwenAssistanceDraft, qwenDutyState, qwenSourcePrompt } from '../src/local-qwen-desk.js';
import { LOCAL_QWEN_TYPES } from '../server/local-qwen-policy.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('Qwen duty labels distinguish missing data, configured duty, live schedule and failure', () => {
  assert.equal(qwenDutyState(null), 'unknown');
  assert.equal(qwenDutyState({ phase: 'ready', lastCheckedAt: '2020-01-01' }), 'unknown');
  assert.equal(qwenDutyState({ enabled: true, phase: 'idle' }), 'enabled');
  assert.equal(qwenDutyState({ enabled: false, started: true }), 'disabled');
  assert.equal(qwenDutyState({ started: false, phase: 'ready' }), 'stopped');
  assert.equal(qwenDutyState({ started: true, phase: 'ready' }), 'scheduled');
  assert.equal(qwenDutyState({ started: true, phase: 'unavailable' }), 'unavailable');
  assert.equal(qwenDutyState({ started: true, phase: 'discussing' }), 'working');
  assert.equal(qwenDutyState({ started: true, phase: 'generating' }), 'working');
});

test('assistance shortcuts preserve explicit provider and role, never fabricate input or create tasks', () => {
  assert.equal(Object.keys(LOCAL_QWEN_TYPES).length, 8);
  for (const supportType of Object.keys(LOCAL_QWEN_TYPES)) {
    const draft = qwenAssistanceDraft(supportType);
    assert.equal(draft.provider, 'local-qwen');
    assert.equal(draft.role, 'Helper');
    assert.equal(draft.supportType, supportType);
    assert.equal(draft.description, '', 'the user must supply actual source material');
    assert.ok(qwenSourcePrompt(supportType, 'zh'));
    assert.ok(qwenSourcePrompt(supportType, 'en'));
    assert.notEqual(qwenSourcePrompt(supportType, 'zh'), qwenSourcePrompt(supportType, 'en'));
  }
  assert.equal(qwenAssistanceDraft('write-code'), null);
});

test('Qwen desk reports actual model/status and reports distinguish source fallback in both languages', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'qwen-desk-render-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { default: LocalQwenDesk } = await vite.ssrLoadModule('/src/LocalQwenDesk.jsx');
    const { WorkReportContent } = await vite.ssrLoadModule('/src/WorkReports.jsx');
    let writes = 0;
    for (const lang of ['en', 'zh']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(LocalQwenDesk, { state: { runtime: { providers: { 'local-qwen': { available: true, authenticated: true, model: 'actual-local-model', concurrency: 1 } } }, qwenWatch: { started: true, phase: 'idle', intervalMs: 300000 }, workReportsSummary: { started: true, phase: 'unavailable' } }, onCreate() { writes++; } }));
      assert.match(html, /actual-local-model/);
      assert.match(html, lang === 'en' ? /Next check:/ : /下次检查：/);
      assert.match(html, lang === 'en' ? /Scheduled/ : /自动值守中/);
      assert.match(html, lang === 'en' ? /Needs recovery/ : /等待恢复/);
      assert.match(html, lang === 'en' ? /Not reported/ : /尚未上报/);
      assert.match(html, lang === 'en' ? /Task breakdown/ : /任务拆分/);
      assert.doesNotMatch(html, /qwen3:14b/);
      assert.equal((html.match(/type="button"/g) || []).length, 8);
      const stale = renderToStaticMarkup(React.createElement(LocalQwenDesk, { state: { qwenWatch: { started: true } }, stale: true }));
      assert.doesNotMatch(stale, /Scheduled|自动值守中/);
      const reports = renderToStaticMarkup(React.createElement(WorkReportContent, { report: { phase: 'ready', providers: [{ provider: 'codex', tasks: [{ id: 'source', title: 'Actual user title', extracted: true, extractionSource: 'source-fallback', quote: 'Verbatim source', sourceResult: 'Verbatim source', files: [] }] }] } }));
      assert.match(reports, /Actual user title/);
      assert.match(reports, lang === 'en' ? /System source excerpt/ : /系统原文摘录/);
      assert.doesNotMatch(reports, /Qwen-selected excerpt|Qwen 选择摘录/);
    }
    assert.equal(writes, 0);
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
