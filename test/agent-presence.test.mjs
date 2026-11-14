import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPresence } from '../server/agent-presence.mjs';
import { buildSharedRoster, withTaskWorkers, workingOfficeAgents, resolveSharedSelection } from '../src/unified-office.js';
import { createSharedLayout } from '../src/shared-layout.js';
import { crowdCapacity } from '../src/crowd-capacity.js';
import { reconstructAgents, readLifecycleEvents } from '../server/claude-bridge.mjs';
import { readThreadMetadata } from '../server/codex-bridge.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const child = (id, provider = 'gemini') => ({ id, provider, sessionId: 'session', parentAgentId: 'parent', isSubagent: true, status: 'working', name: id });

test('cached Claude metadata observes updates and deletion without retaining private payloads', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'office-events-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const cache=new Map(), file=path.join(directory,'child.json');
  writeFileSync(file,JSON.stringify({event:'SubagentStart',sessionId:'s',agentId:'child',timestamp:1000,prompt:'PRIVATE'}));
  assert.equal((await readLifecycleEvents(directory,cache))[0].event,'SubagentStart');
  assert.equal(JSON.stringify([...cache.values()]).includes('PRIVATE'),false);
  writeFileSync(file,JSON.stringify({event:'SubagentStop',sessionId:'s',agentId:'child',timestamp:2000}));
  assert.equal((await readLifecycleEvents(directory,cache))[0].event,'SubagentStop');
  symlinkSync(file,path.join(directory,'linked.json'));
  assert.equal((await readLifecycleEvents(directory,cache)).length,1);
  unlinkSync(file);
  assert.deepEqual(await readLifecycleEvents(directory,cache),[]);
  assert.equal(cache.size,0);
});

test('each provider child remains independently visible, clickable and seated above the old 160-person limit', () => {
  const presence = createAgentPresence();
  for (const provider of ['claude','codex','gemini','local-qwen','grok-bot']) for (let n = 0; n < 60; n++) presence.heartbeat(child(`child-${n}`, provider));
  const runtime = { agents: presence.agents() }, states = {};
  for (const [key, label] of [['claude','Claude Code'],['codex','Codex'],['gemini','Gemini'],['local-qwen','Local Qwen'],['grok','Grok']]) states[key] = withTaskWorkers({}, runtime, label);
  const roster = buildSharedRoster(states), working = workingOfficeAgents(roster), layout = createSharedLayout(working);
  assert.equal(working.length, 300); assert.equal(layout.agents.length, 300);
  assert.equal(new Set(layout.desks.filter(d => d.occupant).map(d => d.occupant.id)).size, 300);
  for (const actor of working) assert.equal(resolveSharedSelection(roster, actor).runtimeAgents[0].parentAgentId, 'parent');
  assert.ok(crowdCapacity(working.length + 15) >= 315);
  assert.equal(crowdCapacity(10, 384), 384);
});

test('children sharing their parent session never replace the parent or a sibling', () => {
  const connection = { agents: [{id:'parent',sessionId:'session',isSubagent:false,status:'working'}] };
  const presence = createAgentPresence(); presence.heartbeat(child('a')); presence.heartbeat(child('b'));
  const merged = withTaskWorkers(connection, {agents:presence.agents()}, 'Gemini');
  assert.deepEqual(merged.agents.map(a=>a.id), ['parent','a','b']);
  assert.equal(withTaskWorkers(merged, {agents:presence.agents()}, 'Gemini').agents.length, 3);
});

test('expired heartbeats cannot revive unavailable native metadata or downgrade a live native actor', () => {
  const native={id:'native',sessionId:'s',status:'working',executionState:'working',observed:true,isSubagent:false};
  const external={id:'expired',provider:'Codex',sessionId:'other',status:'offline',source:'local-agent-heartbeat',observed:true};
  const lost=withTaskWorkers({agents:[native],connected:false,error:'disconnected'},{agents:[external]},'Codex');
  assert.equal(workingOfficeAgents(buildSharedRoster({codex:lost})).length,0);
  const live=withTaskWorkers({agents:[native],connected:true},{agents:[{...external,id:'native',sessionId:'s'}]},'Codex');
  assert.equal(workingOfficeAgents(buildSharedRoster({codex:live})).length,1);
});

test('idle, completed and expired agents leave the working floor; private fields never enter the payload', () => {
  let now = 100000; const presence = createAgentPresence({now:()=>now,leaseMs:60,retentionMs:120,limit:2});
  presence.heartbeat({...child('a'),prompt:'PRIVATE',apiKey:'PRIVATE',result:'PRIVATE'});
  assert.equal(JSON.stringify(presence.agents()).includes('PRIVATE'), false);
  presence.heartbeat({...child('a'),status:'idle'}); assert.equal(presence.agents()[0].status,'idle');
  presence.heartbeat({...child('a'),status:'offline'}); assert.equal(presence.agents()[0].status,'offline');
  presence.heartbeat(child('b')); now += 61; assert.ok(presence.agents().every(a=>a.status==='offline'));
  now += 60; assert.deepEqual(presence.agents(),[]);
  assert.throws(()=>presence.heartbeat({...child('c'),parentAgentId:'c'}), /distinct/);
  presence.heartbeat(child('c')); assert.throws(()=>presence.heartbeat({...child('c'),sessionId:'other'}), /identity changed/);
});

test('Claude lifecycle includes all concurrent children and preserves their parent on completion', () => {
  const events=[{event:'SessionStart',sessionId:'s',timestamp:1000}];
  for(let i=0;i<110;i++)events.push({event:'SubagentStart',sessionId:'s',agentId:`child-${i}`,timestamp:1001+i});
  events.push({event:'SubagentStop',sessionId:'s',agentId:'child-1',timestamp:2000});
  const actors=reconstructAgents(events);
  assert.equal(actors.filter(a=>a.isSubagent).length,110);
  assert.equal(actors.filter(a=>a.isSubagent&&a.status==='working').length,109);
  assert.equal(actors.find(a=>a.id==='s:child-1').parentAgentId,'s:main');
});

test('Codex metadata includes every loaded identity even outside recent history and the former 256 cap', t => {
  const directory=mkdtempSync(path.join(tmpdir(),'office-many-agents-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const db=new DatabaseSync(path.join(directory,'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER)');
  const insert=db.prepare('INSERT INTO threads VALUES (?, ?)');
  const ids=Array.from({length:300},(_,i)=>`loaded-${i}`);
  for(const id of ids) insert.run(id,1);
  for(let i=0;i<128;i++) insert.run(`recent-${i}`,10000+i);
  db.close();
  const rows=readThreadMetadata(directory,ids);
  assert.ok(ids.every(id=>rows.some(row=>row.id===id)));
});


test('leased presence explicitly reports execution evidence and revokes it when the lease ends', () => {
  let now = 1000;
  const presence = createAgentPresence({ now: () => now, leaseMs: 60, retentionMs: 200 });
  presence.heartbeat(child('actual', 'gemini'));
  const live = presence.agents()[0];
  assert.equal(live.observed, true);
  assert.equal(live.executionState, 'working');
  assert.equal(live.observationSource, 'local-agent-heartbeat');
  assert.equal(workingOfficeAgents(buildSharedRoster({ gemini: withTaskWorkers({}, { agents: presence.agents() }, 'Gemini') })).length, 1);
  now += 61;
  const expired = presence.agents()[0];
  assert.equal(expired.status, 'offline');
  assert.equal(expired.executionState, 'offline');
  assert.equal(expired.tool, null);
  assert.equal(workingOfficeAgents(buildSharedRoster({ gemini: withTaskWorkers({}, { agents: presence.agents() }, 'Gemini') })).length, 0);
});
