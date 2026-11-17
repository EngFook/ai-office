import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { officeRelay } from '../server/office-relay.mjs';
import { gunzipSync } from 'node:zlib';
const id='0c35ab78-2f4a-4110-8ebd-f98eb9a0aa56';
async function fixture(t, options={}){
 const home=await mkdtemp(path.join(tmpdir(),'office-relay-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const state={instructions:[],csrfToken:'UPSTREAM_SECRET',configuration:{mode:'enabled'}};
 let posts=0,uncertain=false;
 const fetchImpl=async(url,options={})=>{
  if(!options.method)return {ok:true,status:200,json:async()=>structuredClone(state)};
  assert.equal(options.headers['X-Office-Token'],'UPSTREAM_SECRET');posts++;
  const payload=JSON.parse(options.body);const instruction={...payload,id:'legacy-id-'+posts,status:'pending',updatedAt:new Date().toISOString()};state.instructions.push(instruction);
  if(uncertain)throw new Error('Timeout after write');
  return {ok:true,status:202,json:async()=>({instruction})};
 };
 const create=()=>{let handler;const httpServer=new EventEmitter();t.after(()=>httpServer.emit('close'));officeRelay({home,upstream:'http://127.0.0.1:5999',fetchImpl,...options}).configureServer({httpServer,middlewares:{use:value=>handler=value}});return async(url='/api/office/board',input,options={})=>{
  const request=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);Object.assign(request,{url,method:input?'POST':'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:5186','content-type':'application/json',...options.headers},...options.request});
  let body;const headers={};const response={statusCode:200,setHeader(name,value){headers[name.toLowerCase()]=value;},getHeader(name){return headers[name.toLowerCase()];},end(value){body=JSON.parse(headers['content-encoding']==='gzip'?gunzipSync(value):value)}};await handler(request,response,()=>assert.fail('Expected route'));return {status:response.statusCode,body,headers};
 };};
 const call=create();const board=await call();return {home,state,call,create,token:board.body.csrfToken,posts:()=>posts,setUncertain:()=>uncertain=true};
}
test('relay grants only dispatch writes with a separate same-origin token and preserves live readonly mode',async t=>{
 const f=await fixture(t);assert.notEqual(f.token,'UPSTREAM_SECRET');
 const board=(await f.call()).body;assert.equal(board.configuration.mode,'read-only');assert.equal(board.capabilities.dispatchInstructions,true);
 const input={requestId:id,text:'Plan work',projectPath:'/work'};
 assert.equal((await f.call('/api/office/instructions',input)).status,403);
 assert.equal((await f.call('/api/office/instructions',input,{headers:{'x-office-token':f.token,origin:'https://evil.test'}})).status,403);
 assert.equal((await f.call('/api/office/settings',input,{headers:{'x-office-token':f.token}})).status,403);
 assert.equal(f.posts(),0);
 f.state.configuration.mode='read-only';assert.equal((await f.call()).body.capabilities.dispatchInstructions,false);
 assert.equal((await f.call('/api/office/instructions',input,{headers:{'x-office-token':f.token}})).status,403);
});
test('legacy upstream submissions are replay safe across relay restarts',async t=>{
 const f=await fixture(t),input={requestId:id,text:'Plan work',projectPath:'/work'};
 const send=(call,token,payload=input)=>call('/api/office/instructions',payload,{headers:{'x-office-token':token}});
 const first=await send(f.call,f.token);assert.equal(first.status,202);
 assert.equal((await send(f.call,f.token)).body.instruction.id,first.body.instruction.id);assert.equal(f.posts(),1);
 const restarted=f.create(),token=(await restarted()).body.csrfToken;
 assert.equal((await send(restarted,token)).body.instruction.id,first.body.instruction.id);assert.equal(f.posts(),1);
 assert.equal((await send(restarted,token,{...input,text:'Other work'})).status,409);
 assert.equal((await send(restarted,token,{...input,requestId:'invalid'})).status,400);
});
test('uncertain legacy write is never automatically posted twice',async t=>{
 const f=await fixture(t);f.setUncertain();const input={requestId:id,text:'Plan work',projectPath:'/work'},options={headers:{'x-office-token':f.token}};
 assert.equal((await f.call('/api/office/instructions',input,options)).status,503);
 assert.equal((await f.call('/api/office/instructions',input,options)).status,409);
 assert.equal(f.posts(),1);
});
test('relay rejects non-local upstream and malformed journals',async t=>{
 assert.throws(()=>officeRelay({upstream:'https://remote.test'}));
 const f=await fixture(t);await writeFile(path.join(f.home,'dispatch-relay-requests.json'),'broken');assert.throws(()=>f.create());
});

test('relay wakes a legacy queue after submission and reads actual plan replies from that same queue',async t=>{
 const calls=[];
 const dispatchWake={notify:async items=>calls.push(structuredClone(items)),status:()=>({configured:true}),delivery:items=>Object.fromEntries(items.filter(i=>i.status==='pending').map(i=>[i.id,{state:'accepted'}])),stop(){}};
 const f=await fixture(t,{dispatchWake});
 const result=await f.call('/api/office/instructions',{requestId:id,text:'Plan work',projectPath:'/work'},{headers:{'x-office-token':f.token}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.equal(calls[0][0].id,result.body.instruction.id);
 const queued=(await f.call()).body;
 assert.equal(queued.dispatchSync.delivery[result.body.instruction.id].state,'accepted');
 assert.equal(queued.dispatchSync.botConnected,false);assert.equal(queued.instructions[0].status,'pending');
 f.state.instructions[0]={...f.state.instructions[0],status:'done',summary:'Actual external planning reply'};
 const updated=(await f.call()).body;
 assert.equal(updated.instructions[0].summary,'Actual external planning reply');assert.deepEqual(updated.dispatchSync.delivery,{});
});

test('relay preserves upstream delivery metadata and does not double notify a newer office',async t=>{
 const dispatchWake={notify:async()=>assert.fail('Upstream owns notification'),status:()=>({configured:false}),delivery:()=>({}),stop(){}};
 const f=await fixture(t,{dispatchWake});
 f.state.dispatchSync={source:'office-queue',notification:{configured:true},delivery:{},checkedAt:'2026-11-09T01:00:00Z'};
 await f.call('/api/office/instructions',{requestId:id,text:'Plan work',projectPath:'/work'},{headers:{'x-office-token':f.token}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual((await f.call()).body.dispatchSync,f.state.dispatchSync);
});

test('relay preserves upstream office identity/catalog and gates project registration on current capability', async t => {
 const f=await fixture(t,{userActions:true});
 f.state.configuration.name='Custom Studio';
 f.state.projectCatalog=[{id:'new',name:'New Project',path:'/custom/project',folders:[]}];
 f.state.capabilities={projects:true};
 const board=(await f.call()).body;
 assert.equal(board.configuration.name,'Custom Studio');
 assert.deepEqual(board.projectCatalog,f.state.projectCatalog);
 assert.equal(board.capabilities.projects,true);
 const options={headers:{'x-office-token':f.token}};
 const request={name:'New',path:'/arbitrary/project'};
 assert.equal((await f.call('/api/office/projects',request,options)).status,202);
 assert.equal(f.posts(),1);
 f.state.capabilities.projects=false;
 assert.equal((await f.call('/api/office/projects',request,options)).status,403);
 assert.equal(f.posts(),1);
 assert.equal((await f.call()).body.capabilities.projects,false);
 delete f.state.capabilities;
 assert.equal((await f.call()).body.capabilities.projects,false);
 const readonly=await fixture(t,{userActions:false});readonly.state.capabilities={projects:true};
 assert.equal((await readonly.call()).body.capabilities.projects,false);
 assert.equal((await readonly.call('/api/office/projects',request,{headers:{'x-office-token':readonly.token}})).status,403);
});

test('ten simultaneous board views share one upstream read, preserve all data and isolate upstream authority', async t => {
 const state={csrfToken:'UPSTREAM_TOKEN',configuration:{mode:'enabled'},capabilities:{projects:true},dispatchSync:{source:'office-queue'},tasks:[{id:'one',description:'Full task history '.repeat(1000)}],observedAt:'2026-11-17T00:00:00Z'};
 let reads=0,hold=false,release;
 const fetchImpl=async()=>{reads++;if(hold)await new Promise(resolve=>{release=resolve;});return{ok:true,status:200,json:async()=>structuredClone(state)};};
 const f=await fixture(t,{fetchImpl,userActions:true});reads=0;hold=true;
 const reading=Promise.all(Array.from({length:10},()=>f.call('/api/office/board',undefined,{headers:{'accept-encoding':'gzip'}})));
 assert.equal(reads,1);release();hold=false;
 const views=await reading;
 for(const view of views){
  assert.equal(view.status,200);assert.equal(view.headers['content-encoding'],'gzip');
  assert.equal(view.body.csrfToken,f.token);assert.equal(view.body.configuration.mode,'read-only');
  assert.equal(view.body.capabilities.projects,true);assert.deepEqual(view.body.tasks,state.tasks);assert.equal(view.body.observedAt,state.observedAt);
 }
 assert.equal(state.csrfToken,'UPSTREAM_TOKEN');assert.equal(state.configuration.mode,'enabled');
 await f.call();assert.equal(reads,2,'a completed observation must never be cached');
});

test('writes bypass an older shared read and later reads cannot reuse a pre-mutation snapshot', async t => {
 const state={csrfToken:'BEFORE',configuration:{mode:'enabled'},dispatchSync:{source:'office-queue'},settings:{autoPickup:false}};
 let reads=0,pauseNext=false,release,postedToken;
 const fetchImpl=async(_url,options={})=>{
  if(!options.method){reads++;const value=structuredClone(state);if(pauseNext){pauseNext=false;await new Promise(resolve=>{release=resolve;});}return{ok:true,status:200,json:async()=>value};}
  postedToken=options.headers['X-Office-Token'];state.settings.autoPickup=true;
  return{ok:true,status:200,json:async()=>({settings:structuredClone(state.settings)})};
 };
 const f=await fixture(t,{fetchImpl,userActions:true});reads=0;pauseNext=true;
 const oldView=f.call();state.csrfToken='AFTER';
 const changed=await f.call('/api/office/settings',{autoPickup:true},{headers:{'x-office-token':f.token},request:{method:'PATCH'}});
 assert.equal(changed.status,200);assert.equal(postedToken,'AFTER');assert.equal(reads,2);
 const current=await f.call();assert.equal(current.body.settings.autoPickup,true);assert.equal(reads,3);
 release();assert.equal((await oldView).body.settings.autoPickup,false,'an already-started read retains its actual observation');
});

test('a failed shared board read is discarded so later polls can reconnect', async t => {
 let broken=false,reads=0;
 const f=await fixture(t,{fetchImpl:async()=>{reads++;if(broken)throw new Error('unavailable');return{ok:true,status:200,json:async()=>({csrfToken:'SECRET',configuration:{mode:'enabled'}})};}});
 reads=0;broken=true;
 const failed=await Promise.all(Array.from({length:10},()=>f.call()));
 assert.equal(reads,1);assert.ok(failed.every(result=>result.status===503));
 broken=false;assert.equal((await f.call()).status,200);assert.equal(reads,2);
});
