import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOfficeBoardCommand } from '../scripts/office-board.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

function fixture() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(options.method === 'GET' ? { csrfToken: 'request-token', tasks: [], instructions: [{ id: 'pending', status: 'pending' }, { id: 'done', status: 'done' }] } : { saved: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('office-board status hides its mutation token and pending-instructions filters completed work', async () => {
  const { fetchImpl, calls } = fixture();
  const result = await runOfficeBoardCommand({ args: ['status'], environment: {}, fetchImpl });
  assert.equal(result.csrfToken, undefined);
  assert.equal(calls[0].url, 'http://127.0.0.1:5173/api/office/board');
  const pending = await runOfficeBoardCommand({ args: ['pending-instructions'], environment: {}, fetchImpl });
  assert.deepEqual(pending.instructions.map(item => item.id), ['pending']);
});

test('office-board mutations use the same local origin and board token with structured JSON', async () => {
  const { fetchImpl, calls } = fixture();
  const input = { summary: 'Manage the work.', roles: [], tasks: [{ title: 'Literal $(command)', provider: 'codex' }] };
  await runOfficeBoardCommand({ args: ['apply-plan', 'instruction:1', '--port', '5179'], environment: {}, fetchImpl, readInput: async () => input });
  assert.equal(calls[1].url, 'http://127.0.0.1:5179/api/office/instructions/instruction%3A1/apply-plan');
  assert.equal(calls[1].options.headers['X-Office-Token'], 'request-token');
  assert.equal(calls[1].options.headers.Origin, 'http://127.0.0.1:5179');
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[1].options.body), input);
});

test('office-board rejects external URLs, URL credentials and invalid ports before requests', async () => {
  const { fetchImpl, calls } = fixture();
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.test:5173', 'http://user:secret@localhost:5173', 'http://localhost:5173/private']) await assert.rejects(runOfficeBoardCommand({ args: ['status'], environment: { AI_OFFICE_URL: url }, fetchImpl }), /loopback/);
  await assert.rejects(runOfficeBoardCommand({ args: ['status', '--port', '70000'], environment: {}, fetchImpl }), /--port/);
  assert.equal(calls.length, 0);
});

test('office-board can claim, heartbeat and finish without putting tokens into command arguments', async () => {
  const { fetchImpl, calls } = fixture();
  await runOfficeBoardCommand({ args: ['claim-next'], environment: {}, fetchImpl, readInput: async () => ({ id: 'worker', provider: 'codex' }) });
  assert.ok(calls[1].url.endsWith('/tasks/claim-next'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { worker: { id: 'worker', provider: 'codex' } });
  await runOfficeBoardCommand({ args: ['heartbeat', 'task-1'], environment: {}, fetchImpl, readInput: async () => ({ claimToken: 'owner-token' }) });
  assert.ok(calls[3].url.endsWith('/tasks/task-1/heartbeat'));
  await runOfficeBoardCommand({ args: ['finish', 'task-1'], environment: {}, fetchImpl, readInput: async () => ({ claimToken: 'owner-token', status: 'done', result: 'Completed.' }) });
  assert.ok(calls[5].url.endsWith('/tasks/task-1/finish'));
});

test('office-board bot heartbeat sends only the explicit local presence report', async () => {
  const { fetchImpl, calls } = fixture();
  const input = { id: 'grok-main', name: 'Grok Bot', role: 'Chief of staff', status: 'working', instructionId: 'instruction-1', activity: 'Planning the assigned work.' };
  await runOfficeBoardCommand({ args: ['bot-heartbeat'], environment: {}, fetchImpl, readInput: async () => input });
  assert.equal(calls[1].url, 'http://127.0.0.1:5173/api/office/grok/bot/heartbeat');
  assert.deepEqual(JSON.parse(calls[1].options.body), input);
});

test('office-board CLI matches the real loopback routes for plans, claims, heartbeats and completion', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-cli-integration-'));
  const projectPath = path.join(home, 'project');
  await mkdir(projectPath);
  const store = createTaskStore({ home });
  let middleware;
  taskBoardBridge({ store, onBotHeartbeat: input => input }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const server = createServer((request, response) => { middleware(request, response, () => { response.statusCode = 404; response.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(home, { recursive: true, force: true }); });
  const environment = { AI_OFFICE_URL: `http://127.0.0.1:${server.address().port}` };
  const run = (args, input) => runOfficeBoardCommand({ args, environment, readInput: async () => input });
  const instruction = store.createInstruction({ text: 'Plan this scoped task.', projectPath });
  const plan = await run(['apply-plan', instruction.id], { summary: 'Make one change.', roles: [{ name: 'Delivery lead', description: 'Coordinate this scoped delivery.' }], tasks: [{ title: 'Implement', description: 'Implement the assigned behavior and verify it.', provider: 'codex', role: 'Helper', priority: 'normal' }] });
  assert.equal(plan.applied, true);
  const claim = await run(['claim-next'], { id: 'test-worker', provider: 'codex', roles: ['Helper'], projectPath });
  assert.equal(claim.task.id, plan.tasks[0].id);
  assert.equal((await run(['heartbeat', claim.task.id], { claimToken: claim.claimToken })).task.status, 'running');
  assert.equal((await run(['finish', claim.task.id], { claimToken: claim.claimToken, status: 'done', result: 'Verified.' })).task.status, 'done');
  assert.equal((await run(['bot-heartbeat'], { id: 'test-bot', status: 'idle' })).bot.status, 'idle');
  const board = await run(['status']);
  assert.equal(board.tasks.find(task => task.id === claim.task.id).status, 'done');
  assert.equal(board.tasks.find(task => task.reviewOf === claim.task.id)?.provider, 'claude', 'Codex work gets a Claude cross review');
  assert.equal(board.csrfToken, undefined);
});


test('office-board explicit claim targets the chosen card and validates its id before requests', async () => {
  const { fetchImpl, calls } = fixture();
  const worker = { id: 'grok-local', provider: 'grok-bot', projectPath: '/tmp/office' };
  await runOfficeBoardCommand({ args: ['claim', 'bot:task-1'], environment: {}, fetchImpl, readInput: async () => worker });
  assert.ok(calls[1].url.endsWith('/tasks/bot%3Atask-1/claim'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { worker });
  await runOfficeBoardCommand({ args: ['claim', 'bot:task-2'], environment: {}, fetchImpl, readInput: async () => ({ worker }) });
  assert.deepEqual(JSON.parse(calls[3].options.body), { worker });
  const count = calls.length;
  for (const args of [['claim'], ['claim', 'task', 'extra'], ['claim', 'bad?id']])
    await assert.rejects(runOfficeBoardCommand({ args, environment: {}, fetchImpl }), /requires one/);
  assert.equal(calls.length, count);
});
