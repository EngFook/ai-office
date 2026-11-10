import { GROK_COMMUNICATION_POLICY } from './communication-policy.mjs';
import { mkdir, readFile, writeFile, rename, lstat, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const API = 'https://api.x.ai/v1';
const text = (value, limit=2000) => typeof value==='string' ? value.trim().slice(0,limit) : '';
const error = (message,status=400) => Object.assign(new Error(message),{status,statusCode:status});
const fields = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string = {type:'string'};
export const MANAGEMENT_SCHEMA = fields({
  summary:string,
  roles:{type:'array',items:fields({name:string,description:string})},
  tasks:{type:'array',items:fields({title:string,description:string,provider:{type:'string',enum:['any','codex','claude','gemini','grok-bot']},role:{type:'string',enum:['any','Facilitator','Admin','Helper','Tester']},priority:{type:'string',enum:['low','normal','high']}})},
});

export function validateManagementPlan(plan, projectPath='') {
  const valid=(value,max)=>typeof value==='string' && value.trim().length>0 && value.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  if (!plan || typeof plan!=='object' || !valid(plan.summary,10000) || !Array.isArray(plan.roles) || !Array.isArray(plan.tasks) || plan.roles.length>20 || plan.tasks.length>40) throw error('Grok returned an incomplete management plan. Retry this instruction.',502);
  const roles=plan.roles.map(role=>{
    if(!role || !valid(role.name,100) || !valid(role.description,3000)) throw error('Grok returned an invalid management role.',502);
    return {name:text(role.name,100),description:text(role.description,3000),provider:'grok'};
  });
  const tasks=plan.tasks.map(task=>{
    if(!task || !valid(task.title,200) || !valid(task.description,16000) || !['any','codex','claude','gemini','grok-bot'].includes(task.provider) || !['any','Facilitator','Admin','Helper','Tester'].includes(task.role) || !['low','normal','high'].includes(task.priority)) throw error('Grok returned an invalid task. No tasks were added.',502);
    // A model cannot grant access to a different project directory.
    return {title:text(task.title,200),description:text(task.description,16000),provider:task.provider,role:task.role,priority:task.priority,projectPath};
  });
  return {summary:text(plan.summary,10000),roles,tasks};
}

export function selectGrokModel(models, requested='') {
  const available=[...new Set(models.map(item=>typeof item==='string'?item:item?.id).filter(id=>typeof id==='string' && id.length<=150 && /^grok[-a-zA-Z0-9._]*$/.test(id) && !/image|vision-only|video|imagine|audio|voice|tts/.test(id)))];
  if(requested){if(!available.includes(requested))throw error('That Grok model is not available to this API key. Choose an available text model.');return requested;}
  const preferred=available.sort((a,b)=>{
    const score=id=>(/fast/.test(id)?4:0)+(/non-reasoning/.test(id)?2:0)+(/latest/.test(id)?1:0)-(/beta|preview/.test(id)?1:0);
    return score(b)-score(a)||b.localeCompare(a,undefined,{numeric:true});
  });
  if(!preferred.length)throw error('This API key has no available Grok text model.',403);
  return preferred[0];
}

export function createGrokManagement({store,home=process.env.AI_OFFICE_HOME || path.join(homedir(),'.ai-office'),env=process.env,fetchImpl=fetch,onChange=()=>{},requestTimeout=120000,intervalMs=2500}={}) {
  if(!store)throw new Error('A task store is required.');
  const credentialFile=path.join(home,'grok-credentials.json');
  let credentials=null,models=[],connected=false,lastError=null,active=null,timer=null,started=false,checking=null,connecting=false,initializing=false,generation=0,checkingController=null,connectController=null;
  const status=()=>({configured:Boolean(credentials?.apiKey),connected,model:credentials?.model||null,models:[...models],error:lastError,loading:Boolean(checking||connecting||initializing),agents:started&&active?[{id:`grok-management-${active.id}`,sessionId:active.id,name:'Grok management',agentType:'manager',agentRole:'Manager',isSubagent:false,observed:true,status:'working',cwd:active.projectPath||'',tool:'Planning roles and tasks',updatedAt:active.startedAt,provider:'Grok'}]:[],skills:[],updatedAt:new Date().toISOString()});
  const changed=()=>{try{onChange();}catch{}};
  async function readCredentials(){
    if(env.XAI_API_KEY || env.GROK_API_KEY){credentials={apiKey:env.XAI_API_KEY||env.GROK_API_KEY,model:env.GROK_MODEL||''};return;}
    try{
      const stat=await lstat(credentialFile);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)return;
      const saved=JSON.parse(await readFile(credentialFile,'utf8'));
      if(typeof saved.apiKey==='string' && saved.apiKey.length<1024)credentials={apiKey:saved.apiKey,model:text(saved.model,150)};
    }catch{}
  }
  async function request(endpoint,apiKey,body,signal){
    const response=await fetchImpl(`${API}${endpoint}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${apiKey}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal,redirect:'error'});
    if(!response.ok){
      const message=response.status===401?'The xAI API key was rejected. Check the key in your xAI account.':response.status===403?'This xAI key cannot access the selected model. Check its permissions and API billing.':response.status===429?'Grok is rate limited or API credits are unavailable. Check your xAI account, then retry.':'Grok could not complete the request. Try again later.';
      throw error(message,response.status===401||response.status===403?response.status:502);
    }
    // Never surface response error bodies: some upstreams echo request data.
    const raw=await response.text();
    if(raw.length>1024*1024)throw error('Grok returned an oversized response.',502);
    try{return JSON.parse(raw);}catch{throw error('Grok returned an unreadable response.',502);}
  }
  async function validateCredentials(candidate,signal=AbortSignal.timeout(15000)){
    const payload=await request('/models',candidate.apiKey,null,signal);
    const list=Array.isArray(payload.data)?payload.data:Array.isArray(payload.models)?payload.models:[];
    const model=selectGrokModel(list,candidate.model);
    return {model,models:list.map(item=>typeof item==='string'?item:item.id).filter(id=>typeof id==='string' && id.length<=150 && /^grok[-a-zA-Z0-9._]*$/.test(id))};
  }
  async function connect({apiKey,model}={}){
    if(active)throw error('Wait for Grok’s current instruction to finish before changing its connection.',409);
    if(connecting||checking||initializing)throw error('A Grok connection check is already in progress.',409);
    const key=typeof apiKey==='string'?apiKey.trim():credentials?.apiKey;
    if(!key || key.length>1024 || /[\s\x00-\x1f]/.test(key))throw error('Enter an xAI API key in the local connection field.');
    const candidate={apiKey:key,model:text(model,150)},controller=new AbortController(),epoch=generation;
    connecting=true;connectController=controller;changed();
    try{
      const verified=await validateCredentials(candidate,AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));
      if(controller.signal.aborted||epoch!==generation)throw error('The Grok connection check was interrupted.',409);
      await mkdir(home,{recursive:true,mode:0o700});
      const dir=await lstat(home);
      if(!dir.isDirectory()||dir.isSymbolicLink())throw error('The local credential directory is unavailable.',500);
      const temp=path.join(home,`.grok-${randomUUID()}.tmp`);
      try{await writeFile(temp,JSON.stringify({...candidate,model:verified.model}),{mode:0o600,flag:'wx'});await rename(temp,credentialFile);await chmod(credentialFile,0o600);}
      finally{await unlink(temp).catch(()=>{});}
      credentials={...candidate,model:verified.model};models=verified.models;connected=true;lastError=null;
    }finally{connecting=false;if(connectController===controller)connectController=null;changed();}
    kick();
    return status();
  }
  async function verifySaved(epoch){
    if(!credentials)return;
    const controller=new AbortController();checkingController=controller;
    try{const result=await validateCredentials(credentials,AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));if(epoch!==generation)return;credentials.model=result.model;models=result.models;connected=true;lastError=null;}
    catch(cause){if(epoch!==generation)return;connected=false;lastError=cause.status?cause.message:'Cannot reach Grok. Check the connection and retry.';}
    finally{if(checkingController===controller)checkingController=null;}
    changed();
  }
  async function processInstruction(instruction){
    const controller=new AbortController();
    const run={id:instruction.id,projectPath:instruction.projectPath,startedAt:new Date().toISOString(),controller},epoch=generation;
    active=run;
    store.updateInstruction(instruction.id,{status:'running',error:''});changed();
    const timeout=setTimeout(()=>controller.abort(),requestTimeout);
    try{
      const roles=store.snapshot().roles.map(role=>({name:role.name,description:role.description}));
      const body={model:credentials.model,store:false,max_output_tokens:8000,input:[
        {role:'system',content:GROK_COMMUNICATION_POLICY+'\n\nYou are the Grok management team for a local AI office. Follow the user instruction by defining useful management roles and turning the request into concrete, bounded implementation tasks for Claude Code or Codex. Use grok-bot only for tasks assigned to the external Grok Bot app; those cards wait for that bot to claim and execute them through the local office CLI/API, and the office runner never executes them. You are planning work, not executing it. Never claim implementation is complete. Do not create redundant tasks. Existing roles are context; only return new or updated roles. Return no more than 20 roles and 40 tasks. Use concise titles, clear acceptance criteria in descriptions, sensible priority, and the specified role/provider enums. If the request only creates roles, return an empty tasks list. Do not invent repository paths, credentials, capabilities or completed work. No tools or outside data are available.'},
        {role:'user',content:JSON.stringify({instruction:instruction.text,projectPath:instruction.projectPath||null,existingRoles:roles})},
      ],text:{format:{type:'json_schema',name:'office_management_plan',strict:true,schema:MANAGEMENT_SCHEMA}}};
      const response=await request('/responses',credentials.apiKey,body,controller.signal);
      if(response.status && response.status!=='completed')throw error('Grok did not finish the plan. No tasks were added; retry the instruction.',502);
      const output=(response.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
      let parsed;try{parsed=JSON.parse(output);}catch{throw error('Grok did not return a usable plan. No tasks were added.',502);}
      const plan=validateManagementPlan(parsed,instruction.projectPath||'');
      if(controller.signal.aborted)throw error('Grok planning was interrupted. Retry this instruction.',409);
      store.applyManagementPlan(instruction.id,plan);
    }catch(cause){
      const message=controller.signal.aborted?'Grok planning was interrupted or timed out. Retry this instruction.':cause.status?cause.message:'Could not finish Grok planning. No tasks were added. Retry this instruction.';
      try{store.updateInstruction(instruction.id,{status:'blocked',error:message});}catch{}
      if(epoch===generation&&(cause.status===401||cause.status===403)){connected=false;lastError=message;}
    }finally{clearTimeout(timeout);if(active===run)active=null;changed();}
  }
  async function tick(){
    if(!started||active||!connected||!credentials)return;
    const instruction=store.snapshot().instructions.find(item=>item.status==='pending');
    if(instruction)await processInstruction(instruction);
  }
  function kick(){if(started)void tick().catch(()=>{});}
  async function start(){
    if(started)return;started=true;const epoch=++generation;initializing=true;
    try{
    // A server restart does not mean interrupted planning completed.
    for(const item of store.snapshot().instructions.filter(item=>item.status==='running'))store.updateInstruction(item.id,{status:'blocked',error:'Office restarted during Grok planning. Retry this instruction.'});
    await readCredentials();if(!started||epoch!==generation)return;
    const pending=verifySaved(epoch);checking=pending;await pending;if(checking===pending)checking=null;
    if(!started||epoch!==generation)return;
    timer=setInterval(kick,intervalMs);timer.unref?.();kick();
    }finally{if(epoch===generation)initializing=false;}
  }
  function stop(){started=false;generation++;initializing=false;clearInterval(timer);timer=null;checkingController?.abort();connectController?.abort();active?.controller.abort();if(active){try{store.updateInstruction(active.id,{status:'blocked',error:'Grok planning was interrupted. Retry this instruction.'});}catch{}}changed();}
  return {start,stop,kick,status,connect};
}
