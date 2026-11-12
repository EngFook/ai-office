import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('task cards, bulk actions and Qwen controls follow the selected language and retain user content', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-actions-render-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { default: TaskBoard } = await vite.ssrLoadModule('/src/TaskBoard.jsx');
    const { default: HuddlePanel } = await vite.ssrLoadModule('/src/HuddlePanel.jsx');
    const { default: SceneRecovery } = await vite.ssrLoadModule('/src/SceneRecovery.jsx');
    const task = { id: 'original', title: '保留用户原文 / Keep user text', version: 2, status: 'blocked', provider: 'codex', projectPath: '/mock', role: 'any', resolution: { owner: 'codex', state: 'assigned', nextAction: 'Inspect original failure' }, humanGate: { requestId: 'question', state: 'pending', kind: 'approval' } };
    let writes = 0;
    const board = { cardActions: () => { writes++; }, state: { configuration: { mode: 'enabled' }, tasks: [task], deletedTasks: [], humanRequests: [{id:'question',taskId:task.id,kind:'approval',state:'pending',question:'Approval fixture'}], roles: [], instructions: [], settings: { autoPickup: false }, runtime: { providers: {}, running: [] } } };
    const huddle = { phase: 'waiting', discussion: [{ text: 'Keep original Qwen note' }], decisions: [] };
    for (const lang of ['en', 'zh']) {
      setLang(lang);
      const boundary = new SceneRecovery({ onTasks() {}, onDirectory() {}, children: React.createElement('canvas') });
      boundary.state = { ...boundary.state, ...SceneRecovery.getDerivedStateFromError(new Error('WebGL initialization failed')) };
      const fallback = renderToStaticMarkup(boundary.render());
      assert.match(fallback, lang === 'en' ? /Open task board/ : /打开任务板/);
      assert.match(fallback, lang === 'en' ? /View agent list/ : /查看代理列表/);
      assert.match(fallback, lang === 'en' ? /Retry 3D/ : /重试 3D/);
      assert.doesNotMatch(fallback, /<canvas/);
      const cards = renderToStaticMarkup(React.createElement(TaskBoard, { board }));
      const gathering = renderToStaticMarkup(React.createElement(HuddlePanel, { huddle, tasks: [task], board }));
      for (const html of [cards, gathering]) {
        assert.match(html, /保留用户原文 \/ Keep user text/);
        assert.match(html, lang === 'en' ? /Select all/ : /全选/);
        assert.match(html, lang === 'en' ? /Request selected again/ : /一并重新请求/);
        assert.match(html, lang === 'en' ? /Delete selected/ : /一并删除/);
        assert.match(html, lang === 'en' ? /Deny selected/ : /一并拒绝/);
        if (lang === 'en') assert.doesNotMatch(html, /全选|一并重新请求|一并删除|一并拒绝|选择任务：|受阻待处理/);
      }
      assert.match(cards, lang === 'en' ? /Approval needed · answer above/ : /需要你确认 · 在上方问询区处理/);
      assert.match(cards, lang === 'en' ? /Deleted tasks \(0\)/ : /已删除任务（0）/);
      assert.match(gathering, lang === 'en' ? /not confirmation of execution or statements by other AIs/ : /未代表已执行或其他 AI 已发言/);
      assert.match(gathering, /Keep original Qwen note/);
    }
    assert.equal(writes, 0);
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
