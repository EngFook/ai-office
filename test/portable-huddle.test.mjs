import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQwenHuddle, huddleCandidates } from '../server/qwen-huddle.mjs';
import { createTaskStore } from '../server/task-store.mjs';

const AT = Date.parse('2026-11-09T10:00:00Z');
const quota = Object.fromEntries(['claude','codex'].map(provider => [provider, { observedAt: AT, windows: [{ name:'Weekly', remainingPercent:80, resetsAt:AT+86400000 }] }]));
const runtime = { running:[], providers: Object.fromEntries(['claude','codex','local-qwen'].map(provider => [provider,{ available:true,authenticated:true }])) };
const providers = { claude:{ enabled:true, concurrency:1 }, codex:{ enabled:true, concurrency:1 }, 'local-qwen':{ enabled:true, concurrency:1 } };
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(),'portable-huddle-')));
  const store = createTaskStore({ home:dir, crossReview:false, now:()=>AT });
  store.updateSettings({autoPickup:true});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const card = store.createTask({title:'Ordinary fix',description:'Fix this project only.',provider:'claude',projectPath:dir});
  const task = store.updateTask(card.id,{status:'blocked'});
  // A transient error eligible for retry, with no additional human gate.
  task.error = 'HTTP 503 service unavailable';
  return {dir,store,task,board:{tasks:[task],settings:{autoPickup:true}}};
}

test('configured candidates never broaden explicit ownership or investigate through a disabled alternate',async t=>{
  const f = await fixture(t);
  for(const investigate of [false,true]) {
    const disabled = { ...providers,claude:{enabled:false} };
    assert.deepEqual(huddleCandidates(f.task,f.board,runtime,quota,AT,undefined,investigate,{providers:disabled}).candidates,[]);
    const offline = {...runtime,providers:{...runtime.providers,claude:{available:false,authenticated:false}}};
    assert.deepEqual(huddleCandidates(f.task,f.board,offline,quota,AT,undefined,investigate,{providers}).candidates,[]);
    assert.deepEqual(huddleCandidates(f.task,f.board,runtime,quota,AT,undefined,investigate,{providers}).candidates.map(c=>c.provider),['claude']);
  }
});

test('configured any assignments and investigation honor workProviders and per-provider capacity',async t=>{
  const f = await fixture(t), task={...f.task,provider:'any'}, board={...f.board,tasks:[{...f.task,provider:'any'}]};
  const configuration = {providers,routing:{workProviders:['claude']}};
  for(const investigate of [false,true]) {
    assert.deepEqual(huddleCandidates(task,board,runtime,quota,AT,undefined,investigate,configuration).candidates.map(c=>c.provider),['claude']);
    const withPending = {...board,tasks:[task,{id:'queued',status:'pending',provider:'claude',projectPath:path.join(f.dir,'different-project')}]};
    const held=huddleCandidates(task,withPending,runtime,quota,AT,undefined,investigate,configuration);
    assert.deepEqual(held.candidates,[]);assert.match(held.reason,/工作位已满/);
  }
});

test('configured reviewers and review investigators cannot become the original author',async t=>{
  const f=await fixture(t), original={id:'original',provider:'codex',status:'done',assignee:{provider:'codex'}};
  const configuration={providers,reviewerFor:{claude:'codex',codex:'claude'}};
  for(const investigate of [false,true]){
    for(const requested of ['claude','codex']){
      const review={...f.task,kind:'review',title:'Review: original',reviewOf:original.id,provider:requested};
      const result=huddleCandidates(review,{...f.board,tasks:[original,review]},runtime,quota,AT,undefined,investigate,configuration);
      assert.deepEqual(result.candidates.map(c=>c.provider),requested==='claude'?['claude']:[]);
    }
  }
});

test('whole configured huddle cannot obey model advice to reassign a disabled original owner',async t=>{
  const f=await fixture(t);
  const disabled={...providers,claude:{enabled:false,concurrency:1}};
  let source,kicks=0;
  const huddle=createQwenHuddle({store:f.store,providers:disabled,routing:{workProviders:['codex']},runtimeReader:()=>runtime,quotaReader:()=>quota,now:()=>AT,
    qwenClient:{discussBlocked:async facts=>{source=facts;return{suggestions:[{taskId:f.task.id,preferredProvider:'codex'}]};}},onDispatch:()=>{kicks++;}});
  t.after(()=>huddle.stop());huddle.start();await huddle.tick();await huddle.stop();
  const task=f.store.snapshot().tasks.find(task=>task.id===f.task.id);
  assert.equal(task.provider,'claude');assert.equal(task.status,'blocked');assert.equal(kicks,0);
  assert.equal(source, undefined, "no inference for a held task");
  assert.equal(f.store.snapshot().tasks.filter(task=>task.kind==='resolution').length,0);
});

test('disabled Qwen chair never reads runtime or invokes inference',async t=>{
  const f=await fixture(t),forbidden=()=>assert.fail('disabled chair must stay stopped');
  const huddle=createQwenHuddle({store:f.store,providers:{...providers,'local-qwen':{enabled:false}},runtimeReader:forbidden,quotaReader:forbidden,qwenClient:{discussBlocked:forbidden}});
  assert.equal(huddle.start().enabled,false);await huddle.tick();await huddle.stop();
});
