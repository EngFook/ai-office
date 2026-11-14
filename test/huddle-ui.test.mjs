import test from 'node:test'
import assert from 'node:assert/strict'
import { createMovement, huddleSpot, route, loungeSpots } from '../src/movement.js'
import { createSharedLayout } from '../src/shared-layout.js'
import { filterBoardTasks } from '../src/task-board-ui.js'
import { huddlePhaseLabel, huddleQuotaLabel, blockedOwnership, resolutionStateLabel, huddleActionLabel } from '../src/huddle-ui.js'

const layout = createSharedLayout([])
const make = () => createMovement({ lounge: layout.lounge, commons: layout.commons })
const attendees = ['local-qwen','claude','codex','gemini','grok']

test('blocked-only requests exclude pending, running and done without changing ordinary task views', () => {
  const tasks = ['pending','running','blocked','done'].flatMap(status => ['claude','codex'].map(provider => ({ id: `${status}:${provider}`, status, provider, projectPath: '/tmp/aio-example' })))
  assert.equal(filterBoardTasks(tasks).length, 8)
  assert.deepEqual(filterBoardTasks(tasks, { status: 'blocked' }).map(t => t.id), ['blocked:claude','blocked:codex'])
  assert.deepEqual(filterBoardTasks(tasks, { status: 'blocked', provider: 'claude', projectPath: '/tmp/aio-example' }).map(t=>t.id), ['blocked:claude'])
  assert.deepEqual(filterBoardTasks(tasks, { status:'blocked', projectPath:'/tmp/aio-other' }), [])
})

test('Qwen huddle brings idle delegates to board while actual work stays at desks, then releases them', () => {
  const movement = make()
  const working = layout.desks.slice(0, 20).map(desk => ({id:`worker:${desk.id}`, provider:desk.provider, desk, agent:{ id:desk.id }}))
  movement.sync({ working, initial: true, now: 0 })
  const before = new Map([...movement.figures.values()].filter(f=>f.agent).map(f=>[f.id,[f.x,f.z]]))
  movement.sync({ working, huddle: {active:true,attendees}, now:1000 })
  for(let now=1000;now<90000;now+=250) movement.step(now)
  const delegates = [...movement.figures.values()].filter(f=>f.rep)
  assert.equal(delegates.length,5)
  for(const fig of delegates) { assert.equal(fig.agent,null);assert.equal(fig.spot.kind,'huddle');assert.equal(fig.sitting,false) }
  for(const fig of movement.figures.values()) if(fig.agent) {assert.deepEqual([fig.x,fig.z],before.get(fig.id));assert.equal(fig.spot.id,`desk:${working.find(w=>w.id===fig.id).desk.id}`)}
  movement.sync({working,huddle:{active:false,attendees},now:90000})
  assert.equal([...movement.figures.values()].filter(f=>f.rep).length,0)
  for(let now=90000;now<180000;now+=250) movement.step(now)
  assert.equal([...movement.figures.values()].filter(f=>f.spot.kind==='huddle').length,0)
})

test('manual meetings take priority and huddles resume afterwards without teleporting', () => {
  const movement=make(),huddle={active:true,attendees:['local-qwen','claude']}
  movement.sync({initial:true,huddle,now:0})
  movement.step(3000)
  const rep=[...movement.figures.values()].find(f=>f.rep==='claude'),pos=[rep.x,rep.z]
  movement.sync({huddle,meeting:{active:true,attendees:['claude']},now:3000})
  assert.deepEqual([rep.x,rep.z],pos)
  assert.equal(rep.walk.to.kind,'meeting')
  for(let now=3250;now<=90000;now+=250)movement.step(now)
  assert.equal(rep.spot.kind,'meeting')
  movement.sync({huddle,now:90000})
  assert.equal(rep.walk.to.kind,'huddle')
})

test('all delegate approach routes clear central island and bulletin board', () => {
  for(const from of loungeSpots(layout.lounge)) for(let index=0;index<5;index++) {
    const points=route(from,huddleSpot(index))
    for(let j=1;j<points.length;j++) for(let t=0;t<=1;t+=.01) {
      const x=points[j-1][0]+(points[j][0]-points[j-1][0])*t,z=points[j-1][1]+(points[j][1]-points[j-1][1])*t
      for(const item of [layout.centralSocial.planter,layout.centralSocial.board]) assert.ok(Math.abs(x-item.x)>=item.width/2+.35||Math.abs(z-item.z)>=item.depth/2+.35)
    }
  }
})

test('missing quota stays unknown and missing huddle state never claims live model work', () => {
  for(const value of [undefined,null,'50',-1,101,NaN])assert.equal(huddleQuotaLabel(value),'Quota unknown')
  assert.equal(huddleQuotaLabel(0),'0% quota remaining')
  assert.equal(huddleQuotaLabel(85.7),'86% quota remaining')
  assert.equal(huddlePhaseLabel(undefined),'Huddle checks not enabled')
  assert.equal(huddlePhaseLabel({enabled:true,phase:'discussing'}),'Qwen is analysing')
})


test('ownership retains all blocked requests independently of rotating decision batches', () => {
  const tasks = Array.from({ length: 42 }, (_, i) => ({ id: `blocked-${i}`, title: `Task ${i}`, status: 'blocked', resolution: i ? { owner: i % 2 ? 'codex' : 'claude', state: 'waiting_capacity', nextAction: 'Recheck quota', nextCheckAt: '2026-11-04T10:05:00Z', investigationTaskId: `investigation-${i}` } : undefined }))
  const rows = blockedOwnership([...tasks, { id: 'done', status: 'done' }, { id: 'running', status: 'running' }])
  assert.equal(rows.length, 42)
  assert.equal(rows[0].owner, null)
  assert.equal(rows[0].state, null)
  assert.equal(rows[41].taskId, 'blocked-41')
  assert.equal(rows[41].investigationTaskId, 'investigation-41')
  assert.equal(rows[41].nextCheckAt, '2026-11-04T10:05:00Z')
  assert.equal(rows[41].nextAction, 'Recheck quota')
})

test('resolution labels distinguish queued ownership, active investigation and user action', () => {
  assert.equal(resolutionStateLabel('queued'), 'Queued for action')
  assert.equal(resolutionStateLabel('investigating'), 'Investigating')
  assert.equal(resolutionStateLabel('needs_user', true), '需要你补充或确认')
  assert.equal(resolutionStateLabel('waiting_capacity'), 'Waiting for quota or capacity')
  assert.equal(resolutionStateLabel(undefined), 'Awaiting an owner')
  assert.equal(huddleActionLabel('investigate', true), '已安排排查')
  assert.equal(huddleActionLabel('follow_up'), 'Owner follow-up')
  assert.equal(huddleActionLabel('dispatch'), 'Assignment submitted')
})

test('huddle execution distinguishes queued work, stopped runner, actual execution and diagnosis completion', async () => {
  const { huddleTaskProgress } = await import('../src/huddle-ui.js');
  const parent = { id: 'original', status: 'blocked', resolution: { investigationTaskId: 'investigation', nextAction: 'Apply the diagnosed repair.' } };
  const investigator = { id: 'investigation', status: 'pending' };
  let result = huddleTaskProgress(parent.id, [parent, investigator], { started: false }, {}, true);
  assert.equal(result.status, 'pending'); assert.match(result.label, /未开始/); assert.match(result.detail, /执行器已停止/);
  result = huddleTaskProgress(parent.id, [parent, investigator], { started: true, pending: [{ taskId: investigator.id, reason: 'Project lock is busy.' }] });
  assert.equal(result.detail, 'Project lock is busy.');
  result = huddleTaskProgress(parent.id, [parent, { ...investigator, status: 'running' }]);
  assert.equal(result.status, 'unconfirmed');
  result = huddleTaskProgress(parent.id, [parent, { ...investigator, status: 'running' }], { started: true, running: [{ taskId: investigator.id, provider: 'codex' }] });
  assert.equal(result.label, 'Investigation running');
  result = huddleTaskProgress(parent.id, [parent, { ...investigator, status: 'done' }]);
  assert.match(result.label, /original task remains/); assert.equal(result.detail, parent.resolution.nextAction);
  result = huddleTaskProgress('recovery', [{ id: 'recovery', status: 'pending', huddleRetry: { active: true } }], {}, { autoPickup: false });
  assert.match(result.detail, /pickup is paused/);
  assert.equal(huddleTaskProgress('missing', []).status, 'missing');
  assert.equal(huddleTaskProgress(parent.id, [{ ...parent, humanGate: { state: 'denied' } }, { ...investigator, status: 'running' }]).status, 'paused');
  assert.equal(resolutionStateLabel('user_denied', true), '用户已拒绝 · 保持暂停');
  assert.equal(resolutionStateLabel('awaiting_capacity'), 'Waiting for quota or capacity');
});
