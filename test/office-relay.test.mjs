import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { officeRelay } from '../server/office-relay.mjs';
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
  let body;const response={statusCode:200,setHeader(){},end(value){body=JSON.parse(value)}};await handler(request,response,()=>assert.fail('Expected route'));return {status:response.statusCode,body};
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
