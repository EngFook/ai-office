import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { officeIdentity, officeDate } from '../src/office-identity.js';

test('office identity uses configured name and timezone with a local fallback for invalid configuration', () => {
  assert.equal(officeIdentity().name, 'AI Office');
  assert.deepEqual(officeIdentity({name:'  Design Lab ', timeZone:'Europe/Paris'}), {name:'Design Lab',timeZone:'Europe/Paris'});
  assert.equal(officeIdentity({name:' ', timeZone:'not-a-zone'}).timeZone, new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(officeIdentity(null).name, 'AI Office');
  const instant='2026-11-09T00:30:00Z';
  const options={year:'numeric',month:'2-digit',day:'2-digit'};
  assert.notEqual(officeDate(instant,{...options,timeZone:'America/Los_Angeles'}),officeDate(instant,{...options,timeZone:'Asia/Tokyo'}));
  assert.equal(officeDate('bad date'), '—');
});

test('setup explains safe modes locally in both languages without execution or credential controls', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-setup-render-'));
  const vite = await createServer({ cacheDir, configFile:false, optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true,hmr:false}, appType:'custom' });
  try {
    const {default:OfficeSetupStatus}=await vite.ssrLoadModule('/src/OfficeSetupStatus.jsx');
    const {OfficeIdentityContext,useOfficeDate}=await vite.ssrLoadModule('/src/OfficeIdentity.jsx');
    const {default:TaskBoard,TaskDetails}=await vite.ssrLoadModule('/src/TaskBoard.jsx');
    const render=(configuration,lang='en')=>renderToStaticMarkup(React.createElement(OfficeSetupStatus,{configuration,lang}));
    const fresh=render({configured:false,mode:'disabled'});
    assert.match(fresh,/Set up your office/);
    assert.match(fresh,/npm run setup/);
    assert.match(fresh,/New installations do not pick up tasks automatically/);
    const readOnly=render({configured:true,mode:'read-only'});
    assert.match(readOnly,/Read-only mode/);
    assert.match(readOnly,/AI task execution is paused/);
    const disabled=render({configured:true,mode:'disabled'},'zh');
    assert.match(disabled,/自动执行已关闭/);
    assert.match(disabled,/本机设置命令/);
    for (const markup of [fresh,readOnly,disabled]) assert.doesNotMatch(markup,/<(?:input|button|form)\b/);
    assert.match(render({configured:true,mode:'enabled'}),/Getting started/);
    assert.match(disabled,/npm run setup -- --overwrite/);
    assert.match(fresh,/npm run doctor/);
    assert.match(fresh,/127.0.0.1/);
    assert.equal(render(undefined),'');
    const task={id:'sample',title:'Sample task',status:'blocked',provider:'codex',projectPath:'/mock',role:'any'};
    const board={state:{configuration:{configured:true,mode:'read-only'},tasks:[task],roles:[],instructions:[],humanRequests:[],settings:{autoPickup:false},runtime:{providers:{},running:[]}}};
    const pausedBoard=renderToStaticMarkup(React.createElement(TaskBoard,{board}));
    assert.match(pausedBoard,/disabled=""[^>]*>.*?New request/);
    assert.doesNotMatch(pausedBoard,/选择任务：|tb-card-actions/);
    const details=renderToStaticMarkup(React.createElement(TaskDetails,{board,task,roles:[],onClose(){}}));
    assert.doesNotMatch(details,/Edit request|Retry request/);
    board.state.configuration.mode='enabled';
    const management=renderToStaticMarkup(React.createElement(TaskBoard,{board,initialTab:'management'}));
    assert.doesNotMatch(management,/name="grok_api_key"|Connect xAI API|optional API route/);
    function Time() { const date=useOfficeDate({year:'numeric',month:'2-digit',day:'2-digit'}); return React.createElement('span',null,date('2026-11-09T00:30:00Z')); }
    const inZone=timeZone=>renderToStaticMarkup(React.createElement(OfficeIdentityContext.Provider,{value:{name:'Example',timeZone}},React.createElement(Time)));
    assert.notEqual(inZone('America/Los_Angeles'),inZone('Asia/Tokyo'));
  } finally { await vite.close(); await rm(cacheDir,{recursive:true,force:true}); }
});
