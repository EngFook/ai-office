import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedLayout, sharedFocusArea } from '../src/shared-layout.js';
import { buildSharedRoster, withTaskWorkers, workingOfficeAgents, resolveSharedSelection } from '../src/unified-office.js';
import { localQwenConnection, officeDepartmentFocus, roomProvider } from '../src/office-ui.js';
const worker = (id, status = 'working') => ({id, status, observed:true, isSubagent:false});

test('Qwen has a clickable two-seat department inside the rearranged compact footprint', () => {
  const l = createSharedLayout();
  const desks = l.desks.filter(d => d.zone === 'local-qwen');
  assert.equal(desks.length, 2);
  assert.equal(l.bounds.width, 82); assert.equal(l.bounds.depth, 81);
  const focus = officeDepartmentFocus(4);
  assert.equal(roomProvider(focus), 'Local Qwen');
  assert.equal(sharedFocusArea(focus,l).id, 'local-qwen');
  assert.equal(l.desks.filter(d => d.zone === 'gemini').length, 4);
});
test('connecting Qwen preserves existing providers and assigns only observed active workers', () => {
  const seats = new Map([['shared:claude:c',4],['shared:codex:x',5],['shared:grok:g',6],['shared:gemini:m',7]]);
  const states = {claude:{agents:[worker('c')]},codex:{agents:[worker('x')]},grok:{agents:[worker('g')]},gemini:{agents:[worker('m')]}};
  const before = buildSharedRoster(states,seats);
  states['local-qwen'] = {connected:true,agents:[worker('q'),worker('idle','idle'),{...worker('unobserved'),observed:false}]};
  const after = buildSharedRoster(states,seats);
  for(const a of before) assert.equal(after.find(b=>a.id===b.id).index,a.index);
  const q = after.find(a=>a.id==='shared:local-qwen:q');
  assert.equal(q.role,'Helper'); assert.equal(q.department,'Qwen Local Assistance');
  const layout = createSharedLayout(after);
  assert.equal(layout.placements.get(q.id).zone,'local-qwen');
  assert.equal(layout.desks.filter(d=>d.provider==='local-qwen'&&d.occupant).length,1);
  assert.equal(resolveSharedSelection(after,q).id,q.id);
});
test('offline, loaded and unavailable runtimes never become fabricated running agents', () => {
  assert.equal(localQwenConnection().pending,true);
  const runtime = {providers:{'local-qwen':{available:true,authenticated:true,loaded:true}},agents:[]};
  const ready = localQwenConnection(runtime);
  assert.equal(ready.connected,true);
  assert.deepEqual(buildSharedRoster({'local-qwen':ready}),[]);
  runtime.agents = [{...worker('live'),'provider':'Local Qwen',role:'Helper'}];
  const connection = withTaskWorkers(ready,runtime,'Local Qwen');
  assert.equal(workingOfficeAgents(buildSharedRoster({'local-qwen':connection})).length,1);
  const offline = {...connection,connected:false,metadataAvailable:false};
  assert.equal(workingOfficeAgents(buildSharedRoster({'local-qwen':offline})).length,0);
});
