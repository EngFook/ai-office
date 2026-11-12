import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('Grok patrol separates scheduling and webhook requests from an actual result', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-grok-patrol-ui-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { setLang, getLang } = await vite.ssrLoadModule('/src/i18n.js');
    const previousLang = getLang();
    const { GrokPatrolStatus, RoomDetails } = await vite.ssrLoadModule('/src/OfficeNavigation.jsx');
    const { OfficeIdentityContext } = await vite.ssrLoadModule('/src/OfficeIdentity.jsx');
    const render = state => renderToStaticMarkup(React.createElement(OfficeIdentityContext.Provider, { value: { timeZone: 'Asia/Singapore' } }, React.createElement(GrokPatrolStatus, { state })));
    try {
      setLang('zh');
      const missing = render();
      assert.match(missing, /等待服务状态/);
      assert.match(missing, /尚未回写/);
      assert.doesNotMatch(missing, /已启用|正在运行/);
      const scheduled = { enabled: true, started: true, intervalMs: 600000, nextCheckAt: '2026-11-13T00:10:00Z', lastRequestedAt: '2026-11-13T00:00:00Z', phase: 'awaiting_bot', lastResult: 'Unconfirmed outcome' };
      const pending = render(scheduled);
      assert.match(pending, /已启用/);
      assert.match(pending, /每 10 分钟/);
      assert.match(pending, /已请求 Grok 检查，等待实际回写/);
      assert.match(pending, /尚未回写/);
      assert.match(pending, /08:10/);
      assert.doesNotMatch(pending, /Unconfirmed outcome|正在运行|已处理/);
      const writtenBack = render({ ...scheduled, phase: 'idle', lastHandledAt: '2026-11-13T00:03:00Z', lastResult: 'Owner assigned; recovery still pending.' });
      assert.match(writtenBack, /上次 Grok 实际处理/);
      assert.match(writtenBack, /08:03/);
      assert.match(writtenBack, /Owner assigned; recovery still pending/);
      assert.doesNotMatch(writtenBack, /尚未回写|等待实际回写/);
      const receipt = { taskId: 'private-task-id', action: 'wait', applied: false, reason: 'Owner unavailable; <script>literal</script>', evidence: 'Do not expose receipt internals.', at: '2026-11-13T00:04:00Z' };
      const objectResult = render({ ...scheduled, phase: 'watching', lastHandledAt: receipt.at, lastResult: receipt });
      assert.match(objectResult, /Owner unavailable; &lt;script&gt;literal&lt;\/script&gt;/);
      assert.match(objectResult, /08:04/);
      assert.doesNotMatch(objectResult, /<script>|private-task-id|Do not expose receipt internals|\[object Object\]|尚未回写/);
      const unconfirmedResult = render({ ...scheduled, lastResult: receipt });
      assert.match(unconfirmedResult, /尚未回写/);
      assert.doesNotMatch(unconfirmedResult, /Owner unavailable|literal/);
      assert.doesNotMatch(render({ ...scheduled, lastHandledAt: receipt.at, lastResult: { ...receipt, reason: { unexpected: 'object' } } }), /unexpected|\[object Object\]/);
      const failed = render({ ...scheduled, lastHandledAt: 'invalid', error: '<script>Webhook unavailable</script>' });
      assert.match(failed, /巡检异常/);
      assert.match(failed, /&lt;script&gt;Webhook unavailable/);
      assert.doesNotMatch(failed, /<script>|Unconfirmed outcome/);
      assert.match(failed, /尚未回写/);
      const disabled = render({ ...scheduled, enabled: false });
      assert.match(disabled, /未启用/);
      assert.doesNotMatch(disabled, /每 10 分钟|08:10|已请求 Grok/);
      const stopping = render({ ...scheduled, started: false });
      assert.match(stopping, /巡检服务尚未启动/);
      assert.doesNotMatch(stopping, /08:10/);
      const room = focus => renderToStaticMarkup(React.createElement(RoomDetails, { focus, grokPatrol: scheduled }));
      assert.match(room('department-3'), /受阻任务巡检/);
      assert.doesNotMatch(room('department-1'), /受阻任务巡检/);
      setLang('en');
      const english = render(scheduled);
      assert.match(english, /Every 10 minutes/);
      assert.match(english, /awaiting an actual response/);
      assert.match(english, /No result written back yet/);
      assert.doesNotMatch(english, /巡检|尚未回写/);
    } finally { setLang(previousLang); }
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
