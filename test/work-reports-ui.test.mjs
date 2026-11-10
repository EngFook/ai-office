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
    const task = { id: 'one', title: '<script>untrusted</script>', completionSource: 'manual', extracted: true, sourceTruncated: true, quote: '新增 example.mjs', files: [{ path: 'example.mjs', evidence: '新增 example.mjs' }], sourceResult: '<img src=x onerror=alert(1)>' };
    const html = renderToStaticMarkup(React.createElement(WorkReportContent, { report: { phase: 'backfill', providers: ['claude', 'codex', 'gemini', 'local-qwen'].map(provider => ({ provider, tasks: provider === 'claude' ? [task, { ...task, id: 'two', extracted: false }] : [] })) } }));
    for (const word of ['Claude', 'Codex', 'Gemini', 'Qwen', '用户手动标记完成', '待 Qwen 摘录', 'example.mjs', '至多 6000 字符']) assert.ok(html.includes(word));
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
