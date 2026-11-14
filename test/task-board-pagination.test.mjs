import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('large task categories render a bounded first page while preserving total counts and explicit bulk scope', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-board-page-'));
  const vite = await createServer({ cacheDir,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom' });
  try {
    const {setLang}=await vite.ssrLoadModule('/src/i18n.js');
    const {default:TaskBoard}=await vite.ssrLoadModule('/src/TaskBoard.jsx');
    const tasks=Array.from({length:253},(_,i)=>({id:`card-${i}`,title:`Actual card ${i}`,status:'done',provider:'codex',version:1,createdAt:new Date(1000000+i*1000).toISOString()}));
    const board={state:{configuration:{mode:'enabled'},tasks,deletedTasks:[],humanRequests:[],roles:[],instructions:[],settings:{autoPickup:false},runtime:{providers:{},running:[]}}};
    for(const lang of ['zh','en']){
      setLang(lang);
      const html=renderToStaticMarkup(React.createElement(TaskBoard,{board,initialStatus:'done'}));
      assert.equal((html.match(/class="tb-task"/g)||[]).length,20);
      assert.match(html,lang==='zh'?/已显示 20 \/ 253 项/:/Showing 20 of 253/);
      assert.match(html,lang==='zh'?/再显示 20 项/:/Show 20 more/);
      assert.match(html,lang==='zh'?/最多 100 项，包含尚未展开的任务/:/100 matching tasks at most, including cards not expanded yet/);
      assert.match(html,/Actual card 252/);
      assert.doesNotMatch(html,/>Actual card 0</);
    }
    assert.equal(board.state.tasks.length,253);
  }finally{await vite.close();await rm(cacheDir,{recursive:true,force:true});}
});
