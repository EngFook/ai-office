import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('compact cards preserve full source in task details and attention counts exclude Grok triage and denials', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-attention-render-'))
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: {noDiscovery:true,include:[]}, server:{middlewareMode:true,hmr:false}, appType:'custom' })
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js')
    const { default: TaskBoard } = await vite.ssrLoadModule('/src/TaskBoard.jsx')
    const { default: HumanRelayPanel } = await vite.ssrLoadModule('/src/HumanRelayPanel.jsx')
    const { default: QwenWatchNotice } = await vite.ssrLoadModule('/src/QwenWatchNotice.jsx')
    const description = JSON.stringify({ raw:'RAW_DETAILS_ONLY', instructions:'x'.repeat(1000) })
    const task = {id:'done',title:'Completed source',status:'done',description,provider:'codex',projectPath:'/fixture',version:1}
    const holds = ['approval','triage','denied'].map(id=>({id,title:id,status:'blocked',provider:'codex',projectPath:'/fixture',humanGate:{requestId:id,state:id==='denied'?'denied':'pending',kind:id==='approval'?'approval':'info'},resolution:{owner:'local-qwen',state:'needs_user'}}))
    const requests=holds.map(item=>({id:item.id,taskId:item.id,kind:item.humanGate.kind,state:item.humanGate.state,question:'Please review this request'}))
    const board={state:{tasks:[task,...holds],deletedTasks:[],humanRequests:requests,roles:[],instructions:[],settings:{autoPickup:false},runtime:{started:true,providers:{},running:[]}},refresh(){},cardActions(){}}
    for(const lang of ['en','zh']) {
      setLang(lang)
      const normal=renderToStaticMarkup(React.createElement(TaskBoard,{board,initialStatus:'done'}))
      assert.doesNotMatch(normal,/RAW_DETAILS_ONLY/)
      assert.ok(normal.indexOf('tb-controls')<normal.indexOf('tb-human-relay'))
      assert.ok(normal.indexOf('tb-kanban')<normal.indexOf('qwen-desk'))
      assert.doesNotMatch(normal,/class="tb-status-tabs"|Filter requests by status/)
      const opened=renderToStaticMarkup(React.createElement(TaskBoard,{board,initialTaskId:task.id}))
      assert.match(opened,/role="dialog"/)
      assert.match(opened,/RAW_DETAILS_ONLY/)
      assert.match(opened,lang==='en'?/Complete task instructions/:/完整任务指令/)
      const firstLoad=renderToStaticMarkup(React.createElement(TaskBoard,{board:{...board,loading:true,stale:true,lastSuccessAt:null,state:{...board.state,tasks:[]}}}))
      assert.match(firstLoad,lang==='en'?/Loading the task board…/:/正在读取任务板…/)
      assert.doesNotMatch(firstLoad,/Showing the last task snapshot|当前显示上次任务快照/)
      const running = {id:'running', title:'Live worker fixture',status:'running',provider:'codex',projectPath:'/fixture'}
      const staleBoard={...board,stale:true,lastSuccessAt:Date.now()-60000,state:{...board.state,tasks:[running,{id:'blocked',title:'Parent',status:'blocked',resolution:{owner:'local-qwen',state:'investigating',investigationTaskId:running.id}}],huddle:{enabled:true,phase:'discussing',meeting:{active:true,attendees:['claude']}},runtime:{...board.state.runtime,running:[{taskId:running.id,provider:'codex'}]}}}
      const stale=renderToStaticMarkup(React.createElement(TaskBoard,{board:staleBoard,initialTaskId:running.id}))
      assert.match(stale,lang==='en'?/Showing the last task snapshot/:/当前显示上次任务快照/)
      assert.match(stale,lang==='en'?/execution unconfirmed/:/执行待确认/)
      assert.match(stale,lang==='en'?/0 working now/:/实际处理 0/)
      assert.doesNotMatch(stale,/Qwen is analysing|Qwen 正在分析|集结代表|Delegates/)
      const staleNotice=renderToStaticMarkup(React.createElement(QwenWatchNotice,{huddle:{enabled:true,phase:'discussing'},runtime:{unavailable:true}}))
      assert.match(staleNotice,lang==='en'?/previous check for reference/:/上次检查记录仅供参考/)
      assert.doesNotMatch(staleNotice,/Qwen is analysing|Qwen 正在分析/)
      assert.doesNotMatch(stale,/Runner confirms execution|The runner confirms execution|Investigation running|执行器已确认运行|执行器已确认正在运行|排查正在执行/)
      const relay=renderToStaticMarkup(React.createElement(HumanRelayPanel,{board,requests}))
      assert.match(relay,lang==='en'?/1 awaiting your reply/:/1 项等你回复/)
      assert.match(relay,lang==='en'?/Awaiting Grok check · 1/:/待 Grok 核查 · 1/)
      assert.match(relay,lang==='en'?/Declined \/ paused · 1/:/已拒绝／暂停 · 1/)
      const notice=renderToStaticMarkup(React.createElement(QwenWatchNotice,{huddle:{enabled:true,phase:'waiting'},tasks:holds,runtime:board.state.runtime,humanRequests:requests}))
      assert.match(notice,lang==='en'?/1 need you · 1 await Grok · 0 working now/:/待你处理 1 · 待 Grok 核查 1 · 实际处理 0/)
      assert.doesNotMatch(notice,/with owners|项已有负责人/)
    }
  } finally { await vite.close(); await rm(cacheDir,{recursive:true,force:true}) }
})
