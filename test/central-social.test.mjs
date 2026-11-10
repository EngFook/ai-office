import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedLayout } from '../src/shared-layout.js';
import { createMovement, deskSpot, loungeSpots } from '../src/movement.js';
import { RESIDENT_SPOTS } from '../src/office-resident-layout.js';

const layout = createSharedLayout();
const hit = (x, z, item, margin = .35) => Math.abs(x-item.x) < item.width/2+margin && Math.abs(z-item.z) < item.depth/2+margin;
const sample = (points, check) => {
  for(let i=1;i<points.length;i++) for(let t=0;t<=1;t+=.01) check(points[i-1][0]+(points[i][0]-points[i-1][0])*t, points[i-1][1]+(points[i][1]-points[i-1][1])*t);
};

test('central planting and task board stay clear of workers, residents and walking paths, including overflow', () => {
  const workers = ['Claude Code','Codex','Grok','Gemini','Local Qwen'].flatMap(provider => Array.from({length:provider==='Claude Code'?100:16},(_,i)=>({id:`${provider}-${i}`,provider,liveStatus:'working',runtimeAgents:[{status:'working',observed:true}]})));
  const busy = createSharedLayout(workers);
  const objects = [busy.centralSocial.planter,busy.centralSocial.board];
  for(const obj of objects) {
    assert.ok(Math.abs(obj.x-busy.bounds.x)+obj.width/2<busy.bounds.width/2);
    assert.ok(Math.abs(obj.z-busy.bounds.z)+obj.depth/2<busy.bounds.depth/2);
    for(const desk of busy.desks) assert.equal(hit(desk.chairX,desk.chairZ,obj),false);
    for(const resident of Object.values(RESIDENT_SPOTS)) assert.equal(hit(resident.x,resident.z,obj),false);
  }
  for(const spot of [...busy.desks.map(deskSpot),...loungeSpots(busy.lounge)]) sample([[spot.x,spot.z],...spot.path],(x,z)=>{
    for(const obj of objects) assert.equal(hit(x,z,obj),false,`${spot.id} walks through central furniture`);
  });
});

test('ambient figures visit and pause in the central space without inventing agent activity', () => {
  const movement=createMovement({lounge:layout.lounge,commons:layout.commons});
  movement.sync({now:0,initial:true});
  const visited=new Set();let pauses=0;
  for(let now=0;now<=480000;now+=250){
    for(const f of movement.step(now)){
      assert.equal(f.agent,null);
      if(f.spot?.id.startsWith('ambient:central:')&&!f.walking){visited.add(f.spot.id);pauses++;}
    }
  }
  assert.equal(visited.size,2);assert.ok(pauses>4,'people pause rather than only passing through');
});
