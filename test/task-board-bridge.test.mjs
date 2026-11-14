import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';
import { createAgentPresence } from '../server/agent-presence.mjs';

async function fixture(t, callbacks = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-board-http-'));
  await mkdir(path.join(home, 'project'));
  const store = createTaskStore({ home });
  t.after(() => store.close()); t.after(() => rm(home, { recursive: true, force: true }));
  let middleware;
  taskBoardBridge({ store, ...callbacks }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const request = async (url, { method = 'GET', input, headers = {}, address = '127.0.0.1', raw } = {}) => {
    const stream = Readable.from(raw == null ? input == null ? [] : [Buffer.from(JSON.stringify(input))] : [Buffer.from(raw)]);
    Object.assign(stream, { url, method, headers: { host: '127.0.0.1:5173', ...(input != null || raw != null ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: address } });
    let content; const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { content = value; } };
    await middleware(stream, response, () => assert.fail('Expected board route'));
    return { status: response.statusCode, body: JSON.parse(content), headers: response.headers };
  };
  const board = await request('/api/office/board');
  const tokenHeaders = { 'x-office-token': board.body.csrfToken };
  return { store, request, tokenHeaders, projectPath: path.join(home, 'project') };
}

test('agent lifecycle transport requires CSRF, enabled provider and writable mode without claiming tasks', async t => {
  const presence = createAgentPresence();
  const f = await fixture(t, { enabledProviders: ['gemini'], onAgentHeartbeat: presence.heartbeat });
  const input = { id: 'child-1', sessionId: 'session-1', parentAgentId: 'root', provider: 'gemini', isSubagent: true, status: 'working' };
  const endpoint = '/api/office/agents/heartbeat';
  assert.equal((await f.request(endpoint, { method:'POST', input })).status,403);
  assert.equal((await f.request(endpoint, { method:'POST', input:{...input,provider:'codex'}, headers:f.tokenHeaders })).status,403);
  assert.equal((await f.request(endpoint, { method:'POST', input, headers:f.tokenHeaders })).status,200);
  assert.equal(presence.agents().length,1);
  assert.equal(f.store.snapshot().tasks.length,0);
  const paused = await fixture(t, { readOnly:true, onAgentHeartbeat:presence.heartbeat });
  assert.equal((await paused.request(endpoint, {method:'POST',input,headers:paused.tokenHeaders})).status,403);
});

test('same-origin loopback plus CSRF token and bounded JSON are required for mutations', async t => {
  const { request, tokenHeaders } = await fixture(t);
  assert.equal((await request('/api/office/board', { address: '10.0.0.1' })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request('/api/office/board', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'No token' } })).status, 403);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'Wrong content' }, headers: { ...tokenHeaders, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/office/tasks', { method: 'POST', raw: '{', headers: tokenHeaders })).status, 400);
  assert.equal((await request('/api/office/tasks', { method: 'POST', raw: 'x'.repeat(128 * 1024 + 1), headers: tokenHeaders })).status, 413);
  assert.equal((await request('/api/office/tasks', { method: 'POST', input: { title: 'CLI without Origin' }, headers: tokenHeaders })).status, 201);
});

test('task routes persist claims and results without exposing claim tokens in snapshots', async t => {
  const { request, tokenHeaders, projectPath } = await fixture(t);
  const created = await request('/api/office/tasks', { method: 'POST', headers: tokenHeaders, input: { title: 'Work', projectPath } });
  const id = created.body.task.id;
  const edited = await request(`/api/office/tasks/${id}`, { method: 'PATCH', headers: tokenHeaders, input: { title: 'Updated', version: 1 } });
  assert.equal(edited.body.task.title, 'Updated');
  const claim = await request('/api/office/tasks/claim-next', { method: 'POST', headers: tokenHeaders, input: { worker: { id: 'worker', provider: 'codex', role: 'Helper', projectPath } } });
  assert.equal(claim.body.task.id, id);
  const claimToken = claim.body.claimToken;
  assert.ok(!JSON.stringify((await request('/api/office/board')).body).includes(claimToken));
  assert.equal((await request(`/api/office/tasks/${id}/heartbeat`, { method: 'POST', headers: tokenHeaders, input: { claimToken } })).status, 200);
  const finished = await request(`/api/office/tasks/${id}/finish`, { method: 'POST', headers: tokenHeaders, input: { claimToken, status: 'done', result: 'Verified result' } });
  assert.equal(finished.body.task.status, 'done');
  assert.equal(finished.body.task.result, 'Verified result');
});

test('management instructions return immediately and callback failures are sanitized and retryable', async t => {
  let settle;
  const neverUntilReleased = new Promise(resolve => { settle = resolve; });
  let calls = 0;
  const { request, tokenHeaders, store } = await fixture(t, { onInstruction: async () => { calls++; await neverUntilReleased; throw new Error('PRIVATE_API_KEY'); }, getRuntimeStatus: async () => ({ available: true }), getGrokStatus: () => ({ configured: true, connected: true }) });
  const result = await request('/api/office/instructions', { method: 'POST', headers: tokenHeaders, input: { text: 'Plan this work' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.instruction.status, 'pending');
  assert.equal(calls, 1);
  settle(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.snapshot().instructions[0].status, 'blocked');
  assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_API_KEY'));
  const retry = await request(`/api/office/instructions/${result.body.instruction.id}/retry`, { method: 'POST', headers: tokenHeaders, input: {} });
  assert.equal(retry.status, 202);
  assert.equal(calls, 2);
  const board = await request('/api/office/board');
  assert.equal(board.body.runtime.available, true);
  assert.equal(board.body.grok.configured, true);
});

test('Grok key configuration is delegated without echoing secret input or provider errors', async t => {
  const { request, tokenHeaders } = await fixture(t, { onConfigureGrok: async () => { throw new Error('PRIVATE_API_KEY'); } });
  const result = await request('/api/office/grok/connect', { method: 'POST', headers: tokenHeaders, input: { apiKey: 'PRIVATE_API_KEY' } });
  assert.equal(result.status, 400);
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE_API_KEY'));
});

test('external GrokBot plans are atomic, project-scoped, idempotent and cannot replace running planning', async t => {
  const { request, tokenHeaders, store, projectPath } = await fixture(t);
  const instruction = store.createInstruction({ text: 'Plan this project', projectPath });
  const route = `/api/office/instructions/${instruction.id}/apply-plan`;
  const plan = { summary: 'Implement and verify.', roles: [{ name: 'Delivery lead', description: 'Coordinate this delivery.' }], tasks: [{ title: 'Implement', description: 'Implement and test this behavior.', provider: 'codex', role: 'Helper', priority: 'normal', projectPath: '/untrusted-model-path' }] };
  const invalid = structuredClone(plan); invalid.tasks[0].provider = 'grok';
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: invalid })).status, 400);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().roles.length, 0);
  store.updateInstruction(instruction.id, { status: 'running' });
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: plan })).status, 409);
  store.updateInstruction(instruction.id, { status: 'blocked' });
  const applied = await request(route, { method: 'POST', headers: tokenHeaders, input: { plan } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.tasks[0].projectPath, instruction.projectPath);
  assert.equal(applied.body.tasks[0].source, 'grok');
  assert.equal((await request(route, { method: 'POST', headers: tokenHeaders, input: plan })).body.applied, false);
  assert.equal(store.snapshot().tasks.length, 1);
});

test('GrokBot heartbeat uses the same mutation guards and delegates only after a valid token', async t => {
  let calls = 0;
  const { request, tokenHeaders } = await fixture(t, { onBotHeartbeat: async input => { calls++; return { id: 'fixture-bot', name: input.name, status: input.status }; } });
  const input = { name: 'Fixture GrokBot', status: 'idle' };
  assert.equal((await request('/api/office/grok/bot/heartbeat', { method: 'POST', input })).status, 403);
  assert.equal(calls, 0);
  const result = await request('/api/office/grok/bot/heartbeat', { method: 'POST', input, headers: tokenHeaders });
  assert.equal(result.status, 200);
  assert.equal(result.body.bot.id, 'fixture-bot');
  assert.equal(calls, 1);
});

test('bulk card actions require CSRF, preserve per-card failures and validate selection bounds', async t => {
  const { store, request, tokenHeaders } = await fixture(t);
  const first = store.createTask({ title: 'Delete fixture' });
  const second = store.createTask({ title: 'Changed fixture' });
  store.updateTask(second.id, { title: 'Updated fixture' });
  const input = { action: 'delete', items: [first, second].map(task => ({ id: task.id, version: task.version })) };
  const url = '/api/office/tasks/card-actions';
  assert.equal((await request(url, { method: 'POST', input })).status, 403);
  const result = await request(url, { method: 'POST', headers: tokenHeaders, input });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results.map(item => item.ok), [true, false]);
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().deletedTasks.length, 1);
  assert.equal((await request(url, { method: 'POST', headers: tokenHeaders, input: { ...input, items: Array(101).fill(input.items[0]) } })).status, 400);
  const malformed = await request(url, { method: 'POST', headers: tokenHeaders, input: { action: 'deny', items: [null] } });
  assert.equal(malformed.body.results[0].ok, false);
});

test('dispatch submissions sync through one persisted record and replay without duplicate planning', async t => {
  let plans = 0;
  const f = await fixture(t, { onInstruction: () => { plans++; } });
  const requestId = 'a7d32d00-9a14-407d-9ba1-9423156fa971';
  const input = { requestId, text: 'UI test: plan work', projectPath: f.projectPath };
  const first = await f.request('/api/office/instructions', { method: 'POST', input, headers: f.tokenHeaders });
  assert.equal(first.status, 202);
  const again = await f.request('/api/office/instructions', { method: 'POST', input, headers: f.tokenHeaders });
  assert.equal(again.body.instruction.id, first.body.instruction.id);
  assert.equal(f.store.snapshot().instructions.length, 1);
  assert.equal(plans, 1);
  const plan = { summary: 'The requested work is planned', roles: [], tasks: [{ title: 'Implement test work', description: 'Test acceptance', projectPath: f.projectPath, provider: 'claude', role: 'any', priority: 'normal' }] };
  const result = await f.request(`/api/office/instructions/${requestId}/apply-plan`, { method: 'POST', input: plan, headers: f.tokenHeaders });
  assert.equal(result.status, 200);
  const board = (await f.request('/api/office/board')).body;
  assert.equal(board.instructions[0].summary, plan.summary);
  assert.equal(board.tasks[0].managementRequestId, requestId);
  assert.equal(board.tasks[0].status, 'pending');
  const replayAfterPlan = await f.request('/api/office/instructions', { method: 'POST', input, headers: f.tokenHeaders });
  assert.equal(replayAfterPlan.body.instruction.status, 'done');
  assert.equal(plans, 1);
  assert.equal((await f.request('/api/office/instructions', { method: 'POST', input: { ...input, text: 'Different work' }, headers: f.tokenHeaders })).status, 409);
  assert.equal((await f.request('/api/office/instructions', { method: 'POST', input: { ...input, requestId: 'invalid' }, headers: f.tokenHeaders })).status, 400);
});

test('read-only workspace cannot submit dispatch instructions, and a fresh GET sees external plan updates', async t => {
  const f = await fixture(t, { readOnly: true });
  assert.equal((await f.request('/api/office/instructions', { method: 'POST', input: { text: 'Cannot write here' }, headers: f.tokenHeaders })).status, 403);
  assert.equal(f.store.snapshot().instructions.length, 0);
  const instruction = f.store.createInstruction({ text: 'An external instruction' });
  f.store.applyManagementPlan(instruction.id, { summary: 'External reply', tasks: [], roles: [] });
  assert.equal((await f.request('/api/office/board')).body.instructions[0].summary, 'External reply');
});


test('board exposes bounded live report health but keeps generated summaries and source records in reports endpoint', async t => {
  let report = { phase: 'ready', started: true, runningLogs: [{ detail: 'PRIVATE LOG' }], providers: [],
    logSummary: { phase: 'summarizing', checkedAt: '2026-11-12T12:00:00Z', generatedAt: null, stale: true,
      summary: 'PRIVATE MODEL TEXT', highlights: ['PRIVATE HIGHLIGHT'], sourceFingerprint: 'PRIVATE FINGERPRINT',
      sourceErrors: ['claude', 'PRIVATE ERROR', 'claude'], error: null } };
  const { request } = await fixture(t, { getWorkReports: () => report });
  const board = (await request('/api/office/board')).body;
  assert.deepEqual(board.workReportsSummary.logSummary, { phase: 'summarizing', checkedAt: '2026-11-12T12:00:00.000Z', generatedAt: null, stale: true, error: null, sourceErrors: ['claude'] });
  assert.ok(!JSON.stringify(board).includes('PRIVATE'));
  const full = (await request('/api/office/work-reports')).body;
  assert.equal(full.logSummary.summary, 'PRIVATE MODEL TEXT');
  assert.equal(full.runningLogs[0].detail, 'PRIVATE LOG');
  report.logSummary = { phase: 'unavailable', error: 'PRIVATE RAW ERROR', sourceErrors: ['runtime'], checkedAt: 'bad date' };
  const broken = (await request('/api/office/board')).body.workReportsSummary.logSummary;
  assert.equal(broken.phase, 'unavailable'); assert.equal(broken.checkedAt, null);
  assert.ok(broken.error); assert.ok(!JSON.stringify(broken).includes('PRIVATE'));
  delete report.logSummary;
  assert.equal((await request('/api/office/board')).body.workReportsSummary.logSummary, undefined, 'legacy report readers remain compatible');
});


test('daily report reads and acknowledgements use the protected Bot route without changing task questions', async t => {
  const report = { id: 'qwen-daily:2026-11-13', status: 'pending', reportHash: 'a'.repeat(64), text: '日报' };
  let acknowledgements = 0;
  const callbacks = { getDailyReports: () => ({ enabled: true, phase: 'waiting', latest: report }), getPendingReports: () => [report],
    onAcknowledgeReport: (id, input) => { acknowledgements++; assert.equal(id, report.id); assert.equal(input.messageId, 'real-message'); return { ...report, status: 'delivered' }; } };
  const f = await fixture(t, callbacks), route = `/api/office/daily-reports/${encodeURIComponent(report.id)}/acknowledge`;
  assert.equal((await f.request('/api/office/daily-reports')).body.latest.id, report.id);
  assert.deepEqual((await f.request('/api/office/daily-reports/pending')).body.reports, [report]);
  const input = { source: 'grok-bot', reportHash: report.reportHash, messageId: 'real-message' };
  assert.equal((await f.request(route, { method: 'POST', input })).status, 403);
  assert.equal((await f.request(route, { method: 'POST', input, headers: f.tokenHeaders })).body.report.status, 'delivered');
  assert.equal(acknowledgements, 1); assert.equal(f.store.snapshot().humanRequests.length, 0);
  const readOnly = await fixture(t, { ...callbacks, readOnly: true });
  assert.equal((await readOnly.request(route, { method: 'POST', input, headers: readOnly.tokenHeaders })).status, 403);
  const absent = await fixture(t);
  assert.equal((await absent.request('/api/office/daily-reports/pending')).status, 503);
  assert.equal((await absent.request(route, { method: 'POST', input, headers: absent.tokenHeaders })).status, 503);
});


test('report acknowledgement errors preserve bounded HTTP status without treating conflicts as server failures', async t => {
  const f = await fixture(t, { onAcknowledgeReport() { throw Object.assign(new Error('Report binding does not match.'), { status: 409 }); } });
  const result = await f.request('/api/office/daily-reports/qwen-daily%3A2026-11-13/acknowledge', { method: 'POST', input: { source: 'grok-bot', reportHash: 'wrong', messageId: 'msg' }, headers: f.tokenHeaders });
  assert.equal(result.status, 409); assert.match(result.body.error, /binding/);
});
