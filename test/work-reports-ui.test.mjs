import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('report center renders four provider sections, literal evidence, manual completion and incomplete extraction', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-reports-render-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { WorkReportContent } = await vite.ssrLoadModule('/src/WorkReports.jsx');
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const task = { id: 'one', title: '<script>untrusted</script>', completionSource: 'manual', extracted: true, sourceTruncated: true, quote: '新增 example.mjs', files: [{ path: 'example.mjs', evidence: '新增 example.mjs' }], sourceResult: '<img src=x onerror=alert(1)>' };
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(WorkReportContent, { report: { phase: 'backfill', providers: ['claude', 'codex', 'gemini', 'local-qwen'].map(provider => ({ provider, tasks: provider === 'claude' ? [task, { ...task, id: 'two', extracted: false }] : [] })) } }));
      for (const word of ['Claude', 'Codex', 'Gemini', 'Qwen', 'example.mjs', ...(lang === 'zh' ? ['用户手动标记完成', '待整理', '至多 6000 字符'] : ['Manually marked done by user', 'Awaiting excerpt', 'first 6,000 characters'])]) assert.ok(html.includes(word), word);
      assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
    }
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});


test('daily report panel distinguishes transport acceptance from actual forwarding', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-daily-render-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { DailyReportStatus } = await vite.ssrLoadModule('/src/WorkReports.jsx');
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js'); setLang('zh');
    const value = { enabled: true, phase: 'waiting', hour: 8, timeZone: 'Asia/Singapore', nextDueAt: '2026-11-13T00:00:00.000Z', latest: { id: 'daily-1', status: 'pending', text: '<script>report</script>' }, notifications: { 'daily-1': { state: 'accepted' } }, notification: { configured: true } };
    const pending = renderToStaticMarkup(React.createElement(DailyReportStatus, { value }));
    assert.match(pending, /每天.*08:00/); assert.match(pending, /等待 Grok 实际转告确认/); assert.doesNotMatch(pending, /Grok 已确认实际转告/); assert.match(pending, /&lt;script&gt;/);
    const delivered = renderToStaticMarkup(React.createElement(DailyReportStatus, { value: { ...value, latest: { ...value.latest, status: 'delivered', delivery: { deliveredAt: '2026-11-13T00:01:00.000Z' } } } }));
    assert.match(delivered, /Grok 已确认实际转告/);
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
