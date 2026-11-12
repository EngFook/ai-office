import test from 'node:test';
import assert from 'node:assert/strict';
import { providerQuotaStatus, tightestQuota } from '../src/usage-utils.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const now = Date.parse('2026-11-12T15:00:00Z');
const gemini = { windows: [], status: 'Subscription login', authenticated: true, authState: 'ready', quotaState: 'unsupported', model: 'gemini-configured', observedAt: now };

test('verified Gemini sign-in remains explicitly unknown quota and never supplies capacity', () => {
  const data = { quota: { gemini } };
  assert.equal(providerQuotaStatus(data, 'Gemini', { now }).state, 'quota-unsupported');
  assert.equal(tightestQuota(data, 'Gemini', now), null);
  assert.equal(providerQuotaStatus(data, 'Gemini', { now: now + 16 * 60000 }).state, 'stale');
  assert.equal(providerQuotaStatus(data, 'Gemini', { now, error: 'offline' }).state, 'unavailable');
});

test('Gemini login failures survive a previous success and retain only actual login commands', () => {
  const data = { quota: { gemini, geminiError: 'Needs login', geminiStatus: { authState: 'needs-login', needsLogin: true, checkedAt: new Date(now).toISOString(), loginCommand: "'/safe/client/agy'" } } };
  const result = providerQuotaStatus(data, 'Gemini', { now });
  assert.equal(result.state, 'needs-login');
  assert.equal(result.loginCommand, "'/safe/client/agy'");
  assert.equal(providerQuotaStatus({ quota: { geminiError: 'Connection failed' } }, 'Gemini', { now }).state, 'unavailable');
  assert.equal(providerQuotaStatus({ quota: {} }, 'Gemini', { now }).state, 'unconfirmed');
});

test('Grok distinguishes missing, invalid, expired reports and ended windows without invented quota', () => {
  for (const state of ['missing', 'invalid', 'stale', 'reset-expired']) {
    const data = { quota: { grok: { windows: [{ usedPercent: 94, remainingPercent: 6 }], observedAt: now - 7 * 3600000 }, grokError: 'stale', grokStatus: { state, checkedAt: now, observedAt: now - 7 * 3600000 } } };
    assert.equal(providerQuotaStatus(data, 'Grok', { now }).state, state);
    assert.equal(tightestQuota(data, 'Grok', now), null);
  }
});

test('Grok becomes reset-expired when the frontend clock crosses its reset before the next fetch', () => {
  const data = { quota: { grok: { windows: [{ usedPercent: 25, remainingPercent: 75, resetsAt: now + 1000 }], observedAt: now }, grokStatus: { state: 'fresh' } } };
  assert.equal(providerQuotaStatus(data, 'Grok', { now }).state, 'ready');
  assert.equal(providerQuotaStatus(data, 'Grok', { now: now + 1001 }).state, 'reset-expired');
});

test('provider status UI explains CLI login vs unsupported quota and stale Grok evidence in both languages', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'provider-quota-render-'));
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { ProviderQuotaStatus } = await vite.ssrLoadModule('/src/UsagePanel.jsx');
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      const render = (provider, quota) => renderToStaticMarkup(React.createElement(ProviderQuotaStatus, { provider, data: { quota }, now }));
      const connected = render('Gemini', { gemini });
      assert.match(connected, lang === 'zh' ? /额度未公开/ : /Quota not exposed/);
      assert.match(connected, lang === 'zh' ? /CLI 登录已验证/ : /CLI sign-in verified/);
      assert.match(connected, /gemini-configured/);
      assert.doesNotMatch(connected, /100%|unlimited|无限/);
      const login = render('Gemini', { geminiError: 'Needs login', geminiStatus: { needsLogin: true, checkedAt: new Date(now).toISOString(), loginCommand: "'/safe/client/agy'" } });
      assert.match(login, lang === 'zh' ? /CLI 需要登录/ : /CLI sign-in needed/);
      assert.match(login, /safe\/client\/agy/);
      assert.match(login, lang === 'zh' ? /最近检查/ : /Last checked/);
      const stale = render('Grok', { grokError: 'stale', grokStatus: { state: 'stale', observedAt: now - 7 * 3600000, checkedAt: now } });
      assert.match(stale, lang === 'zh' ? /额度报告已过期/ : /Quota report expired/);
      assert.match(stale, lang === 'zh' ? /刷新页面不会生成/ : /refreshing this view cannot create/);
      assert.doesNotMatch(stale, /100%|6%/);
    }
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
