import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('task card actions and existing task details both render without nested buttons or missing variables', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-card-render-'));
  const vite = await createServer({ cacheDir, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { default: HuddlePanel } = await vite.ssrLoadModule('/src/HuddlePanel.jsx');
    const { default: TaskBoard, TaskDetails } = await vite.ssrLoadModule('/src/TaskBoard.jsx');
    const task = { id: 'fixture', title: 'Fixture', status: 'blocked', provider: 'codex', version: 1 };
    const board = { state: { tasks: [task], deletedTasks: [], roles: [], instructions: [], humanRequests: [], settings: { autoPickup: false }, runtime: { providers: {}, running: [] } }, refresh() {}, cardActions() {} };
    const html = renderToStaticMarkup(React.createElement(TaskBoard, { board }));
    for (const label of ['一并重新请求', '一并删除', '一并拒绝', '删除任务', '选择任务：Fixture', '已删除任务']) assert.ok(html.includes(label), label);
    for (const category of ['pending', 'blocked']) {
      const scoped = renderToStaticMarkup(React.createElement(TaskBoard, { board, initialStatus: category }));
      assert.ok(scoped.includes(category === 'pending' ? '全选待处理' : '全选受阻'));
    }
    const huddle = renderToStaticMarkup(React.createElement(HuddlePanel, { board, tasks: [task], huddle: { phase: 'idle' } }));
    for (const label of ['选择 Qwen 任务', '一并重新请求', '一并删除', '一并拒绝', '全选受阻待处理']) assert.ok(huddle.includes(label), label);
    const details = renderToStaticMarkup(React.createElement(TaskDetails, { task, board, roles: [], onClose() {} }));
    assert.ok(details.includes('tb-task-heading'));
    for (const source of [html, details, huddle]) assert.doesNotMatch(source, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
