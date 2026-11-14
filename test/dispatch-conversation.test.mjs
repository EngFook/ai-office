import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('shared dispatch conversation shows actual replies and linked task states with escaped content', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
  try {
    const { default: DispatchConversation, dispatchMessages } = await server.ssrLoadModule('/src/DispatchConversation.jsx');
    const state = { configuration: { mode: 'enabled' }, grok: { connected: true }, instructions: [
      { id: 'i2', text: 'second', status: 'blocked', error: 'Planning failed', createdAt: '2026-11-09T02:00:00Z' },
      { id: 'i1', text: '<script>private instruction</script>', summary: 'Actual planning reply', status: 'done', createdAt: '2026-11-09T01:00:00Z' },
    ], tasks: [{ id: 'task', managementRequestId: 'i1', title: 'Linked task', status: 'pending', provider: 'claude' }, { id: 'other', managementRequestId: 'unrelated', title: 'NOT_THIS_CONVERSATION', status: 'done' }] };
    const messages = dispatchMessages(state);
    assert.equal(messages[0].id, 'i1');
    assert.equal(messages[0].tasks.length, 1);
    const html = renderToStaticMarkup(React.createElement(DispatchConversation, { board: { state }, lang: 'zh' }));
    assert.ok(html.includes('Actual planning reply'));
    assert.ok(html.includes('Linked task'));
    assert.ok(html.includes('待处理'));
    assert.ok(html.includes('已规划'));
    assert.ok(html.includes('重新请求规划'));
    assert.ok(!html.includes('NOT_THIS_CONVERSATION'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    const readOnly = renderToStaticMarkup(React.createElement(DispatchConversation, { board: { state: { ...state, configuration: { mode: 'read-only' } } }, lang: 'zh' }));
    assert.ok(readOnly.includes('只读预览'));
    assert.match(readOnly, /<textarea[^>]*disabled/);
    assert.ok(!readOnly.includes('重新请求规划'));
    const dispatchOnly = renderToStaticMarkup(React.createElement(DispatchConversation, { board: { state: { ...state, configuration: { mode: 'read-only' }, capabilities: { dispatchInstructions: true } } }, lang: 'zh' }));
    assert.doesNotMatch(dispatchOnly, /<textarea[^>]*disabled/);
    assert.ok(dispatchOnly.includes('重新请求规划'));
    const queued = renderToStaticMarkup(React.createElement(DispatchConversation, { board: { state: {
      ...state, grok: { connected: false }, grokWake: { configured: true },
      instructions: [{ id: 'pending', text: 'Please plan', status: 'pending' }],
      dispatchSync: { checkedAt: '2026-11-09T02:00:00Z', delivery: { pending: { state: 'accepted' } } },
    } }, lang: 'zh' }));
    assert.ok(queued.includes('立即同步'));
    assert.ok(queued.includes('队列最近读取'));
    assert.ok(queued.includes('等待 Bot 回写'));
    assert.ok(queued.includes('Webhook 接受通知不代表 Bot 已读取'));
    assert.ok(!queued.includes('调度连接在线'));
  } finally { await server.close(); }
});
