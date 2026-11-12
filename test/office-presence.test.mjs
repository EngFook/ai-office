import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokBotPresence } from '../server/grok-bot-presence.mjs';
import { withTaskWorkers, buildSharedRoster } from '../src/unified-office.js';

test('Bot figures require observed local heartbeats and working status expires',()=>{
  let time=1000;const bot=createGrokBotPresence({now:()=>time,workingLeaseMs:60,connectionLeaseMs:600});
  assert.equal(bot.status().agents.length,0);
  bot.heartbeat({id:'chief',name:'Grok Bot',role:'Chief of staff',status:'working',activity:'Planning'});
  const roster=buildSharedRoster({grok:bot.status()});
  assert.equal(roster.length,1);assert.equal(roster[0].role,'Chief of staff');assert.equal(roster[0].liveStatus,'working');
  time+=61;assert.equal(bot.status().agents[0].status,'idle');
  time+=600;assert.equal(bot.status().connected,false);assert.equal(bot.status().agents.length,0);
  assert.throws(()=>bot.heartbeat({id:'bad id',name:'Bot',status:'working'}));
});

test('Task runner native session merges once and retains its assigned support role',()=>{
  const connection={connected:true,agents:[{id:'native-1',sessionId:'session-1',name:'Codex',status:'idle',isSubagent:false}]};
  const runtime={started:true,running:[{taskId:'actual-task',provider:'codex',sessionId:'session-1',workerId:'runner'}],agents:[{taskId:'actual-task',id:'session-1',sessionId:'session-1',provider:'Codex',status:'working',agentType:'office-task-runner',role:'Tester',isSubagent:false,observed:true}]};
  const merged=withTaskWorkers(connection,runtime,'Codex');
  assert.equal(merged.agents.length,1);assert.equal(merged.agents[0].id,'native-1');
  const roster=buildSharedRoster({codex:merged});assert.equal(roster[0].role,'Tester');assert.equal(roster[0].liveStatus,'working');
  assert.equal(connection.agents[0].status,'idle');
  assert.equal(withTaskWorkers(connection,runtime,'Claude Code'),connection);
});
