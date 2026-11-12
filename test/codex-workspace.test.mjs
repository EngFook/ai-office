import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexWorkspaceReader, parseCodexWorkspaceRecords } from '../server/codex-workspace.mjs';
import { codexBridge } from '../server/codex-bridge.mjs';

const agent = { id: 'child', agentId: 'child', sessionId: 'child', agentPath: '/root/builder', isSubagent: true, observed: true, status: 'working', name: 'Builder' };
const row = payload => JSON.stringify({ type: 'response_item', timestamp: '2026-11-09T01:00:00Z', payload }) + '\n';
const message = (role, text, extra = {}) => row({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra });
const assignment = (text = 'Build the page') => row({ type: 'agent_message', id: 'assignment', author: '/root', recipient: agent.agentPath, content: [{ type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${agent.agentPath}\nSender: /root\nPayload:\n${text}` }] });

test('Codex workspace keeps child assignment separate from inherited history and hides reasoning, policy, args and results', () => {
  const parsed = parseCodexWorkspaceRecords(message('user', 'PARENT_HISTORY') + message('assistant', 'PARENT_REPLY', { phase: 'final_answer' }) + assignment('Build page API_KEY="private-value"') + message('developer', 'HIDDEN_POLICY') + message('assistant', 'HIDDEN_REASONING', { channel: 'analysis', phase: 'commentary' }) + row({ type: 'reasoning', summary: 'HIDDEN_REASONING' }) + row({ type: 'function_call_output', output: 'HIDDEN_RESULT' }) + row({ type: 'function_call', id: 'tool', name: 'functions.exec', arguments: 'HIDDEN_ARGUMENTS' }) + message('assistant', 'Checking layout', { phase: 'commentary', id: 'progress' }), agent);
  assert.match(parsed.instruction, /^Build page/);
  assert.equal(parsed.instructionState, 'available');
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events.at(-1).text, 'Checking layout');
  for (const value of ['PARENT_', 'HIDDEN_', 'private-value']) assert.ok(!JSON.stringify(parsed).includes(value));
});

test('encrypted child task is explicit, never replaced by inherited parent prompt or ciphertext', () => {
  const encrypted = row({ type: 'agent_message', recipient: agent.agentPath, content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'PRIVATE_CIPHERTEXT' }] });
  const parsed = parseCodexWorkspaceRecords(message('user', 'PARENT_TASK') + encrypted + message('assistant', 'Working', { phase: 'commentary' }), agent);
  assert.equal(parsed.instruction, '');
  assert.equal(parsed.instructionState, 'encrypted');
  assert.equal(parsed.events[0].text, 'Working');
  assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
  assert.equal(parseCodexWorkspaceRecords(message('user', 'PARENT_TASK'), agent).instruction, '');
});

test('main agent shows latest real user request, excludes ambient-only blocks, escapes through React and redacts credentials', () => {
  const parsed = parseCodexWorkspaceRecords(message('user', 'Old') + message('user', '<environment_context>HIDDEN_ENV</environment_context>') + message('user', '<in-app-browser-context>HIDDEN_UI</in-app-browser-context>\nFix the office Authorization: Bearer private-token'), { ...agent, isSubagent: false });
  assert.match(parsed.instruction, /^Fix the office/);
  assert.ok(!JSON.stringify(parsed).includes('private-token'));
  assert.ok(!JSON.stringify(parsed).includes('HIDDEN'));
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-workspace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'sessions'));
  const file = path.join(home, 'sessions', 'child.jsonl');
  return { home, file, rows: [{ id: agent.id, rollout_path: file }], read: createCodexWorkspaceReader({ codexHome: home }), status: { agents: [agent], metadataAvailable: true } };
}

test('bounded reader refreshes append, excludes offline records and retains assignment plus recent activity', async t => {
  const f = await fixture(t);
  await writeFile(f.file, assignment() + Array.from({ length: 900 }, (_, i) => message('assistant', `step ${i} ${'x'.repeat(1200)}`, { phase: 'commentary', id: `event-${i}` })).join(''));
  const result = (await f.read({ ...f.status, agents: [agent, { ...agent, id: 'offline', status: 'offline' }] }, f.rows)).agents;
  assert.equal(result.length, 1);
  assert.equal(result[0].instruction, 'Build the page');
  assert.equal(result[0].truncated, true);
  assert.equal(result[0].events.length, 32);
  assert.match(result[0].events.at(-1).text, /^step 899/);
  await appendFile(f.file, message('assistant', 'Final change', { phase: 'final_answer', id: 'final' }));
  assert.equal((await f.read(f.status, f.rows)).agents[0].events.at(-1).text, 'Final change');
});


test('large main logs do not mislabel a historic first-page prompt as the current instruction', async t => {
  const f = await fixture(t);
  await writeFile(f.file, message('user', 'HISTORIC_REQUEST') + Array.from({ length: 900 }, (_, i) => message('assistant', `activity ${i} ${'x'.repeat(1200)}`, { phase: 'commentary', id: `public-${i}` })).join(''));
  const [result] = (await f.read({ ...f.status, agents: [{ ...agent, isSubagent: false }] }, f.rows)).agents;
  assert.equal(result.instruction, '');
  assert.equal(result.instructionState, 'outside-window');
  assert.ok(!JSON.stringify(result).includes('HISTORIC_REQUEST'));
});

test('missing or symlinked logs never expose content and preserve observed agent identity', async t => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'outside.jsonl');
  await writeFile(outside, assignment('PRIVATE_OUTSIDE'));
  await symlink(outside, f.file);
  const [result] = (await f.read(f.status, f.rows)).agents;
  assert.equal(result.sourceAvailable, false);
  assert.equal(result.status, 'working');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_OUTSIDE'));
  assert.equal((await f.read(f.status, [{ id: agent.id, rollout_path: outside }])).agents[0].sourceAvailable, false);
});

test('workspace endpoint is read-only, loopback, same-origin and disabled together with Codex', async t => {
  const f = await fixture(t);
  let handler;
  codexBridge({ codexHome: f.home, enabled: false }).configureServer({ middlewares: { use(value) { handler = value; } } });
  async function request(extra = {}) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(text) { body = JSON.parse(text); } };
    await handler({ url: '/api/codex/workspace', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5173' }, ...extra }, response, () => assert.fail('Workspace expected'));
    return { status: response.statusCode, body };
  }
  assert.equal((await request()).body.enabled, false);
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ socket: { remoteAddress: '192.168.1.2' } })).status, 403);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } })).status, 403);
});


test('head/tail windows never duplicate anonymous activity in medium logs', async t => {
  const f = await fixture(t);
  const padding = JSON.stringify({ type: 'compacted', payload: { message: 'x'.repeat(510 * 1024) } }) + '\n';
  await writeFile(f.file, assignment() + padding + message('assistant', 'A single public update', { phase: 'commentary' }) + JSON.stringify({ type: 'compacted', payload: { message: 'x'.repeat(90 * 1024) } }) + '\n');
  const [result] = (await f.read(f.status, f.rows)).agents;
  assert.equal(result.events.filter(event => event.text === 'A single public update').length, 1);
});

test('workspace projects live child content on demand without expanding the status privacy boundary', async t => {
  const f = await fixture(t);
  await writeFile(f.file, assignment('Build the assigned feature') + JSON.stringify({ type: 'event_msg', timestamp: '2026-11-09T01:00:00Z', payload: { type: 'task_started' } }) + '\n');
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, agent_path TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(agent.id, f.file, '/tmp/project', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root' } } }), agent.agentPath, 0);
  db.close();
  let handler;
  codexBridge({ codexHome: f.home, agentsHome: path.join(f.home, 'agents'), owners: new Map([[agent.id, 123]]) }).configureServer({ middlewares: { use(value) { handler = value; } } });
  async function get(url) {
    let value;
    const response = { statusCode: 200, setHeader() {}, end(text) { value = JSON.parse(text); } };
    await handler({ url, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:5173' } }, response, () => assert.fail());
    assert.equal(response.statusCode, 200);
    return value;
  }
  const status = await get('/api/codex/status');
  assert.equal(status.agents[0].status, 'working');
  assert.ok(!JSON.stringify(status).includes('Build the assigned feature'));
  const workspace = await get('/api/codex/workspace');
  assert.equal(workspace.agents[0].instruction, 'Build the assigned feature');
  assert.equal(workspace.agents[0].status, 'working');
  assert.ok(!JSON.stringify(workspace).includes('rollout_path'));
});

test('workspace shows every active child, encrypted instructions and stale states without claiming live counts', async () => {
  const { createServer } = await import('vite');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { CodexWorkspaceView } = await server.ssrLoadModule('/src/CodexWorkspace.jsx');
    const agents = Array.from({ length: 100 }, (_, i) => ({ ...agent, id: `child-${i}`, instructionState: 'encrypted', events: [], sourceAvailable: true }));
    const html = renderToStaticMarkup(React.createElement(CodexWorkspaceView, { data: { agents }, lang: 'zh' }));
    assert.equal((html.match(/data-agent-id=/g) || []).length, 100);
    assert.ok(html.includes('Codex 工作室'));
    assert.ok(html.includes('由 Codex 加密保存'));
    assert.ok(html.includes('立即同步'));
    const stale = renderToStaticMarkup(React.createElement(CodexWorkspaceView, { data: { agents, metadataAvailable: false }, lang: 'zh' }));
    assert.ok(stale.includes('状态待确认'));
    assert.ok(!stale.includes('cw-running'));
    assert.ok(!stale.includes('cw-counts'));
  } finally { await server.close(); }
});
