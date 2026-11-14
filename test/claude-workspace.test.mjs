import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeWorkspaceReader, parseWorkspaceRecords, redactWorkspaceText } from '../server/claude-workspace.mjs';
import { claudeBridge } from '../server/claude-bridge.mjs';

const agent = { id: 'session:child', sessionId: 'session', agentId: 'child', isSubagent: true, observed: true, status: 'working', name: 'Builder' };
const row = (type, content, extra = {}) => JSON.stringify({ type, sessionId: 'session', agentId: 'child', uuid: `${type}-record`, timestamp: '2026-11-09T01:00:00Z', message: { role: type, content }, ...extra }) + '\n';

test('workspace exposes assigned instructions and allowed visible actions, never reasoning or tool results', () => {
  const text = row('user', 'Build the requested page') + row('assistant', [
    { type: 'thinking', thinking: 'HIDDEN_REASONING' },
    { type: 'redacted_thinking', data: 'HIDDEN_REASONING' },
    { type: 'text', text: 'Checking the page layout' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test', secret: 'HIDDEN_INPUT', description: 'Run tests' } },
  ]) + row('user', [{ type: 'tool_result', content: 'HIDDEN_RESULT' }]) + row('system', 'HIDDEN_SYSTEM') + row('attachment', 'HIDDEN_ATTACHMENT');
  const parsed = parseWorkspaceRecords(text, agent);
  assert.equal(parsed.instruction, 'Build the requested page');
  assert.equal(parsed.events.length, 2);
  assert.match(parsed.events[1].text, /npm test/);
  assert.ok(!JSON.stringify(parsed).includes('HIDDEN'));
  assert.equal(parseWorkspaceRecords(text, { ...agent, sessionId: 'other' }).events.length, 0);
  assert.equal(parseWorkspaceRecords(text, { ...agent, agentId: 'sibling' }).instruction, '');
});

test('redaction precedes truncation and preserves ordinary commands and line breaks', () => {
  const safe = redactWorkspaceText('first\nAPI_KEY="secret value" Authorization: Bearer private-value crsr_12345678901234567 sk-12345678901234567\n\u001b[31mred\n-----BEGIN ' + 'PRIVATE KEY-----\nprivate data\n-----END PRIVATE KEY-----');
  for (const value of ['secret value', 'private-value', '12345678901234567', 'private data', '\u001b']) assert.ok(!safe.includes(value));
  assert.match(safe, /first\n/);
  assert.equal(redactWorkspaceText('npm run build'), 'npm run build');
});

test('workflow instructions retain consecutive user assignment blocks before work starts', () => {
  const parsed = parseWorkspaceRecords(row('user', 'User request', { uuid: 'request' }) + row('user', 'Computed lane assignment', { uuid: 'assignment' }) + row('assistant', [{ type: 'thinking', thinking: 'HIDDEN' }]) + row('user', 'Later tool followup', { uuid: 'later' }), agent);
  assert.equal(parsed.instruction, 'User request\n\nComputed lane assignment');
});

test('partial records are ignored and recent visible activity is bounded and deduplicated', () => {
  const lines = Array.from({ length: 50 }, (_, index) => row('assistant', [{ type: 'text', text: `step ${index}` }], { uuid: `record-${index}` }));
  const parsed = parseWorkspaceRecords('broken\nnull\n[]\n42\n' + row('assistant', [null, false], { uuid: 'invalid' }) + lines.join('') + lines.at(-1) + '{"partial":', agent);
  assert.equal(parsed.events.length, 32);
  assert.equal(parsed.events.at(-1).text, 'step 49');
  assert.equal(parsed.truncated, true);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-workspace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'projects', 'project', 'session', 'subagents');
  await mkdir(directory, { recursive: true });
  return { home, directory, read: createClaudeWorkspaceReader({ claudeHome: home }) };
}

test('reads direct and nested workflow children, refreshes appended activity and excludes offline/unobserved agents', async t => {
  const { home, directory, read } = await fixture(t);
  await writeFile(path.join(directory, 'agent-child.jsonl'), row('user', 'Direct assignment'));
  const nested = path.join(directory, 'workflows', 'wf-example');
  await mkdir(nested, { recursive: true });
  const file = path.join(nested, 'agent-nested.jsonl');
  await writeFile(file, row('user', 'Workflow assignment', { agentId: 'nested' }));
  await writeFile(path.join(home, 'projects', 'project', 'session.jsonl'), row('user', 'Main task', { agentId: undefined }));
  const agents = [agent, { ...agent, id: 'session:nested', agentId: 'nested' }, { ...agent, id: 'session:main', agentId: undefined, isSubagent: false }, { ...agent, id: 'offline', status: 'offline' }, { ...agent, id: 'unobserved', observed: false }];
  const result = await read({ agents });
  assert.equal(result.agents.length, 3);
  assert.equal(result.agents.find(a => a.agentId === 'nested').instruction, 'Workflow assignment');
  assert.equal(result.agents.find(a => !a.isSubagent).instruction, 'Main task');
  await appendFile(file, row('assistant', [{ type: 'text', text: 'New progress' }], { agentId: 'nested' }));
  assert.equal((await read({ agents })).agents.find(a => a.agentId === 'nested').events[0].text, 'New progress');
});

test('refuses symlinks and traversal; unavailable logs leave real metadata visible', async t => {
  const { home, directory, read } = await fixture(t);
  const outside = path.join(home, 'outside.jsonl');
  await writeFile(outside, row('user', 'DO_NOT_EXPOSE'));
  await symlink(outside, path.join(directory, 'agent-child.jsonl'));
  const data = await read({ agents: [agent, { ...agent, id: 'bad', agentId: '../outside' }] });
  assert.equal(data.agents.length, 2);
  assert.ok(data.agents.every(a => !a.sourceAvailable && a.status === 'working'));
  assert.ok(!JSON.stringify(data).includes('DO_NOT_EXPOSE'));
});

test('bounded head/tail retains initial assignment and last events in large files', async t => {
  const { directory, read } = await fixture(t);
  await writeFile(path.join(directory, 'agent-child.jsonl'), row('user', 'Original task') + Array.from({ length: 600 }, (_, index) => row('assistant', [{ type: 'text', text: `event ${index} ${'x'.repeat(1000)}` }], { uuid: `row-${index}` })).join(''));
  const [result] = (await read({ agents: [agent] })).agents;
  assert.equal(result.instruction, 'Original task');
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 32);
  assert.match(result.events.at(-1).text, /^event 599/);
});

test('workspace endpoint is same-origin, local, GET-only and obeys disabled configuration', async t => {
  const { home } = await fixture(t);
  let handler;
  claudeBridge({ claudeHome: home, enabled: false }).configureServer({ middlewares: { use: value => { handler = value; } } });
  async function request(extra = {}) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(value) { body = JSON.parse(value); } };
    await handler({ url: '/api/claude/workspace', method: 'GET', headers: { host: '127.0.0.1:5173' }, socket: { remoteAddress: '127.0.0.1' }, ...extra }, response, () => assert.fail());
    return { status: response.statusCode, body };
  }
  assert.equal((await request()).body.enabled, false);
  assert.deepEqual((await request()).body.agents, []);
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', origin: 'https://other.test' } })).status, 403);
  assert.equal((await request({ socket: { remoteAddress: '192.168.1.3' } })).status, 403);
});

test('workspace renders 100 independent panels, escaped instructions and unavailable/disabled states', async () => {
  const { createServer } = await import('vite');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { ClaudeWorkspaceView } = await server.ssrLoadModule('/src/ClaudeWorkspace.jsx');
    const agents = Array.from({ length: 100 }, (_, i) => ({ ...agent, id: `agent-${i}`, instruction: '<script>unsafe</script>', events: [], sourceAvailable: false }));
    const html = renderToStaticMarkup(React.createElement(ClaudeWorkspaceView, { data: { agents }, lang: 'zh' }));
    assert.equal((html.match(/data-agent-id=/g) || []).length, 100);
    assert.ok(html.includes('agent-99'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
    const stale = renderToStaticMarkup(React.createElement(ClaudeWorkspaceView, { data: { agents: [agent] }, error: true }));
    assert.ok(stale.includes('状态待确认'));
    assert.ok(!stale.includes('cw-running'));
    const disabled = renderToStaticMarkup(React.createElement(ClaudeWorkspaceView, { data: { enabled: false, agents: [] } }));
    assert.ok(disabled.includes('未启用 Claude'));
  } finally { await server.close(); }
});

test('large main-session logs never label an old head prompt as the current instruction', async t => {
  const { home, read } = await fixture(t);
  const main = { ...agent, id: 'session:main', agentId: undefined, isSubagent: false };
  const file = path.join(home, 'projects', 'project', 'session.jsonl');
  const mainRow = (type, text, id) => row(type, text, { agentId: undefined, uuid: id });
  await writeFile(file, mainRow('user', 'Historical request', 'old-prompt') + Array.from({ length: 350 }, (_, i) => mainRow('assistant', 'public activity ' + 'x'.repeat(1500), `activity-${i}`)).join(''));
  let result = (await read({ agents: [main] })).agents[0];
  assert.equal(result.instruction, '');
  assert.equal(result.instructionState, 'outside-window');
  await appendFile(file, mainRow('user', 'New request', 'new-prompt') + mainRow('user', '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', 'notice'));
  result = (await read({ agents: [main] })).agents[0];
  assert.equal(result.instruction, 'New request');
});

test('head and tail windows preserve each user assignment only once near the window boundary', async t => {
  const { directory, read } = await fixture(t);
  const first = row('user', 'Assignment A', { uuid: 'prompt-a' });
  const second = row('user', 'Assignment B', { uuid: 'prompt-b' });
  await writeFile(path.join(directory, 'agent-child.jsonl'), first + second + row('assistant', 'x'.repeat(140000), { uuid: 'large-record' }));
  const result = (await read({ agents: [agent] })).agents[0];
  assert.equal(result.instruction, 'Assignment A\n\nAssignment B');
});

test('execution display and session counts keep unknown evidence and native session boundaries', async () => {
  const { agentExecutionDisplay, claudeSessionSummary } = await import('../src/claude-execution.js');
  const agents = [
    { id: 's1:main', sessionId: 's1', status: 'idle', isSubagent: false },
    { id: 's1:child', sessionId: 's1', status: 'working', observed: true, isSubagent: true, executionState: 'unconfirmed' },
    { id: 's2:child', sessionId: 's2', status: 'working', observed: true, isSubagent: true, executionState: 'unconfirmed' },
  ];
  const summary = claudeSessionSummary(agents, 's1');
  assert.equal(summary.main, 1); assert.equal(summary.child, 1);
  assert.equal(summary.confirmedRunning, 0); assert.equal(summary.recordedRunning, 1); assert.equal(summary.unconfirmed, 2);
  assert.equal(summary.idle, 0, 'an unobserved idle claim is not confirmed idle');
  assert.equal(agentExecutionDisplay(agents[1]), 'recorded-running');
  assert.equal(agentExecutionDisplay(agents[1], true), 'stale');
  assert.equal(agentExecutionDisplay({ status: 'idle', executionState: 'unconfirmed' }), 'unconfirmed');
});


test('shared redaction handles long unbroken text and masks URL credentials before display clipping', () => {
  const prefix = 'x'.repeat(150000);
  const source = prefix + ' https://user:PRIVATE_SYNTHETIC_PASSWORD@example.test/path?key=PRIVATE_SYNTHETIC_KEY';
  const start = performance.now();
  const safe = redactWorkspaceText(source, 150040);
  const elapsed = performance.now() - start;
  assert.equal(safe.slice(0, prefix.length), prefix);
  assert.ok(!safe.includes('PRIVATE_SYNTHETIC'));
  assert.ok(safe.includes('[REDACTED]@'));
  assert.ok(elapsed < 2000, `bounded public-text redaction took ${elapsed}ms`);
  assert.equal(redactWorkspaceText('https://credential@example.test/'), 'https://[REDACTED]@example.test/');
});
