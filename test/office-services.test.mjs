import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { officeServices } from '../server/office-services.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { QWEN_PREREQUISITE } from '../server/qwen-watch.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';
import { validateOfficeConfig } from '../server/office-config.mjs';
import { createConfiguredUsage } from '../server/usage-bridge.mjs';

async function eventually(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  assert.fail('The local service did not reach the expected state.');
}

test('Vite services start only when installed, aggregate explicit Bot presence and stop claims before closing storage', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-service-integration-'));
  const projectPath = path.join(home, 'project');
  await mkdir(projectPath);
  const children = [], signals = [];
  let probes = 0, apiCalls = 0, middleware;
  const plugin = officeServices({
    store: { home },
    grokWake: { env: {} },
    watch: { projectPath: home },
    runner: {
      pollIntervalMs: 10000,
      probeProviders: async () => { probes++; return { codex: { available: true, authenticated: true, path: '/mock/codex' }, claude: { available: false, authenticated: false } }; },
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 987654; child.exitCode = null; child.signalCode = null;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        children.push(child);
        return child;
      },
      terminate: (child, signal) => { signals.push({ pid: child.pid, signal }); child.exitCode = 143; child.emit('close', 143); },
      env: {},
    },
    grok: { home, env: {}, fetchImpl: async () => { apiCalls++; throw new Error('A test must never call a model API.'); } },
  });
  assert.equal(probes, 0, 'creating/importing the Vite plugin starts no workers');
  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  t.after(async () => {
    if (!closed) { await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); }
    await rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = 'GET', input, token) => {
    const response = await fetch(`${origin}${route}`, { method, headers: input ? { 'Content-Type': 'application/json', Origin: origin, 'X-Office-Token': token } : {}, ...(input ? { body: JSON.stringify(input) } : {}) });
    const body = await response.json();
    assert.ok(response.ok, body.error || route);
    return body;
  };
  const board = await eventually(async () => { const value = await request('/api/office/board'); return value.runtime.providers.codex.authenticated && value; });
  assert.ok(board.runtime.commandInterface.commands.includes('apply-plan'));
  assert.ok(board.runtime.commandInterface.commands.includes('bot-heartbeat'));
  assert.equal(board.grok.connected, false);
  assert.equal(board.grok.apiConnected, false);
  assert.equal(board.qwenWatch.phase, 'waiting');
  const token = board.csrfToken;
  await request('/api/office/grok/bot/heartbeat', 'POST', { id: 'fixture-bot', name: 'Fixture Bot', role: 'Manager', status: 'working', activity: 'Planning the fixture instruction.' }, token);
  const grok = await request('/api/grok/status');
  assert.equal(grok.connected, true);
  assert.equal(grok.apiConnected, false, 'a Bot heartbeat never implies API authentication');
  assert.equal(grok.agents.length, 1);
  assert.equal(grok.agents[0].id, 'grok-bot-fixture-bot');
  assert.equal(grok.agents[0].status, 'working');
  await request('/api/office/settings', 'PATCH', { autoPickup: true }, token);
  const created = await request('/api/office/tasks', 'POST', { title: 'Mock process task', projectPath, provider: 'codex' }, token);
  const active = await eventually(async () => { const value = await request('/api/office/board'); return value.runtime.running.length === 1 && value; });
  assert.equal(children.length, 1);
  assert.equal(active.tasks.find(task => task.id === created.task.id).status, 'running');
  assert.equal(active.runtime.agents.length, 0, 'a CLI spawn alone does not invent a native agent');
  assert.equal(apiCalls, 0);
  await new Promise(resolve => server.close(resolve));
  await plugin.closeBundle();
  closed = true;
  assert.deepEqual(signals, [{ pid: 987654, signal: 'SIGTERM' }]);
  const reopened = createTaskStore({ home });
  const task = reopened.snapshot().tasks.find(item => item.id === created.task.id);
  reopened.close();
  assert.equal(task.status, 'blocked');
  assert.match(task.error, /will not restart automatically/);
  assert.equal(apiCalls, 0);
});

test('watch is resident in office services without browser polling and stops before closing the store', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-watch-service-'));
  const seed = createTaskStore({ home });
  seed.updateSettings({ autoPickup: false });
  const prerequisite = seed.createTask({ title: 'Qwen ready', projectPath: home }, { id: QWEN_PREREQUISITE });
  seed.updateTask(prerequisite.id, { status: 'done' });
  const original = seed.createTask({ title: 'Blocked fixture', projectPath: home }); seed.updateTask(original.id, { status: 'blocked' });
  seed.close();
  let calls = 0, modelCalls = 0, middleware;
  const plugin = officeServices({ store: { home }, grokWake: { env: {} }, runner: { probeProviders: async () => ({}), env: {} }, grok: { home, env: {} }, watch: { projectPath: home, intervalMs: 15, usageReader: async () => { calls++; return { generatedAt: Date.now(), providers: [{ provider: 'Local Qwen', noQuota: true, todayTokens: 12345 }], quota: {} }; }, qwenClient: { run: async () => { modelCalls++; return 'fixture observation'; } } } });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  t.after(async () => { if (!closed) { await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); } await rm(home, { recursive: true, force: true }); });
  await eventually(() => calls >= 2); // no board/HTTP requests trigger these scans
  const board = await (await fetch(`http://127.0.0.1:${server.address().port}/api/office/board`)).json();
  assert.equal(board.qwenWatch.phase, 'attention'); assert.equal(board.qwenWatch.noQuota, true);
  assert.equal(board.tasks.filter(x => x.source === 'qwen-watch').length, 0);
  const report = JSON.parse(await readFile(path.join(home, 'reports/qwen-watch.json'), 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.current.usage['local-qwen'].todayTokens, 12345);
  assert.equal(report.current.usage['local-qwen'].quotaState, 'no-quota');
  assert.ok(JSON.stringify(report).includes(original.id));
  assert.equal(board.tasks.find(x => x.id === original.id).status, 'blocked');
  await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); closed = true;
  const stoppedAt = calls; await delay(40); assert.equal(calls, stoppedAt); assert.equal(modelCalls, 0, 'watch uses fresh deterministic facts without inference');
});

test('human questions are collected without a browser and wake acceptance never marks delivery', async t => {
  const { createGrokWake } = await import('../server/grok-wake.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'office-human-service-'));
  const seed = createTaskStore({ home, crossReview: false });
  const task = seed.createTask({ title: 'Approval fixture', projectPath: home, provider: 'codex' });
  const claim = seed.claimTask({ id: 'fixture', provider: 'codex', projectPath: home }, { taskId: task.id });
  seed.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Permission required to deploy.' });
  seed.updateSettings({ autoPickup: false }); seed.close();
  createGrokWake({ home, env: {} }).configure({ url: 'https://api2.cursor.sh/fixture-webhook', token: 'fixture-secret' });
  let calls = 0, middleware;
  const plugin = officeServices({ store: { home }, relayIntervalMs: 10,
    runner: { probeProviders: async () => ({}), env: {} }, grok: { home, env: {} },
    watch: { projectPath: home }, huddle: { qwenClient: { discussBlocked: async () => ({ suggestions: [] }) } },
    grokWake: { env: {}, fetchImpl: async () => { calls++; return new Response(null, { status: 204 }); } },
  });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); await rm(home, { recursive: true, force: true }); });
  await eventually(() => calls === 1); await delay(30);
  const board = await (await fetch(`http://127.0.0.1:${server.address().port}/api/office/board`)).json();
  assert.equal(calls, 1); assert.equal(board.humanRequests.length, 1);
  assert.equal(board.humanRequests[0].state, 'pending'); assert.equal(board.humanRequests[0].delivery, null);
  assert.equal(board.tasks.find(item => item.id === task.id).status, 'blocked');
  assert.equal(board.grokWake.configured, true); assert.ok(board.grokWake.lastSentAt);
  assert.ok(board.runtime.commandInterface.commands.includes('answer-question'));
  assert.ok(!JSON.stringify(board).includes('fixture-secret')); assert.ok(!JSON.stringify(board).includes('fixture-webhook'));
});

test('dispatch queue wakes Grok without API credentials, and only a real plan writeback becomes a reply', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-dispatch-service-'));
  const seed = createTaskStore({ home, crossReview: false });
  seed.updateSettings({ autoPickup: false }); seed.close();
  const events = []; let middleware;
  const plugin = officeServices({ store: { home }, relayIntervalMs: 10,
    runner: { probeProviders: async () => ({}), env: {} }, grok: { home, env: {} },
    watch: { projectPath: home }, huddle: { qwenClient: { discussBlocked: async () => ({ suggestions: [] }) } },
    grokWake: { env: {}, fetchImpl: async (_url, options) => { events.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } },
  });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); await rm(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async () => (await fetch(origin + '/api/office/board')).json();
  const initial = await read();
  assert.equal(initial.dispatchSync.notification.configured, false);
  const post = async (route, payload) => {
    const res = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': initial.csrfToken, Origin: origin }, body: JSON.stringify(payload) });
    assert.ok(res.ok); return res.json();
  };
  await post('/api/office/grok/wake/config', { url: 'https://api2.cursor.sh/fixture-dispatch', token: 'fixture-dispatch-secret' });
  assert.equal((await read()).dispatchSync.notification.configured, true);
  const { instruction } = await post('/api/office/instructions', { text: 'Prepare a plan only', projectPath: home });
  await eventually(() => events.length === 1);
  const queued = await read();
  assert.equal(events[0].event, 'office.instructions.pending'); assert.deepEqual(events[0].instructionIds, [instruction.id]);
  assert.equal(events[0].officeUrl, origin);
  assert.equal(queued.instructions[0].status, 'pending');
  assert.equal(queued.dispatchSync.delivery[instruction.id].state, 'accepted');
  assert.equal(queued.dispatchSync.botConnected, false);
  await post(`/api/office/instructions/${instruction.id}/apply-plan`, { summary: 'The bot actually wrote this plan', roles: [], tasks: [] });
  const replied = await read();
  assert.equal(replied.instructions[0].status, 'done');
  assert.equal(replied.instructions[0].summary, 'The bot actually wrote this plan');
  await delay(30); assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(replied).includes('fixture-dispatch-secret'));
});


test('configured services and usage share the actual local worker and preserve disabled providers', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-shared-qwen-'));
  const configuration = validateOfficeConfig({ mode: 'enabled', dataDir: home, workspace: home,
    providers: { 'local-qwen': { enabled: true } }, ollama: { model: 'fixture-qwen:9b' } });
  const seed = createTaskStore({ home });
  seed.updateSettings({ autoPickup: true, crossReview: false });
  const card = seed.createTask({ title: 'Outline supplied request', provider: 'local-qwen', supportType: 'task-breakdown', description: 'Make an accessible task list.' });
  seed.close();
  let release, calls = 0, inFlight = 0, maxInFlight = 0;
  const qwenClient = createLocalQwen({ model: 'fixture-qwen:9b', usageFile: path.join(home, 'qwen-usage.json'), fetchImpl: async (url, init) => {
    if (!url.endsWith('/api/chat')) return new Response(JSON.stringify({ models: [{ name: 'fixture-qwen:9b' }] }));
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      assert.equal(JSON.parse(init.body).model, 'fixture-qwen:9b');
      return await new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ done: true, message: { content: 'Draft tasks with acceptance checks.' } }))); });
    } finally { inFlight--; }
  } });
  let clock = Date.now();
  const usage = createConfiguredUsage(configuration, qwenClient, { now: () => clock });
  const foreignClient = { run() { throw new Error('Different client must not run.'); }, extractWorkReport() { throw new Error('Different client must not extract.'); } };
  const plugin = officeServices({ configuration, qwenClient,
    runner: { qwenClient: foreignClient, quotaReader: usage.quotaReader },
    watch: { prerequisiteIds: ['fixture-disabled-watch'] },
    workReports: { prerequisiteIds: ['fixture-disabled-reports'], qwenClient: foreignClient }, onStop: usage.stop,
  });
  let middleware;
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); await rm(home, { recursive: true, force: true }); });
  await eventually(() => calls === 1);
  const runningUsage = await usage.reader();
  assert.equal(runningUsage.providers.length, 1);
  assert.equal(runningUsage.providers[0].model, 'fixture-qwen:9b');
  assert.equal(runningUsage.providers[0].busy, true);
  assert.equal(runningUsage.providers[0].concurrency, 1);
  assert.equal(runningUsage.providers[0].contextTokens, 32768);
  await assert.rejects(qwenClient.extractWorkReport('[]'), /concurrency/);
  const readBoard = () => fetch(`http://127.0.0.1:${server.address().port}/api/office/board`).then(r => r.json());
  const activeBoard = await readBoard();
  assert.equal(activeBoard.tasks.find(item => item.id === card.id).status, 'running');
  assert.equal(activeBoard.grok.connected, false);
  for (const provider of ['claude', 'codex', 'gemini']) assert.equal(activeBoard.runtime.providers[provider].available, false);
  release();
  await eventually(async () => (await readBoard()).tasks.find(item => item.id === card.id).status === 'done');
  clock += 31000;
  assert.equal((await usage.reader()).providers[0].busy, false);
  assert.equal(calls, 1); assert.equal(maxInFlight, 1);
});


test('disabled local provider never consults an injected enabled client', async t => {
  const home=await mkdtemp(path.join(tmpdir(),'office-disabled-injected-qwen-'));
  const configuration=validateOfficeConfig({mode:'enabled',dataDir:home,workspace:home,providers:{'local-qwen':{enabled:false}},ollama:{model:'configured-disabled-model'}});
  let calls=0,middleware;
  const invoked=()=>{calls++;throw new Error('Disabled client must not be consulted.');};
  const injected={model:'injected-enabled-model',runtimeState:invoked,probe:invoked,run:invoked,extractWorkReport:invoked,discussBlocked:invoked};
  const plugin=officeServices({configuration,qwenClient:injected,runner:{qwenClient:injected}});
  const server=createServer((req,res)=>middleware(req,res,()=>{res.statusCode=404;res.end('{}');}));
  plugin.configureServer({httpServer:server,middlewares:{use(value){middleware=value;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await plugin.closeBundle();await rm(home,{recursive:true,force:true});});
  const board=await (await fetch(`http://127.0.0.1:${server.address().port}/api/office/board`)).json();
  assert.equal(board.runtime.providers['local-qwen'].available,false);
  assert.equal(board.runtime.providers['local-qwen'].model,'configured-disabled-model');
  assert.equal(board.runtime.providers['local-qwen'].busy,false);
  assert.equal(board.qwenWatch.phase,'stopped');
  assert.equal(calls,0);
});

test('continuous duty and huddle start while report inference is still pending', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-independent-duty-'));
  const seed = createTaskStore({ home, crossReview: false });
  seed.updateSettings({ autoPickup: false });
  const done = seed.createTask({ title: 'Completed fixture', projectPath: home, provider: 'codex' });
  const doneClaim = seed.claimTask({ id: 'done-worker', provider: 'codex', projectPath: home }, { taskId: done.id });
  seed.finishTask(done.id, doneClaim.claimToken, { status: 'done', result: 'Completed actual fixture result.' });
  const blocked = seed.createTask({ title: 'Blocked fixture', projectPath: home, provider: 'codex' });
  seed.updateTask(blocked.id, { status: 'blocked' });
  seed.close();
  let release, middleware, modelCalls = 0;
  const qwenClient = { extractWorkReport: () => { modelCalls++; return new Promise(resolve => { release = () => resolve({ entries: [{ id: done.id, quoteIndex: 0, fileIndices: [] }] }); }); }, discussBlocked: () => assert.fail('autoPickup paused must not dispatch or discuss candidates') };
  const plugin = officeServices({ store: { home }, grokWake: { env: {} }, runner: { probeProviders: async () => ({ 'local-qwen': { available: true, authenticated: true } }), env: {} }, grok: { home, env: {} },
    watch: { projectPath: home, prerequisiteIds: [] }, workReports: { projectPath: home, prerequisiteIds: [], qwenClient }, huddle: { qwenClient }, duty: { intervalMs: 15 } });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); await new Promise(resolve => server.close(resolve)); await plugin.closeBundle(); await rm(home, { recursive: true, force: true }); });
  await eventually(() => modelCalls === 1);
  const read = () => fetch(`http://127.0.0.1:${server.address().port}/api/office/board`).then(response => response.json());
  const board = await eventually(async () => { const value = await read(); return value.qwenWatch.duty.checks >= 2 && value.huddle.lastCheckedAt && value; });
  assert.equal(board.qwenWatch.duty.started, true); assert.ok(board.qwenWatch.duty.heartbeatAt);
  assert.equal(board.qwenWatch.duty.phase, 'working'); assert.equal(board.workReportsSummary.phase, 'generating');
  assert.equal(board.tasks.find(task => task.id === blocked.id).status, 'blocked');
  assert.equal(board.runtime.running.length, 0); assert.equal(modelCalls, 1);
  release(); await eventually(async () => (await read()).workReportsSummary.phase === 'ready');
});
