import test from 'node:test';
import assert from 'node:assert/strict';
import { officeOperations, officeSnapshotStale, operationsHeadline } from '../src/office-operations.js';
import { createGrokBotPresence } from '../server/grok-bot-presence.mjs';

const person = (id, state = 'working') => ({ id, provider:'Codex', runtimeAgents:[{ id, observed:true, status:'working', executionState:state }] });
test('native activity and claimed cards have separate counts, with no task-to-person double count', () => {
  const model = officeOperations({ roster:[person('a'),person('b'),person('c','unconfirmed')], tasks:[{id:'task',status:'running'}], runtime:{started:true,running:[{taskId:'task',workerId:'a'},{taskId:'task',workerId:'a'}]}, autoPickup:true });
  assert.equal(model.execution.confirmed,2);
  assert.equal(model.execution.recorded,1);
  assert.equal(model.claimed.length,1);
  assert.match(operationsHeadline(model),/2 位代理运行.*1 位状态待确认.*任务板 1 项执行/);
  assert.equal(officeOperations({ roster:[person('a')], runtime:{started:true}, autoPickup:true }).claimed.length,0);
});
test('stale board claims become unverified without suppressing native evidence', () => {
  const model = officeOperations({ roster:[person('native')], tasks:[{id:'task',status:'running'}], runtime:{started:true,running:[{taskId:'task'}]}, stale:true, autoPickup:true });
  assert.equal(model.execution.confirmed,1);
  assert.equal(model.claimed.length,0);
  assert.equal(model.unverifiedClaims.length,1);
  assert.equal(model.queueState,'unavailable');
  assert.match(operationsHeadline(model),/连接待恢复/);
});
test('only current bound questions are counted and missing workers are not counted as executing', () => {
  const model = officeOperations({tasks:[{id:'blocked',status:'blocked',humanGate:{requestId:'current'},resolution:{owner:'local-qwen',state:'needs_user'}},{id:'orphan',status:'running'}],humanRequests:[{id:'old',taskId:'blocked',state:'delivered'},{id:'current',taskId:'blocked',state:'pending',kind:'approval'}],runtime:{started:true},autoPickup:true});
  assert.equal(model.questions.length,1);
  assert.equal(model.blocked.needsUser,1);
  assert.equal(model.blocked.investigating,0);
  assert.equal(model.unverifiedClaims.length,1);
});
test('connection freshness ignores mutation failures and expires even without a network response', () => {
  assert.equal(officeSnapshotStale({lastSuccessAt:10000,error:'A rejected mutation'},15000),false);
  assert.equal(officeSnapshotStale({lastSuccessAt:10000,refreshError:'Disconnected'},15000),true);
  assert.equal(officeSnapshotStale({lastSuccessAt:10000},40001),true);
  assert.equal(officeSnapshotStale({lastSuccessAt:null},10000),true);
  assert.equal(officeSnapshotStale({lastSuccessAt:30000},10000),true);
});
test('queue health respects stopped runner and manual pickup independently of available agents', () => {
  assert.equal(officeOperations({runtime:{started:false},autoPickup:true}).queueState,'stopped');
  assert.equal(officeOperations({runtime:{started:true},autoPickup:false}).queueState,'paused');
  assert.equal(officeOperations({runtime:{started:true},autoPickup:true,tasks:[{id:'q',status:'pending'}]}).queueState,'queued');
});
test('Grok heartbeat execution evidence expires without fabricating an idle confirmation', () => {
  let now=100000;
  const bots=createGrokBotPresence({now:()=>now});
  bots.heartbeat({id:'manager',name:'Manager',status:'working',activity:'Planning'});
  assert.equal(bots.status().agents[0].executionState,'working');
  assert.equal(bots.status().agents[0].observationSource,'grok-bot-heartbeat');
  now+=61000;
  assert.equal(bots.status().agents[0].executionState,'unconfirmed');
  assert.equal(bots.status().agents[0].tool,null);
  bots.heartbeat({id:'manager',name:'Manager',status:'idle'});
  assert.equal(bots.status().agents[0].executionState,'idle');
});

test('first load is identified without claiming a disconnected previous snapshot', () => {
  const model = officeOperations({stale:true,loading:true});
  assert.equal(model.queueState,'loading');
  assert.match(operationsHeadline(model),/正在读取任务板/);
  assert.equal(officeOperations({stale:true,loading:false}).queueState,'unavailable');
});

test('stopped and completed runner records never count as active claims', () => {
  const tasks=[{id:'a',status:'running'}];
  for (const runtime of [{running:[{taskId:'a'}]},{started:false,running:[{taskId:'a'}]},{started:true,running:[{taskId:'a',status:'done'}]},{started:true,running:[{taskId:'a',finished:true}]}]) {
    assert.equal(officeOperations({tasks,runtime}).claimed.length,0);
  }
  assert.equal(officeOperations({tasks,runtime:{started:true,running:[{taskId:'a',status:'running'}]}}).claimed.length,1);
});


test('provider operations summary separates interrupted executions from ordinary waiting', async () => {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { buildSharedRoster } = await import('../src/unified-office.js');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { default: OfficeOperations } = await server.ssrLoadModule('/src/OfficeOperations.jsx');
    const actor = (id, extra = {}) => ({ id, observed: true, status: 'waiting', executionState: 'waiting', lastEvent: 'StopFailure', ...extra });
    const render = (agents, lang = 'zh') => {
      const claude = { connected: true, agents };
      const roster = buildSharedRoster({ claude });
      const model = officeOperations({ roster, runtime: { started: true }, autoPickup: true });
      const board = { state: { runtime: {}, tasks: [] }, stale: false };
      return renderToStaticMarkup(React.createElement(OfficeOperations, { model, board, roster, claude, lang }));
    };
    const interrupted = [actor('a'), actor('b'), actor('c')];
    assert.match(render(interrupted), /3 位执行中断/);
    assert.match(render(interrupted, 'en'), /3 interrupted/);
    const mixed = [actor('a'), actor('b', { lastEvent: 'Notification' }), actor('c', { lastEvent: 'Notification' })];
    assert.match(render(mixed), /2 位等待 · 1 位中断/);
    assert.match(render(mixed, 'en'), /2 waiting · 1 interrupted/);
    assert.match(render([actor('a', { lastEvent: 'Notification' })]), /1 位等待/);
    assert.doesNotMatch(render(interrupted), /等输入|awaiting input/);
    assert.doesNotMatch(render([actor('unknown', { executionState: 'unconfirmed' })]), /1 位执行中断/);
    assert.match(render([actor('unknown', { executionState: 'unconfirmed' })]), /1 位待确认/);
  } finally { await server.close(); }
});
