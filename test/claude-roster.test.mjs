import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeRoster, claudeWorkerIdentity, runningClaudeAgents, resolveClaudeSelection, claudeWorkerGroups, claudeAgentStatus } from '../src/claude-office.js';

const skills = [{id:'gamedev:godot-gdscript',name:'godot-gdscript',category:'godot'}, {id:'gamedev:save-systems',name:'save-systems',category:'disciplines'}, {id:'gamedev:gamedev-router',name:'gamedev-router',category:'router'}];
test('every Claude worker occupies exactly one specialist or runtime seat', () => {
  const agents = [{id:'main',name:'Claude session',status:'working'}, {id:'a',agentType:'ai-office-godot-gdscript',status:'working'}, {id:'b',skillId:'gamedev:godot-gdscript',status:'working'}, {id:'closed',status:'offline'}];
  const roster = buildClaudeRoster(skills, agents);
  assert.equal(roster.length,5);
  assert.equal(roster.flatMap(agent=>agent.runtimeAgents).length,3);
  assert.equal(roster.filter(agent=>agent.liveStatus==='working').length,3);
  assert.equal(new Set(roster.map(agent=>agent.index)).size,roster.length);
  assert.ok(roster.every(agent=>agent.floor===2));
});
test('skills have department homes and no invented working status', () => {
  const roster = buildClaudeRoster(skills);
  assert.deepEqual(roster.map(agent=>agent.index),[100,0,50]);
  assert.ok(roster.every(agent=>agent.liveStatus==='idle'));
});
test('a lost bridge clears visible working status without removing specialists', () => {
  const roster = buildClaudeRoster(skills,[{id:'a',skillId:'gamedev:godot-gdscript',status:'working'}],false);
  assert.equal(roster.length,3);
  assert.equal(roster.filter(agent=>agent.liveStatus==='working').length,0);
});
test('router keeps its specialist home after stopping', () => {
  const catalog = [{id:'gamedev:router',name:'router',category:'router'}];
  const roster = buildClaudeRoster(catalog,[{id:'router-worker',agentType:'ai-office-gamedev-router',status:'idle'}]);
  assert.equal(roster.length,1);
  assert.equal(roster[0].runtimeAgents[0].id,'router-worker');
});
test('new workers do not move existing seats and finished seats can be reused', () => {
  const seats = new Map();
  const b = {id:'b',status:'working'}, c = {id:'c',status:'idle'}, a = {id:'a',status:'working'};
  const first = buildClaudeRoster([], [b,c],true,seats);
  const second = buildClaudeRoster([], [a,b,c],true,seats);
  assert.equal(first.find(agent=>agent.id==='claude-live-b').index,second.find(agent=>agent.id==='claude-live-b').index);
  assert.equal(first.find(agent=>agent.id==='claude-live-c').index,second.find(agent=>agent.id==='claude-live-c').index);
  buildClaudeRoster([], [a,c],true,seats);
  const third = buildClaudeRoster([], [a,c,{id:'d',status:'working'}],true,seats);
  assert.equal(third.find(agent=>agent.id==='claude-live-d').index,150);
});
test('running filter excludes waiting, idle and offline workers', () => {
  const roster = buildClaudeRoster(skills,[{id:'a',status:'working',observed:true,executionState:'working'}, {id:'b',status:'waiting',observed:true,executionState:'waiting'}, {id:'c',status:'idle',observed:true,executionState:'idle'}, {id:'d',status:'offline',observed:true,executionState:'offline'}]);
  assert.deepEqual(runningClaudeAgents(roster).map(agent=>agent.runtimeAgents[0].id),['a']);
  assert.equal(runningClaudeAgents(buildClaudeRoster(skills,[{id:'a',status:'working',observed:true,executionState:'working'}],false)).length,0);
});
test('each observed worker appears in exactly one explicit status group', () => {
  const roster = buildClaudeRoster(skills,[{id:'a',status:'working',observed:true,executionState:'working'}, {id:'b',status:'idle',observed:true,executionState:'idle'}, {id:'c',status:'waiting',observed:true,executionState:'waiting'}]);
  const groups = claudeWorkerGroups(roster);
  assert.deepEqual(groups.running.map(agent=>agent.runtimeAgents[0].id),['a']);
  assert.deepEqual(groups.idle.map(agent=>agent.runtimeAgents[0].id),['b']);
  assert.deepEqual(groups.waiting.map(agent=>agent.runtimeAgents[0].id),['c']);
  assert.equal(Object.values(groups).flat().length,3);
  const finished = buildClaudeRoster(skills,[{id:'a',status:'idle',observed:true,executionState:'idle'}]);
  assert.equal(claudeWorkerGroups(finished).running.length,0);
  assert.equal(claudeWorkerGroups(finished).idle.length,1);
  assert.equal(claudeAgentStatus(resolveClaudeSelection([],roster.find(agent=>agent.runtimeAgents[0]?.id==='a'))).label,'Offline');
});
test('concurrent main sessions have distinguishable identities', () => {
  const a = claudeWorkerIdentity({id:'session-123456:main',sessionId:'session-123456',agentType:'main',cwd:'/projects/Walkalone'});
  const b = claudeWorkerIdentity({id:'session-789012:main',sessionId:'session-789012',agentType:'main'});
  assert.equal(a.shortId,'123456');
  assert.notEqual(a.shortId,b.shortId);
  assert.equal(a.project,'Walkalone');
});
test('open profile follows its worker into a skill seat and never switches workers', () => {
  const first = buildClaudeRoster(skills,[{id:'a',status:'working'}]);
  const selected = first.find(agent=>agent.runtimeAgents[0]?.id==='a');
  const moved = buildClaudeRoster(skills,[{id:'a',status:'working',skillId:'gamedev:godot-gdscript'}]);
  assert.equal(resolveClaudeSelection(moved,selected).id,'claude-skill-gamedev:godot-gdscript');
  const reused = buildClaudeRoster(skills,[{id:'b',status:'working'}]);
  const ended = resolveClaudeSelection(reused,selected);
  assert.equal(ended.liveStatus,'offline');
  assert.equal(ended.runtimeAgents[0].id,'a');
});
