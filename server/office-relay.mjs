import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { readProjectCatalog } from './project-catalog.mjs';
import { createGrokWake } from './grok-wake.mjs';
import { readGrokConversation } from './grok-conversation.mjs';

const reads = new Set(['/api/office/board', '/api/office/human-requests', '/api/office/work-reports', '/api/office/daily-reports', '/api/office/daily-reports/pending', '/api/grok/status', '/api/usage']);
const requestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function allowed(req) {
  try {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
    const host = new URL(`http://${req.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && (!req.headers.origin || new URL(req.headers.origin).origin === host.origin) && (!req.headers['sec-fetch-site'] || ['none','same-origin'].includes(req.headers['sec-fetch-site']));
  } catch { return false; }
}
async function body(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new Error('JSON required');
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=Buffer.byteLength(chunk); if (size>96*1024) throw new Error('Body too large'); chunks.push(Buffer.from(chunk)); }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid body');
  return value;
}

// User controls are opt-in. Worker, credential and Bot impersonation endpoints
// never pass through this local UI relay.
export function relayUserRouteAllowed(method, pathname) {
  if (method === 'PATCH') return pathname === '/api/office/settings' || /^\/api\/office\/tasks\/[^/]+$/.test(pathname);
  if (method !== 'POST') return false;
  return ['/api/office/tasks', '/api/office/tasks/card-actions', '/api/office/roles'].includes(pathname)
    || /^\/api\/office\/human-requests\/[^/]+\/(?:respond|rerequest)$/.test(pathname);
}
export function officeRelay({ upstream = 'http://127.0.0.1:5173', home = path.join(homedir(), '.ai-office'), fetchImpl = fetch, dispatchWake = null, userActions = false, conversationReader = readGrokConversation } = {}) {
  const target=new URL(upstream);
  if (target.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname) || target.username || target.password || target.pathname!=='/' || target.search || target.hash) throw new Error('Relay requires a local office origin.');
  const token=randomBytes(32).toString('base64url');
  const journalFile=path.join(home, 'dispatch-relay-requests.json');
  let journal={};
  try { journal=JSON.parse(readFileSync(journalFile,'utf8')); if (!journal || typeof journal!=='object' || Array.isArray(journal)) throw new Error(); }
  catch (error) { if (error.code!=='ENOENT') throw new Error('Dispatch relay journal is unreadable; refusing writes.'); }
  const save=()=>{mkdirSync(home,{recursive:true,mode:0o700}); const tmp=journalFile+'.tmp';writeFileSync(tmp,JSON.stringify(journal),{mode:0o600});renameSync(tmp,journalFile);};
  const upstreamFetch=(url,options={})=>fetchImpl(target.origin+url,{...options,signal:AbortSignal.timeout(15000)});
  async function liveBoard() {
    const response=await upstreamFetch('/api/office/board');
    if (!response.ok) throw new Error('Live office unavailable');
    const value=await response.json();
    return { value, writable:Boolean(value.csrfToken) && (!value.configuration || value.configuration.mode==='enabled') };
  }
  let wake = dispatchWake, timer, waking = null, stopped = false;
  function wakeFor(value) {
    wake ||= createGrokWake({ home, channel: 'instructions', commandInterface: value.runtime?.commandInterface || null, officeUrl: target.origin });
    return wake;
  }
  async function notifyInstructions(value) {
    // Newer offices own their notifier. Do not start a second sender in a view.
    if (stopped || value.dispatchSync || value.grok?.apiConnected || value.configuration && value.configuration.mode !== 'enabled') return;
    await wakeFor(value).notify(value.instructions || []);
  }
  function tick() {
    if (stopped || waking) return waking;
    waking = liveBoard().then(({ value, writable }) => writable && notifyInstructions(value)).catch(() => {}).finally(() => { waking = null; });
    return waking;
  }
  const middleware=async(req,res,next)=>{
    const url=req.url?.split('?')[0];
    if (!url?.startsWith('/api/')) return next();
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(value,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};
    if (!allowed(req)) return send({error:'Local same-origin access only.'},403);
    if (url === '/api/office/grok/conversation') {
      if (req.method !== 'GET') return send({ error: 'Conversation mirror is read-only.' }, 405);
      const query = new URL(req.url, 'http://localhost').searchParams;
      if ([...query.keys()].some(key => !['botId', 'cursor'].includes(key))) return send({ error: 'Invalid conversation request.' }, 400);
      return send(conversationReader({ botId: query.get('botId') || undefined, cursor: query.get('cursor') || undefined }));
    }
    const retry=/^\/api\/office\/instructions\/[a-zA-Z0-9-]+\/retry$/.test(url);
    if (req.method==='GET' && reads.has(url)) {
      try {
        if (url==='/api/office/board') {
          const {value,writable}=await liveBoard();
          const notification = wakeFor(value);
          value.dispatchSync ||= { source: 'office-queue', privateChatMirrored: false, checkedAt: new Date().toISOString(), botConnected: Boolean(value.grok?.bot?.connected), plannerConnected: Boolean(value.grok?.apiConnected), notification: notification.status(), delivery: notification.delivery(value.instructions || []) };
          value.projectCatalog=readProjectCatalog(home);
          value.configuration={...(value.configuration||{}),mode:'read-only',name:'AI Office'};
          value.capabilities={dispatchInstructions:writable,taskActions:userActions === true && writable,humanQuestions:userActions === true && writable,taskSettings:userActions === true && writable,roles:userActions === true && writable,grokWakeConfiguration:false};
          value.csrfToken=writable?token:'';
          delete value.csrf;
          return send(value);
        }
        const response=await upstreamFetch(url);return send(await response.json(),response.status);
      } catch {return send({error:'The live office is unavailable. Reconnect before submitting.'},503);}
    }
    const userRoute = userActions === true && relayUserRouteAllowed(req.method, url);
    const dispatchRoute = req.method === 'POST' && (url === '/api/office/instructions' || retry);
    if (!dispatchRoute && !userRoute) return send({error:'This operation is not enabled from this office view.'},403);
    const supplied=Buffer.from(String(req.headers['x-office-token']||'')), expected=Buffer.from(token);
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return send({error:'Refresh this view before submitting.'},403);
    let input;
    try {input=await body(req);}catch{return send({error:'Invalid office request.'},400);}
    if(dispatchRoute && !retry && (typeof input.text!=='string' || !input.text.trim() || input.text.length>20000 || typeof input.projectPath!=='string' || input.projectPath.length>2048 || !requestId.test(input.requestId||'')))return send({error:'A valid instruction, project folder and request ID are required.'},400);
    if (userRoute && url === '/api/office/settings' && (Object.keys(input).length !== 1 || typeof input.autoPickup !== 'boolean')) return send({error:'Only the automatic pickup setting can be changed here.'},400);
    const payload=userRoute?input:retry?{}:{text:input.text.trim(),projectPath:input.projectPath.trim(),requestId:input.requestId.toLowerCase()};
    const key=retry || userRoute?null:`${target.origin}:${payload.requestId}`;
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      const {value,writable}=await liveBoard();
      if(!writable)return send({error:'The live office is read-only. Changes cannot be sent.'},403);
      // After an uncertain response, never blindly repeat a legacy upstream POST.
      if(key && journal[key]){
        const previous=journal[key];
        if(previous.hash!==hash)return send({error:'This request ID belongs to different content.'},409);
        const instruction=(value.instructions||[]).find(item=>item.id===previous.id);
        if(instruction)return send({instruction},202);
        return send({error:'The prior submission has an unconfirmed result. Check the live dispatch history before sending another instruction.'},409);
      }
      if(key){journal[key]={hash,state:'sending',at:Date.now()};save();}
      const response=await upstreamFetch(url,{method:req.method,headers:{'Content-Type':'application/json','X-Office-Token':value.csrfToken},body:JSON.stringify(payload)});
      const result=await response.json();
      if(key){
        if(response.ok && result.instruction?.id)journal[key]={hash,id:result.instruction.id,state:'saved',at:Date.now()};
        else if(response.status>=400 && response.status<500)delete journal[key];
        save();
      }
      if(response.ok && result.instruction?.status === 'pending') void tick();
      return send(result,response.status);
    }catch{return send({error:'Submission could not be confirmed. Refresh the office and check the saved result before retrying; your draft is preserved.'},503);}
  };
  return {name:'ai-office-local-dispatch-relay',configureServer(server){server.middlewares.use(middleware);timer=setInterval(tick,15000);timer.unref?.();server.httpServer?.once('close',()=>{stopped=true;clearInterval(timer);wake?.stop();});}};
}
