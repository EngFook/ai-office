import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createTaskStore } from '../server/task-store.mjs';
import { parseReviewVerdict, reviewWorkHold } from '../server/review-policy.mjs';
import { routeTask, createTaskRunner } from '../server/task-runner.mjs';
import { quotaRerouteTargets } from '../server/resolution-policy.mjs';
import { huddleCandidates, createQwenHuddle } from '../server/qwen-huddle.mjs';
import { humanRequestSpec } from '../server/human-relay-policy.mjs';
import { meetingBlocked, meetingScope, blockingKey } from '../server/blocked-meeting-policy.mjs';

function fixture(t, options={}) {
  const home=realpathSync(mkdtempSync(path.join(tmpdir(),'office-review-loop-'))), projectPath=path.join(home,'project'); mkdirSync(projectPath);
  const store=createTaskStore({home,...options});
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const tasks=()=>store.snapshot({recoverLeases:false}).tasks;
  const get=id=>tasks().find(t=>t.id===id);
  const worker=provider=>({id:`${provider}-fake`,provider,roles:['any'],projectPath});
  const run=(id,provider,result,status='done',error='')=>{const claim=store.claimTask(worker(provider),{taskId:id});assert.ok(claim,`${id} claim by ${provider}`);return store.finishTask(id,claim.claimToken,{status,result,error});};
  const start=(description='Implement feature. Do not push, deploy, or merge.')=>{
    const root=store.createTask({title:'Feature',description,projectPath,provider:'claude'});
    run(root.id,'claude','Implemented and verified fixture feature.');return get(root.id);
  };
  return {home,projectPath,store,tasks,get,worker,run,start};
}

test('only an explicit leading verdict is actionable',()=>{
 for(const s of ['APPROVED', '**APPROVED**', 'APPROVED: checked','**APPROVED:** checked','# APPROVED: checked'])assert.equal(parseReviewVerdict(s),'approved');
 assert.equal(parseReviewVerdict('FIX NOTES: fix x'),'changes_requested');
 for(const s of ['', 'I would say APPROVED: maybe','Summary\nAPPROVED: yes','APPROVED without evidence'])assert.equal(parseReviewVerdict(s),null);
});

test('fake workers complete a bounded independent repair chain without touching project files',t=>{
 const f=fixture(t), root=f.start();
 assert.equal(root.reviewState,'pending');
 assert.equal(root.reviewPolicy,1);
 let review=f.get(root.reviewTaskId);
 assert.equal(f.store.claimTask(f.worker('claude'),{taskId:review.id}),null,'author cannot self-review');
 f.run(review.id,'codex','FIX NOTES: check missing validation in input.js.');
 let parent=f.get(root.id), repair=f.get(parent.reviewRepairTaskId);
 assert.equal(parent.status,'blocked');assert.equal(parent.reviewState,'changes_requested');
 assert.equal(repair.repairRound,1);assert.equal(repair.provider,'claude');assert.equal(repair.projectPath,root.projectPath);
 assert.ok(repair.description.includes(root.description));assert.match(repair.description,/Do not.*merge, push, deploy/s);
 assert.equal(f.store.claimTask(f.worker('codex'),{taskId:repair.id}),null);
 const claim=f.store.claimTask(f.worker('claude'),{taskId:repair.id});assert.ok(claim);
 assert.equal(f.get(root.id).reviewState,'repairing');
 const other=f.store.createTask({title:'Same project concurrent',provider:'codex',projectPath:f.projectPath});
 assert.equal(f.store.claimTask(f.worker('codex'),{taskId:other.id}),null,'existing project lock remains');
 f.store.finishTask(repair.id,claim.claimToken,{status:'done',result:'Repaired validation and verified regression.'});
 assert.equal(f.get(root.id).reviewState,'pending');
 review=f.get(f.get(root.id).reviewTaskId);assert.equal(review.provider,'codex');
 f.run(review.id,'codex','APPROVED: regression verified.');
 parent=f.get(root.id);assert.equal(parent.status,'done');assert.equal(parent.reviewState,'approved');
 assert.equal(parent.result,root.result,'original evidence preserved');assert.equal(parent.reviewRepairResult.taskId,repair.id);
 assert.match(parent.reviewRepairResult.result,/Repaired validation/);
 assert.equal(f.tasks().filter(t=>t.repairOf===root.id).length,1);
});

test('two automatic repair rounds maximum; Qwen cannot create extra investigation or retry',async t=>{
 const f=fixture(t);let root=f.start();
 for(let round=0;round<3;round++){
  f.run(f.get(root.id).reviewTaskId,'codex',`FIX NOTES: issue remains round ${round}.`);
  root=f.get(root.id);assert.equal(root.reviewRepairRound,Math.min(round+1,2));
  if(round<2){const repair=f.get(root.reviewRepairTaskId);assert.equal(repair.repairRound,round+1);f.run(repair.id,'claude',`Repair attempt ${round+1}, tested.`);}
 }
 root=f.get(root.id);assert.equal(root.reviewRepairTaskId,null);assert.equal(root.reviewState,'changes_requested');assert.equal(root.status,'blocked');
 assert.equal(f.tasks().filter(t=>t.repairOf===root.id).length,2);
 const first=f.tasks().find(t=>t.repairOf===root.id&&t.repairRound===1);assert.equal(first.status,'done');assert.equal(first.reviewState,'superseded');
 assert.ok(reviewWorkHold(root));assert.equal(humanRequestSpec(root),null);assert.equal(meetingBlocked(root),false);
 assert.equal(f.store.watchRetryAvailable(root),false);
 assert.equal(f.store.applyWatchDecision({provider:'claude',taskId:root.id,version:root.version,action:'retry'}),false);
 assert.throws(()=>f.store.retryBlockedTask(root.id,{version:root.version,provider:'claude',reason:'retry'}),/两轮/);
 assert.throws(()=>f.store.investigateBlockedTask(root.id,{version:root.version,provider:'codex',reason:'inspect'}),/两轮/);
 assert.deepEqual(routeTask(root,null).eligible,[]);
 assert.deepEqual(huddleCandidates(root,f.store.snapshot(),{},null,Date.now(),{},true).candidates,[]);
 let calls=0;const huddle=createQwenHuddle({store:f.store,runtimeReader:()=>({started:true}),qwenClient:{discussBlocked:async()=>{calls++;throw Error('No model should be called');}}});
 huddle.start();await huddle.tick();await huddle.stop();assert.equal(calls,0);
 assert.equal(f.tasks().filter(t=>t.repairOf===root.id).length,2);
});

test('unstructured completion is not approval and legacy reviews never trigger repairs',t=>{
 const f=fixture(t);const root=f.start();f.run(root.reviewTaskId,'codex','Looks fine in general.');
 assert.equal(f.get(root.id).reviewState,'blocked');assert.equal(f.get(root.id).status,'blocked');
 assert.equal(f.get(root.reviewTaskId).reviewVerdict,'unconfirmed');
 const legacy=f.store.createTask({title:'Review: manually created',kind:'review',reviewOf:root.id,provider:'codex',projectPath:f.projectPath});
 const before=f.get(root.id);f.run(legacy.id,'codex','FIX NOTES: historical notes.');
 assert.deepEqual(f.get(root.id),before);assert.equal(f.get(legacy.id).reviewApplied,false);assert.equal(f.get(legacy.id).reviewVerdict,'changes_requested');
});

test('parent edits invalidate old review and cancel queued followups',t=>{
 const f=fixture(t);const root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: change required.');
 const old=f.get(root.id),repair=f.get(old.reviewRepairTaskId);
 const edited=f.store.updateTask(root.id,{description:'New user request only',status:'pending'},{version:old.version});
 assert.equal(edited.reviewPolicy,undefined);assert.equal(f.get(repair.id).paused,true);
 assert.equal(f.store.claimTask(f.worker('claude'),{taskId:repair.id}),null);
 f.run(root.id,'claude','New completion with revised scope.');
 assert.notEqual(f.get(root.id).reviewTaskId,root.reviewTaskId);
 assert.equal(f.tasks().filter(t=>t.kind==='review').length,2);
});

test('deny/delete root prevents queued repair, and active repair prevents user overwrite',t=>{
 for(const action of ['deny','delete']){
  const f=fixture(t);const root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: change required.');
  let parent=f.get(root.id);const repair=f.get(parent.reviewRepairTaskId);
  f.store.cardAction(root.id,{action,version:parent.version,operationId:`operation-${action}`});
  assert.equal(f.get(repair.id).paused,true);assert.equal(f.store.claimTask(f.worker('claude'),{taskId:repair.id}),null);
 }
 const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: change.');
 const parent=f.get(root.id),repair=f.get(parent.reviewRepairTaskId);f.store.claimTask(f.worker('claude'),{taskId:repair.id});
 assert.throws(()=>f.store.updateTask(parent.id,{description:'Change mid-repair'}),/associated review or repair is running/);
 assert.throws(()=>f.store.cardAction(parent.id,{action:'deny',version:f.get(parent.id).version,operationId:'deny-active'}),/正在执行/);
});

test('late reviews and human gates cannot apply to a changed or denied parent',t=>{
 for(const change of [{humanRevision:10},{paused:true},{humanGate:{state:'denied',requestId:'denied'}},{humanGate:{state:'pending',requestId:'pending'}},{completionSource:'manual'}]){
  const f=fixture(t),root=f.start();const claim=f.store.claimTask(f.worker('codex'),{taskId:root.reviewTaskId});assert.ok(claim);
  // A second SQLite writer simulates a race with an external authorized update.
  const db=new DatabaseSync(path.join(f.home,'board.sqlite'));const changed={...f.get(root.id),...change};db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(changed),root.id);db.close();const before=f.get(root.id);
  f.store.finishTask(claim.task.id,claim.claimToken,{status:'done',result:'FIX NOTES: this result is stale.'});
  assert.deepEqual(f.get(root.id),before);assert.equal(f.get(claim.task.id).reviewApplied,false);assert.equal(f.tasks().filter(t=>t.repairOf).length,0);
 }
});

test('repairs stay pinned through quota rerouting and preserve scope instead of truncating authority',t=>{
 const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: change required.');const repair=f.get(f.get(root.id).reviewRepairTaskId);
 const quota={claude:{observedAt:new Date().toISOString(),windows:[{name:'Weekly',usedPercent:100,remainingPercent:0}]},codex:{observedAt:new Date().toISOString(),windows:[{name:'Weekly',usedPercent:10,remainingPercent:90}]}};
 assert.equal(quotaRerouteTargets([{id:'ordinary',provider:'claude',status:'pending'}],quota).length,1,'fixture contains genuine exhaustion');
 assert.deepEqual(routeTask(repair,quota).eligible,[],'original author waits for its own quota');
 assert.deepEqual(routeTask(repair,null).eligible,['claude']);assert.deepEqual(quotaRerouteTargets([repair,f.get(root.id)],quota),[]);
 assert.throws(()=>f.store.retryBlockedTask(root.id,{version:f.get(root.id).version,provider:'codex',reason:'switch'}));
 const large=fixture(t),long=large.start('a'.repeat(19900));large.run(long.reviewTaskId,'codex','FIX NOTES: bounded evidence.');
 assert.equal(large.tasks().filter(t=>t.repairOf).length,0,'oversize authority is not silently truncated');assert.equal(large.get(long.id).reviewState,'changes_requested');
});

test('independent SQLite finish attempts create at most one repair',async t=>{
 const f=fixture(t),root=f.start(),claim=f.store.claimTask(f.worker('codex'),{taskId:root.reviewTaskId});
 const gate=new SharedArrayBuffer(8),flags=new Int32Array(gate),moduleUrl=new URL('../server/task-store.mjs',import.meta.url).href;
 const promises=[1,2].map(()=>new Promise((resolve,reject)=>{
  const worker=new Worker(`const{parentPort,workerData:d}=require('node:worker_threads');(async()=>{const{createTaskStore}=await import(d.moduleUrl);const s=createTaskStore({home:d.home});const f=new Int32Array(d.gate);Atomics.add(f,0,1);Atomics.wait(f,1,0);let ok=false;try{s.finishTask(d.id,d.token,{status:'done',result:'FIX NOTES: race-safe repair.'});ok=true}catch(e){if(e.code!=='CLAIM_CONFLICT')throw e}finally{s.close()}parentPort.postMessage(ok)})().catch(e=>{throw e})`,{eval:true,workerData:{moduleUrl,home:f.home,gate,id:claim.task.id,token:claim.claimToken}});
  worker.once('message',resolve);worker.once('error',reject);
 }));
 while(Atomics.load(flags,0)<2)await new Promise(r=>setTimeout(r,5));Atomics.store(flags,1,1);Atomics.notify(flags,1);
 assert.equal((await Promise.all(promises)).filter(Boolean).length,1);assert.equal(f.tasks().filter(t=>t.repairOf===root.id).length,1);
});


test('a real runner with fake CLI processes drives implementation, independent review, repair and approval',async t=>{
 const f=fixture(t),calls=[];
 const spawnProcess=(binary,args,options)=>{
  const child=new EventEmitter();child.pid=900000+calls.length;child.exitCode=null;child.signalCode=null;
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.prompt='';
  child.stdin=new Writable({write(chunk,encoding,done){child.prompt+=chunk.toString();done();}});
  child.finish=summary=>{const text=JSON.stringify({status:'done',summary});child.stdout.write(JSON.stringify(binary==='/fake/claude'?{type:'result',subtype:'success',result:text}:{type:'item.completed',item:{type:'agent_message',text}})+'\n');if(binary==='/fake/codex')child.stdout.write(JSON.stringify({type:'turn.completed'})+'\n');child.exitCode=0;child.stdout.end();child.stderr.end();child.emit('close',0);};
  calls.push({binary,args,options,child});return child;
 };
 const runner=createTaskRunner({store:f.store,spawnProcess,terminate:child=>child.finish('Stopped fake process'),probeProviders:async()=>({claude:{available:true,authenticated:true,path:'/fake/claude'},codex:{available:true,authenticated:true,path:'/fake/codex'}}),providers:{claude:{enabled:true},codex:{enabled:true}},env:{PATH:'/fake'},pollIntervalMs:60000,heartbeatMs:10000});
 t.after(()=>runner.stop());
 const root=f.store.createTask({title:'Runner integration',description:'Repair only this fixture. No deployment.',provider:'claude',projectPath:f.projectPath});
 await runner.start();
 for(const [index,provider,result] of [[0,'claude','Implementation checked.'],[1,'codex','FIX NOTES: a validation edge case.'],[2,'claude','Repaired validation and ran checks.'],[3,'codex','APPROVED: exact fix verified.']]){
  await new Promise(resolve=>setImmediate(resolve));await runner.kick();assert.equal(calls.length,index+1,JSON.stringify({status:runner.status(),tasks:f.tasks().map(t=>({id:t.id,status:t.status,reviewState:t.reviewState,error:t.error}))}));assert.equal(calls[index].binary,`/fake/${provider}`);assert.equal(calls[index].options.cwd,f.projectPath);
  calls[index].child.finish(result);
 }
 await runner.kick();assert.equal(calls.length,4);assert.equal(f.get(root.id).reviewState,'approved');assert.equal(f.get(root.id).status,'done');
 assert.match(calls[2].child.prompt,/Do not.*merge, push, deploy/s);await runner.stop();
});

test('actual bound information and limits reach repair; scoped approval is never transferred',t=>{
 const f=fixture(t),task=f.store.createTask({title:'Needs information',description:'Implement the requested local validation.',provider:'claude',projectPath:f.projectPath});
 f.run(task.id,'claude','', 'blocked','Please provide the requested fixture name.');f.store.syncHumanRequests();
 const question=f.store.snapshot().humanRequests.find(q=>q.taskId===task.id&&q.state==='pending');assert.ok(question);
 const reply='Use fixture safe-input.json only. Do not change the network adapter or deploy.';
 f.store.answerHumanRequest(question.id,{source:'office-ui',replyAuthor:'user',userMessageId:'fixture-info',questionHash:question.questionHash,decision:'provide_info',userAction:'provide_info',userReply:reply});
 f.run(task.id,'claude','Implemented local validation.');f.run(f.get(task.id).reviewTaskId,'codex','FIX NOTES: repair the fixture parser.');
 assert.ok(f.get(f.get(task.id).reviewRepairTaskId).description.includes(reply));
 const scoped=fixture(t),original=scoped.store.createTask({title:'Prepare snapshot only',description:'No merge, push or deploy.',provider:'claude',projectPath:scoped.projectPath,approvalAction:'prepare_sanitized_snapshot'});
 scoped.store.syncHumanRequests();const request=scoped.store.snapshot().humanRequests.find(q=>q.taskId===original.id&&q.state==='pending');
 scoped.store.answerHumanRequest(request.id,{source:'office-ui',replyAuthor:'user',userMessageId:'fixture-preparation',questionHash:request.questionHash,decision:'approve',userAction:'approve',userReply:'同意净化准备方案'});
 scoped.run(original.id,'claude','Prepared authorized local snapshot.');scoped.run(scoped.get(original.id).reviewTaskId,'codex','FIX NOTES: verify sanitization.');
 assert.equal(scoped.tasks().filter(t=>t.repairOf===original.id).length,0);assert.equal(scoped.get(original.id).reviewState,'changes_requested');
});

test('editing or refusing a followup makes its parent explicitly stale without automatic resurrection',t=>{
 for(const edit of ['edit','deny']){
  const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix required.');const repair=f.get(f.get(root.id).reviewRepairTaskId);
  if(edit==='edit'){
   const updated=f.store.updateTask(repair.id,{description:'User-specific revised scope'});
   assert.equal(updated.repairBinding,undefined);assert.equal(updated.reviewDetachedFrom,root.id);
   f.run(repair.id,'claude','Explicit revised scope complete.');assert.equal(f.get(root.id).reviewState,'stale');
  }else f.store.cardAction(repair.id,{action:'deny',version:repair.version,operationId:'deny-repair'});
  assert.equal(f.get(root.id).reviewState,'stale');assert.deepEqual(routeTask(f.get(root.id),null).eligible,[]);
 }
});


test('review and repair worker interruption updates the parent without claiming active progress',t=>{
 let now=1000;const f=fixture(t,{now:()=>now,leaseMs:1000});let root=f.start();
 f.store.claimTask(f.worker('codex'),{taskId:root.reviewTaskId});f.store.stopRunningTask(root.reviewTaskId,'Synthetic lost worker.');
 assert.equal(f.get(root.id).reviewState,'blocked');assert.equal(f.get(root.id).status,'blocked');
 // Explicit user intervention starts a new bound completion, never stale acceptance.
 let parent=f.get(root.id);f.store.cardAction(root.id,{action:'rerequest',version:parent.version,operationId:'retry-after-review-stop'});
 f.run(root.id,'claude','Fresh implementation checked.');root=f.get(root.id);f.run(root.reviewTaskId,'codex','FIX NOTES: repair required.');
 const repair=f.get(f.get(root.id).reviewRepairTaskId);f.store.claimTask(f.worker('claude'),{taskId:repair.id});now+=1001;f.store.snapshot();
 assert.equal(f.get(repair.id).status,'blocked');assert.equal(f.get(root.id).reviewState,'blocked');
});

test('bound meeting cards cannot split, inherit delegates or rewrite their original repair scope',t=>{
 const f=fixture(t);if(!f.store.applyMeetingResolution)return t.skip('Legacy store has no meeting resolution mutation API.');
 const root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');const repair=f.get(f.get(root.id).reviewRepairTaskId);
 f.run(repair.id,'claude','','blocked','Temporary fixture failure.');const card=f.get(repair.id),scope=meetingScope(card),key=blockingKey(card);
 const record={key,status:'resolved',contextComplete:true,agendaCards:[{taskId:card.id,scope,version:card.version}],agendaRepresentatives:[{taskId:card.id,provider:'claude',scope}],resolutions:{}};
 f.store.saveBlockedMeeting(record);
 const votes=Object.fromEntries(['claude','codex','gemini'].map(p=>[p,[{taskId:card.id,resolved:true,evidence:'Synthetic consensus only.',action:'split',subtasks:[{title:'Outsourced repair',description:'Must not bypass original author.',provider:'codex'}]}]]));
 assert.equal(f.store.applyMeetingResolution({key,taskId:card.id,version:card.version,votes}),null);assert.equal(f.tasks().length,3);
 const child=f.store.createTask({title:'Existing shared work',provider:'codex',projectPath:f.projectPath});f.store.updateTask(child.id,{status:'done'});
 f.store.saveBlockedMeeting({...record,resolutions:{[card.id]:{status:'split',taskId:card.id,scope,childIds:[child.id]}}});
 assert.equal(f.store.resumeMeetingParent(key,card.id),false);assert.equal(f.get(card.id).description,card.description);
 const ordinary=f.store.createTask({title:card.title,description:card.description,projectPath:card.projectPath,provider:card.provider,role:card.role});f.run(ordinary.id,'claude','','blocked','Temporary fixture failure.');
 f.store.saveBlockedMeeting({...record,resolutions:{other:{status:'split',scope,childIds:[child.id]}}});
 assert.equal(f.store.inheritMeetingDelegates(key,ordinary.id),true,'ordinary same-scope card can inherit');
 assert.equal(f.store.inheritMeetingDelegates(key,card.id),false,'bound repair cannot inherit even without an existing resolution');
 f.store.updateTask(ordinary.id,{status:'done'});f.store.saveBlockedMeeting(record);for(const vote of Object.values(votes)){vote[0].action='retry';vote[0].subtasks=[];}
 assert.equal(f.store.applyMeetingResolution({key,taskId:card.id,version:card.version,votes}).status,'resumed');
 assert.equal(f.get(card.id).description,card.description);assert.ok(f.store.claimTask(f.worker('claude'),{taskId:card.id}));
});

test('denial through a real human question cancels root active links and never restarts its repair',t=>{
 const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');const repair=f.get(f.get(root.id).reviewRepairTaskId);
 f.run(repair.id,'claude','','blocked','Please provide missing fixture input.');f.store.syncHumanRequests();const q=f.store.snapshot().humanRequests.find(q=>q.taskId===repair.id&&q.state==='pending');assert.ok(q);
 f.store.cardAction(repair.id,{action:'deny',version:f.get(repair.id).version,operationId:'fixture-gated-denial',questionHash:q.questionHash});
 const parent=f.get(root.id);assert.equal(parent.reviewState,'stale');assert.equal(parent.reviewRepairTaskId,null);assert.equal(parent.reviewTaskId,null);assert.match(reviewWorkHold(parent),/变更或取消/);
 assert.equal(f.get(repair.id).humanGate.state,'denied');assert.equal(f.store.claimTask(f.worker('claude'),{taskId:repair.id}),null);
});

test('scope-changing re-request, replacement folder and stale pending bindings become explicit blocked cards',t=>{
 for(const mode of ['rerequest','folder','claim']){
  const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');const repair=f.get(f.get(root.id).reviewRepairTaskId);
  if(mode==='claim'){
   const db=new DatabaseSync(f.store.dbPath);db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify({...repair,humanRevision:99}),repair.id);db.close();
   assert.equal(f.store.claimTask(f.worker('claude'),{taskId:repair.id}),null);
  }else{
   f.run(repair.id,'claude','','blocked','Please provide the missing fixture folder.');
   if(mode==='rerequest') f.store.cardAction(repair.id,{action:'rerequest',version:f.get(repair.id).version,operationId:'unsynced-rerequest'},{syncQuestions:false});
   else{
    rmSync(f.projectPath,{recursive:true});const replacement=path.join(f.home,'replacement');mkdirSync(replacement);f.store.syncHumanRequests();const q=f.store.snapshot().humanRequests.find(q=>q.taskId===repair.id&&q.state==='pending');assert.ok(q);
    f.store.answerHumanRequest(q.id,{source:'office-ui',replyAuthor:'user',userMessageId:'new-folder',questionHash:q.questionHash,decision:'provide_info',userAction:'provide_info',userReply:`The restored folder is ${replacement}`,projectPath:replacement});
   }
  }
  assert.equal(f.get(repair.id).status,'blocked');assert.equal(f.get(repair.id).reviewState,'stale');assert.equal(f.get(root.id).reviewState,'stale');assert.equal(f.get(root.id).reviewRepairTaskId,null);
 }
});

test('deleting and restoring unreviewed completion leaves a visible explicit retry path',t=>{
 const f=fixture(t),root=f.start();f.store.cardAction(root.id,{action:'delete',version:root.version,operationId:'delete-awaiting-review'});
 const deleted=f.store.snapshot().deletedTasks.find(t=>t.id===root.id);f.store.cardAction(root.id,{action:'restore',version:deleted.version,operationId:'restore-awaiting-review'});
 let parent=f.get(root.id);assert.equal(parent.status,'blocked');assert.equal(parent.reviewState,'stale');assert.equal(f.get(root.reviewTaskId).paused,true);
 f.store.cardAction(root.id,{action:'rerequest',version:parent.version,operationId:'explicit-new-request'});parent=f.get(root.id);assert.equal(parent.status,'pending');assert.equal(parent.reviewPolicy,undefined);
 f.run(root.id,'claude','Explicitly requested fresh verification.');assert.equal(f.get(root.id).reviewState,'pending');assert.notEqual(f.get(root.id).reviewTaskId,root.reviewTaskId);
});

test('legacy original-task approval is not transferred to a new repair card',t=>{
 const f=fixture(t),task=f.store.createTask({title:'An exact original approval',description:'Only the original requested operation.',provider:'claude',projectPath:f.projectPath});
 f.run(task.id,'claude','','blocked','Waiting for user approval for this operation.');f.store.syncHumanRequests();const q=f.store.snapshot().humanRequests.find(q=>q.taskId===task.id&&q.state==='pending');assert.equal(q.kind,'approval');
 f.store.answerHumanRequest(q.id,{source:'office-ui',replyAuthor:'user',userMessageId:'original-only-approval',questionHash:q.questionHash,decision:'approve',userAction:'approve',userReply:'Yes, approve the specific request.'});
 f.run(task.id,'claude','Original operation checked.');f.run(f.get(task.id).reviewTaskId,'codex','FIX NOTES: further change required.');
 assert.equal(f.tasks().filter(t=>t.repairOf).length,0);assert.equal(f.get(task.id).reviewState,'changes_requested');
});

test('legacy repair obeys its author low-quota threshold while configured offices keep their explicit policy',()=>{
 const repair={id:'repair',provider:'claude',repairOf:'root',repairBinding:{policy:1,author:'claude'}};
 const quota={claude:{observedAt:new Date().toISOString(),windows:[{name:'Weekly',usedPercent:90,remainingPercent:10}]}};
 assert.deepEqual(routeTask(repair,quota).eligible,[]);assert.deepEqual(routeTask(repair,quota,{claude:{enabled:true}}).eligible,['claude']);
});

test('deleting historical applied review cards preserves approved or still-active root decisions',t=>{
 for(const mode of ['approved','repair-approved','changes']){
  const f=fixture(t),root=f.start();
  if(mode==='repair-approved'){
   f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');f.run(f.get(root.id).reviewRepairTaskId,'claude','Repaired and checked.');
  }
  const reviewId=f.get(root.id).reviewTaskId;f.run(reviewId,'codex',mode==='changes'?'FIX NOTES: change within original scope.':'APPROVED: independently checked.');
  const before=f.get(root.id),review=f.get(reviewId);assert.equal(review.reviewApplied,true);
  f.store.cardAction(reviewId,{action:'delete',version:review.version,operationId:`historical-delete-${mode}`});
  assert.deepEqual(f.get(root.id),before,'a history delete must not revoke or restart an applied review');
 }
});

test('cancelled reviews stale the completed intermediate repair instead of leaving it awaiting forever',t=>{
 for(const action of ['review-deny','review-edit','root-edit','root-delete']){
  const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');const repairId=f.get(root.id).reviewRepairTaskId;f.run(repairId,'claude','Repair complete and checked.');
  const reviewId=f.get(root.id).reviewTaskId;assert.equal(f.get(repairId).reviewState,'pending');
  if(action==='review-deny')f.store.cardAction(reviewId,{action:'deny',version:f.get(reviewId).version,operationId:action});
  if(action==='review-edit')f.store.updateTask(reviewId,{description:'User changed review scope.'});
  if(action==='root-edit')f.store.updateTask(root.id,{description:'User changed original scope.'});
  if(action==='root-delete')f.store.cardAction(root.id,{action:'delete',version:f.get(root.id).version,operationId:action});
  assert.equal(f.get(repairId).reviewState,'stale');assert.equal(f.get(repairId).reviewTaskId,null);
 }
});

test('indirect review links invalidate edited repairs and prohibit edits while their own review runs',t=>{
 for(const active of [false,true]){
  const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: fix validation.');const repairId=f.get(root.id).reviewRepairTaskId;f.run(repairId,'claude','Repair complete.');const reviewId=f.get(root.id).reviewTaskId;
  if(!active){
   f.run(reviewId,'codex','Review completed without an explicit verdict.');assert.equal(f.get(root.id).reviewRepairTaskId,null);
   f.store.updateTask(repairId,{description:'Explicitly revised repair scope.'});assert.equal(f.get(root.id).reviewState,'stale');assert.equal(f.get(root.id).reviewTaskId,null);
  }else{
   f.store.claimTask(f.worker('codex'),{taskId:reviewId});f.store.stopRunningTask(reviewId,'Synthetic reviewer interruption.');
   f.store.cardAction(reviewId,{action:'rerequest',version:f.get(reviewId).version,operationId:'retry-unchanged-review'});
   assert.ok(f.store.claimTask(f.worker('codex'),{taskId:reviewId}));assert.equal(f.get(repairId).status,'blocked');
   assert.throws(()=>f.store.updateTask(repairId,{description:'Change while review is active.'}),/associated review or repair is running/);
  }
 }
});

test('completed repair without a queueable reviewer or current root is explicit blocked or stale',t=>{
 for(const settings of [{crossReview:false},{reviewerFor:{}}]){
  const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: repair validation.');const repairId=f.get(root.id).reviewRepairTaskId;
  const claim=f.store.claimTask(f.worker('claude'),{taskId:repairId});assert.ok(claim);
  const reconfigured=createTaskStore({home:f.home,...settings});
  try{reconfigured.finishTask(repairId,claim.claimToken,{status:'done',result:'Repair completed after review configuration changed.'});}finally{reconfigured.close();}
  assert.equal(f.get(root.id).status,'blocked');assert.equal(f.get(root.id).reviewState,'blocked');assert.equal(f.get(root.id).reviewRepairTaskId,null);assert.equal(f.get(root.id).reviewTaskId,null);
  assert.equal(f.get(repairId).reviewPolicy,1);assert.equal(f.get(repairId).reviewState,'blocked');assert.match(f.get(repairId).error,/no independent review could be queued/);
 }
 const f=fixture(t),root=f.start();f.run(root.reviewTaskId,'codex','FIX NOTES: repair validation.');const repairId=f.get(root.id).reviewRepairTaskId;const claim=f.store.claimTask(f.worker('claude'),{taskId:repairId});
 const db=new DatabaseSync(f.store.dbPath),changed={...f.get(root.id),humanRevision:123};db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(changed),root.id);db.close();
 const ended=f.store.finishTask(repairId,claim.claimToken,{status:'done',result:'Completed work under a superseded binding.'});
 assert.equal(ended.status,'blocked');assert.equal(ended.reviewPolicy,1);assert.equal(ended.reviewState,'stale');assert.match(ended.error,/binding changed/);assert.deepEqual(f.get(root.id),changed);
});
