import test from 'node:test'
import assert from 'node:assert/strict'
import { humanRequestGroups } from '../src/human-relay-ui.js'
import { blockedWorkSummary, huddleTaskProgress } from '../src/huddle-ui.js'
import { compactTaskText } from '../src/task-card-content.js'

test('only unresolved user decisions count as needing the user; Grok triage and denials remain separate', () => {
  const tasks = ['approval', 'triage', 'delivered', 'denied', 'stale'].map(id => ({id, status:'blocked', humanGate:{requestId:id}}))
  tasks[4].humanGate.requestId = 'replacement'
  const requests = [
    {id:'approval',taskId:'approval',kind:'approval',state:'pending'},
    {id:'triage',taskId:'triage',kind:'info',state:'pending'},
    {id:'delivered',taskId:'delivered',kind:'info',state:'delivered'},
    {id:'denied',taskId:'denied',kind:'approval',state:'denied'},
    {id:'stale',taskId:'stale',kind:'approval',state:'pending'},
  ]
  const grouped = humanRequestGroups(requests, tasks)
  assert.deepEqual(grouped.needsUser.map(x=>x.id), ['approval','delivered'])
  assert.deepEqual(grouped.grokCheck.map(x=>x.id), ['triage'])
  assert.deepEqual(grouped.denied.map(x=>x.id), ['denied'])
})

test('Qwen coordination, human holds and verified execution count consistently without treating owners as workers', () => {
  const tasks = [
    {id:'held',status:'blocked',resolution:{owner:'local-qwen',state:'needs_user'},humanGate:{requestId:'held-q',kind:'approval',state:'pending'}},
    {id:'triage',status:'blocked',resolution:{owner:'local-qwen',state:'needs_user'},humanGate:{requestId:'triage-q',kind:'info',state:'pending'}},
    {id:'queued',status:'blocked',resolution:{owner:'local-qwen',state:'investigating',investigationTaskId:'job-queued'}},
    {id:'real',status:'blocked',resolution:{owner:'local-qwen',state:'investigating',investigationTaskId:'job-real'}},
    {id:'ghost',status:'blocked',resolution:{owner:'codex',state:'investigating',investigationTaskId:'job-ghost'}},
    {id:'denied',status:'blocked',humanGate:{state:'denied'}},
    {id:'job-queued',status:'pending'},
    {id:'job-real',status:'running'},
    {id:'job-ghost',status:'running'},
  ]
  const runtime={started:true,running:[{taskId:'job-real',provider:'claude'},{taskId:'unrelated',provider:'codex'}]}
  const requests=[{id:'held-q',taskId:'held',kind:'approval',state:'pending'},{id:'triage-q',taskId:'triage',kind:'info',state:'pending'}]
  const summary=blockedWorkSummary(tasks,runtime,requests)
  assert.deepEqual([summary.actionable,summary.needsUser,summary.grokCheck,summary.investigating,summary.paused],[3,1,1,1,1])
  assert.equal(summary.ownership.find(x=>x.taskId==='real').owner,'local-qwen')
  assert.equal(summary.ownership.find(x=>x.taskId==='real').executor,'claude')
  assert.equal(summary.ownership.find(x=>x.taskId==='ghost').state,'awaiting_execution')
  assert.equal(huddleTaskProgress('held',tasks,runtime,{},false,requests).status,'needs_user')
  assert.equal(huddleTaskProgress('triage',tasks,runtime,{},false,requests).status,'grok_check')
  assert.equal(huddleTaskProgress('ghost',tasks,runtime).status,'unconfirmed')
  assert.equal(blockedWorkSummary(tasks,{...runtime,started:false}).investigating,0)
  assert.equal(blockedWorkSummary(tasks).investigating,0)
})

test('card previews never dump arbitrary JSON or code and retain a bounded readable sentence', () => {
  assert.equal(compactTaskText({command:'PRIVATE_RAW_PAYLOAD'},'Open details'),'Open details')
  assert.equal(compactTaskText('{"command":"PRIVATE_RAW_PAYLOAD"}','Open details'),'Open details')
  assert.equal(compactTaskText('{"summary":"Check lock owner","debug":{"secret":"RAW"}}'),'Check lock owner')
  assert.equal(compactTaskText('```json\n{"command":"RAW"}\n```','Open details'),'Open details')
  assert.equal(compactTaskText('a'.repeat(1000)).length,161)
  assert.equal(compactTaskText('Check\n the   lock.'),'Check the lock.')
})

test('blocked parents follow the current repair and review job instead of stale investigation ownership', () => {
  const root={id:'root',status:'blocked',reviewState:'repairing',reviewRepairTaskId:'repair',reviewTaskId:'review-old',resolution:{owner:'local-qwen',state:'following_up'}}
  const repair={id:'repair',status:'running',repairOf:'root'}
  const runtime={started:true,running:[{taskId:'repair',provider:'claude'}]}
  let tasks=[root,repair]
  let summary=blockedWorkSummary(tasks,runtime)
  assert.deepEqual([summary.working,summary.repairing,summary.investigating],[1,1,0])
  assert.equal(summary.ownership[0].executor,'claude')
  assert.equal(summary.ownership[0].workTaskId,'repair')
  assert.equal(huddleTaskProgress('root',tasks,runtime).label,'Repair running')
  assert.equal(blockedWorkSummary(tasks,{...runtime,unavailable:true}).working,0)
  const reviewing={...root,reviewState:'pending',reviewTaskId:'review-new'}
  tasks=[reviewing,{...repair,status:'done'},{id:'review-new',status:'running',kind:'review',reviewOf:'repair',reviewBinding:{rootId:'root'}}]
  const reviewRuntime={started:true,running:[{taskId:'review-new',provider:'codex'}]}
  summary=blockedWorkSummary(tasks,reviewRuntime)
  assert.deepEqual([summary.working,summary.reviewing,summary.repairing],[1,1,0])
  assert.equal(huddleTaskProgress('root',tasks,reviewRuntime).label,'Review running')
  assert.equal(blockedWorkSummary([{...root,humanGate:{state:'denied'}},repair],runtime).working,0)
  const answered={...root,resolution:{state:'needs_user'},humanGate:{state:'answered'}}
  assert.equal(blockedWorkSummary([answered,repair],runtime).working,1,'an answered old question does not mask the real repair')
  assert.equal(blockedWorkSummary([root,{...repair,repairOf:'unrelated'}],runtime).working,0,'unrelated workers are not attributed')
})

test('human attention needs a current bound question and live execution needs a started matching running job', () => {
  const task={id:'task',status:'blocked',humanGate:{requestId:'q',state:'pending',kind:'approval'},resolution:{state:'needs_user'}}
  assert.equal(blockedWorkSummary([task]).needsUser,0)
  assert.equal(blockedWorkSummary([task]).grokCheck,0)
  assert.equal(blockedWorkSummary([task],{},[{id:'q',taskId:'task',state:'answered',kind:'approval'}]).needsUser,0)
  assert.equal(blockedWorkSummary([task],{},[{id:'q',taskId:'task',state:'pending',kind:'approval'}]).needsUser,1)
  const running={id:'job',status:'running'}
  for(const runtime of [{running:[{taskId:'job'}]}, {started:false,running:[{taskId:'job'}]}, {started:true,running:[{taskId:'job',status:'done'}]}, {started:true,running:[{taskId:'job',finished:true}]}]) {
    assert.equal(huddleTaskProgress('job',[running],runtime).status,'unconfirmed')
  }
  assert.equal(huddleTaskProgress('job',[running],{started:true,running:[{taskId:'job',status:'working'}]}).status,'running')
})

test('recorded repair or review states do not count as execution without a live job', () => {
  for(const state of ['investigating','repairing','reviewing']) {
    const summary=blockedWorkSummary([{id:'a',status:'blocked',resolution:{state,owner:'claude'}}],{started:true,running:[]})
    assert.equal(summary.working,0)
    assert.equal(summary.ownership[0].state,'awaiting_execution')
    assert.equal(summary.ownership[0].executor,null)
  }
  const task={id:'a',status:'blocked',humanGate:{requestId:'q',state:'pending'}}
  assert.equal(huddleTaskProgress('a',[task],{}, {},true,[{id:'q',taskId:'a',state:'denied'}]).status,'paused')
  assert.equal(compactTaskText('[WIP] fix login'),'[WIP] fix login')
});
