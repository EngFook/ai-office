import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_RESEARCH_TYPES, geminiReadiness, geminiResearchDraft, geminiSourcePrompt, geminiTaskCounts } from '../src/gemini-desk.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('Gemini unknown or failed probes are not silently relabeled as logged out or ready', () => {
  assert.equal(geminiReadiness(), 'unknown');
  assert.equal(geminiReadiness({ available: true, authenticated: false }), 'unknown');
  assert.equal(geminiReadiness({ available: true, authenticated: false, authState: 'unknown' }), 'unknown');
  assert.equal(geminiReadiness({ available: true, authenticated: false, needsLogin: true }), 'needs-login');
  assert.equal(geminiReadiness({ available: false, authenticated: false }), 'unavailable');
  assert.equal(geminiReadiness({ available: true, authenticated: true, enabled: false }), 'disabled');
  assert.equal(geminiReadiness({ available: true, authenticated: true, authState: 'ready' }), 'ready');
  assert.equal(geminiReadiness({ available: true, authenticated: true }, true), 'unknown');
  assert.equal(geminiReadiness({ available: true, authenticated: true, authState: 'ready', modelSupported: false }), 'model-unavailable');
});

test('Gemini research drafts require real questions and current running counts require runner evidence', () => {
  for (const type of Object.keys(GEMINI_RESEARCH_TYPES)) {
    const draft = geminiResearchDraft(type, 'en');
    assert.equal(draft.provider, 'gemini');
    assert.equal(draft.role, 'Helper');
    assert.equal(draft.description, '');
    assert.ok(geminiSourcePrompt(type, 'en'));
    assert.notEqual(geminiSourcePrompt(type, 'en'), geminiSourcePrompt(type, 'zh'));
  }
  assert.equal(geminiResearchDraft('implement-code'), null);
  const tasks = [{id:'live',provider:'gemini',status:'running'}, {id:'old',provider:'gemini',status:'running'}, {id:'queued',provider:'gemini',status:'pending'}, {id:'blocked',assignee:{provider:'gemini'},status:'blocked'}];
  assert.deepEqual(geminiTaskCounts(tasks,[{provider:'gemini',taskId:'live'}]), {running:1,pending:1,blocked:1});
  assert.equal(geminiTaskCounts(tasks,[{provider:'gemini',taskId:'live',finished:true}]).running,0);
});

test('Gemini desk preserves actual source names, login evidence, and bilingual read-only scope without creating tasks', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'gemini-desk-render-'));
  const vite = await createServer({ cacheDir, configFile:false, optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true,hmr:false}, appType:'custom' });
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js');
    const { default: GeminiResearchDesk } = await vite.ssrLoadModule('/src/GeminiResearchDesk.jsx');
    let writes=0;
    for (const lang of ['en','zh']) {
      setLang(lang);
      const props={state:{runtime:{providers:{gemini:{available:true,authenticated:false,authState:'needs-login',model:'configured-model',loginCommand:"'/safe/client path/agy'"}},parallelCapabilities:{gemini:{taskSlots:2}}}},onCreate(){writes++;}};
      const html=renderToStaticMarkup(React.createElement(GeminiResearchDesk,props));
      assert.match(html,/configured-model/);
      assert.match(html,/safe\/client path\/agy/);
      assert.match(html,lang==='en'?/Configured model:/ : /配置模型：/);
      assert.match(html,lang==='en'?/Sign-in needed/ : /需要本人登录/);
      assert.match(html,lang==='en'?/Official documentation/ : /官方文档查证/);
      assert.match(html,lang==='en'?/Choosing a type does not create a task/ : /选择类型不会创建任务/);
      assert.equal((html.match(/type="button"/g)||[]).length,6);
      props.state.runtime.providers.gemini.authState='unknown';
      const unknown=renderToStaticMarkup(React.createElement(GeminiResearchDesk,props));
      assert.match(unknown,lang==='en'?/Status unconfirmed/ : /连接状态待确认/);
      assert.doesNotMatch(unknown,/safe\/client path\/agy/);
      assert.doesNotMatch(unknown,lang==='en'?/Sign-in needed/:/需要本人登录/);
    }
    assert.equal(writes,0);
  } finally {await vite.close();await rm(cacheDir,{recursive:true,force:true});}
});
