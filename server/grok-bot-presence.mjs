import { TaskBoardError } from './task-store.mjs';

const clean = (value,max) => typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g,'').slice(0,max) : '';
// Only explicit local Bot heartbeats establish presence. A configured role or a
// queued instruction is never treated as an active manager.
export function createGrokBotPresence({now=Date.now, workingLeaseMs=60000, connectionLeaseMs=10*60*1000}={}) {
  const bots=new Map();
  function heartbeat(input={}) {
    const id=clean(input.id,100),name=clean(input.name,100),role=clean(input.role,100)||'Manager';
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)||!name||!['idle','working'].includes(input.status))throw new TaskBoardError('Provide a bot id, name, and idle or working status.','INVALID_BOT',400);
    if(!bots.has(id)&&bots.size>=50)throw new TaskBoardError('The local Bot connection limit was reached.','BOT_LIMIT',409);
    const bot={id,name,role,status:input.status,activity:clean(input.activity,300),instructionId:clean(input.instructionId,100),lastSeen:now()};
    bots.set(id,bot);
    return {...bot,lastSeen:new Date(bot.lastSeen).toISOString()};
  }
  function status() {
    const current=now();
    const connected=[...bots.values()].filter(bot=>current-bot.lastSeen<connectionLeaseMs);
    const agents=connected.map(bot=>({id:`grok-bot-${bot.id}`,sessionId:bot.id,name:bot.name,agentType:'grok-bot',agentRole:bot.role,isSubagent:false,observed:true,provider:'Grok',status:bot.status==='working'&&current-bot.lastSeen<workingLeaseMs?'working':'idle',tool:bot.activity||null,updatedAt:new Date(bot.lastSeen).toISOString(),instructionId:bot.instructionId}));
    return {connected:connected.length>0,agents,lastSeen:connected.length?new Date(Math.max(...connected.map(bot=>bot.lastSeen))).toISOString():null};
  }
  return {heartbeat,status};
}
