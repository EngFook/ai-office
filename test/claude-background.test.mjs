import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackgroundReducer, createClaudeBackgroundReader } from '../server/claude-background.mjs';
import { claudeBridge } from '../server/claude-bridge.mjs';
const time = '2026-11-09T12:00:00.000Z';
const row = (type, content, extra = {}) => ({ type, sessionId: 'session', timestamp: time, message: { role: type, content }, ...extra });
const launch = (id, name = 'Bash', extra = {}) => row('assistant', [{ type: 'tool_use', id, name, input: { command: 'npm test', description: 'Run tests', ...extra } }]);
const result = (id, content, extra = {}) => row('user', [{ type: 'tool_result', tool_use_id: id, content, ...extra }]);
const notification = (id, status = 'completed') => row('user', `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Background command finished</summary></task-notification>`);

test('indexes explicit and automatic background launches and deduplicates replayed terminal events', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(launch('tool'), calls);
  r.consume(result('tool', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'), calls);
  assert.equal(r.tasks.get('b1').status, 'running');
  r.consume(notification('b1'), calls); r.consume(notification('b1'), calls);
  r.consume(launch('tool'), calls); r.consume(result('tool', 'Command running in background with ID: b1.'), calls);
  assert.equal(r.tasks.size, 1); assert.equal(r.tasks.get('b1').status, 'completed');
  r.consume(launch('auto'), calls); r.consume(result('auto', 'Command did not complete within its 600s timeout and was moved to the background (ID: b2). Output is being written to: /tmp/b2.output'), calls);
  assert.equal(r.tasks.get('b2').kind, 'command');
  assert.equal(calls.size, 0);
});

test('handles Monitor, Workflow, TaskOutput, TaskStop and multiple stopped task IDs', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(launch('monitor', 'Monitor'), calls); r.consume(result('monitor', 'Monitor started (task m1, expires in 30m unless the source ends first)'), calls);
  r.consume(launch('wf', 'Workflow', { description: '' }), calls); r.consume({ ...result('wf', ''), toolUseResult: { taskId: 'w1', status: 'async_launched', workflowName: 'Build and review' } }, calls);
  assert.equal(r.tasks.get('m1').kind, 'monitor'); assert.equal(r.tasks.get('w1').description, 'Build and review');
  r.consume(launch('read', 'TaskOutput', { task_id: 'w1' }), calls); r.consume(result('read', '<status>failed</status>'), calls);
  assert.equal(r.tasks.get('w1').status, 'failed');
  r.consume(launch('stop', 'TaskStop', { task_id: 'm1' }), calls); r.consume(result('stop', JSON.stringify({ task_id: 'm1', message: 'Successfully stopped' })), calls);
  assert.equal(r.tasks.get('m1').status, 'stopped');
  r.consume(row('user', '<task-notification><task-id>b2</task-id><task-id>b3</task-id><status>killed</status></task-notification>'), calls);
  assert.equal(r.tasks.get('b3').status, 'stopped');
  r.consume({ ...notification('other'), sessionId: 'another' }); assert.equal(r.tasks.has('other'), false);
});

test('does not expose thinking, arbitrary tool results or credential strings', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(row('assistant', [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'tool_use', id: 'secret', name: 'Bash', input: { command: 'API_KEY=PRIVATE_SECRET npm test', description: 'Check', other: 'PRIVATE_INPUT' } }]), calls);
  r.consume({ ...result('secret', 'PRIVATE_OUTPUT'), toolUseResult: { backgroundTaskId: 'b1', stdout: 'PRIVATE_OUTPUT' } }, calls);
  r.consume(row('user', 'Quoted example: <task-notification><task-id>fake</task-id><status>failed</status></task-notification>'));
  assert.ok(!JSON.stringify([...r.tasks.values()]).includes('PRIVATE_')); assert.equal(r.tasks.has('fake'), false);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-background-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'projects', 'project'); await mkdir(project, { recursive: true });
  return { home, project, reader: createClaudeBackgroundReader({ claudeHome: home }), status: { agents: [{ id: 'session:main', sessionId: 'session', status: 'working', isSubagent: false }] } };
}
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

test('incrementally follows complete JSONL records, refreshes notifications, and rebuilds rotated files', async t => {
  const { project, reader, status } = await fixture(t); const file = path.join(project, 'session.jsonl');
  await writeFile(file, jsonl([launch('one'), result('one', 'Command running in background with ID: b1.')]));
  await reader.refresh(status); assert.equal(reader.snapshot().counts.running, 1);
  const ending = JSON.stringify(notification('b1')); await appendFile(file, ending.slice(0, 40)); await reader.refresh(status);
  assert.equal(reader.snapshot().counts.running, 1);
  await appendFile(file, ending.slice(40) + '\n'); await reader.refresh(status);
  assert.equal(reader.snapshot().counts.completed, 1);
  await reader.refresh(status); assert.equal(reader.snapshot().total, 1);
  await writeFile(file, jsonl([notification('replacement', 'failed')])); await reader.refresh(status);
  assert.equal(reader.snapshot().tasks[0].taskId, 'replacement'); assert.equal(reader.snapshot().total, 1);
});

test('reads nested workflows, marks orphaned/restarted commands unconfirmed, rejects symlinks', async t => {
  const { home, project, reader, status } = await fixture(t);
  const nested = path.join(project, 'session', 'subagents', 'workflows', 'wf-1'); await mkdir(nested, { recursive: true });
  const rows = [launch('child'), result('child', 'Command running in background with ID: child-task.')].map(r => ({ ...r, agentId: 'child' }));
  await writeFile(path.join(nested, 'agent-child.jsonl'), jsonl(rows));
  await writeFile(path.join(home, 'outside.jsonl'), jsonl([notification('secret-task')]));
  await symlink(path.join(home, 'outside.jsonl'), path.join(project, 'session.jsonl'));
  await reader.refresh(status); assert.equal(reader.snapshot().total, 1); assert.equal(reader.snapshot().counts.unknown, 1);
  status.agents.push({ sessionId: 'session', agentId: 'child', status: 'working' }); await reader.refresh(status); assert.equal(reader.snapshot().counts.running, 1);
  await mkdir(path.join(home, 'sessions')); await writeFile(path.join(home, 'sessions', '123.json'), JSON.stringify({ sessionId: 'session', startedAt: Date.parse('2026-11-09T13:00:00Z') }));
  await reader.refresh(status); assert.equal(reader.snapshot({ scope: 'history' }).counts.unknown, 1);
  assert.equal(reader.snapshot().total, 0);
});

test('pagination and filters preserve totals without hiding later records', async t => {
  const { project, reader, status } = await fixture(t);
  await writeFile(path.join(project, 'session.jsonl'), jsonl(Array.from({ length: 230 }, (_, i) => notification(`task-${i}`, i % 2 ? 'completed' : 'failed'))));
  await reader.refresh(status);
  assert.equal(reader.snapshot({ limit: 999 }).tasks.length, 200);
  assert.equal(reader.snapshot({ status: 'failed', offset: 100, limit: 60 }).tasks.length, 15);
  assert.equal(reader.snapshot({ status: 'failed' }).total, 115);
  assert.equal(reader.snapshot({ search: 'task-229' }).total, 1);
});

test('background endpoint remains local, read-only, same-origin and respects disabled provider', async () => {
  let middleware; claudeBridge({ enabled: false }).configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  async function request(extra = {}) { let body; const res = { statusCode: 200, setHeader() {}, end(value) { body = value; } }; await middleware({ url: '/api/claude/background-tasks', method: 'GET', headers: { host: 'localhost:5186' }, socket: { remoteAddress: '127.0.0.1' }, ...extra }, res, () => assert.fail()); return { status: res.statusCode, body }; }
  assert.equal((await request()).status, 200);
  assert.match((await request()).body, /"enabled":false/);
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ headers: { host: 'localhost:5186', origin: 'http://evil.example' } })).status, 403);
});

test('monitor expiry is a recorded stop, not an indefinitely running job', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(launch('monitor', 'Monitor'), calls); r.consume(result('monitor', 'Monitor started (task m1, expires in 30m)'), calls);
  r.consume({ type: 'queue-operation', operation: 'enqueue', sessionId: 'session', timestamp: time, content: '<task-notification><task-id>m1</task-id><summary>Monitor event: "Watch"</summary><event>[Monitor expired after 30m with no events delivered.]</event></task-notification>' });
  assert.equal(r.tasks.get('m1').status, 'stopped');
});

test('pending foreground Bash calls appear before they return a background ID, then disappear on return', async t => {
  const { project, reader, status } = await fixture(t); const file = path.join(project, 'session.jsonl');
  status.agents[0].tool = 'Bash';
  await writeFile(file, jsonl([launch('pending')])); await reader.refresh(status);
  assert.equal(reader.snapshot().tasks[0].kind, 'foreground');
  await appendFile(file, jsonl([result('pending', 'Command running in background with ID: b1.')])); await reader.refresh(status);
  assert.equal(reader.snapshot().total, 1); assert.equal(reader.snapshot().tasks[0].taskId, 'b1');
});

test('a genuinely new invocation can resume a task; stale old-run terminal events cannot end it', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(launch('old'), calls); r.consume(result('old', 'Command running in background with ID: b1.'), calls); r.consume(notification('b1'), calls);
  const later = '2026-11-09T13:00:00.000Z';
  r.consume({ ...launch('new'), timestamp: later }, calls); r.consume({ ...result('new', 'Command running in background with ID: b1.'), timestamp: later }, calls);
  assert.equal(r.tasks.get('b1').status, 'running');
  r.consume(row('user', '<task-notification><task-id>b1</task-id><tool-use-id>old</tool-use-id><status>failed</status></task-notification>', { timestamp: '2026-11-09T14:00:00.000Z' }));
  assert.equal(r.tasks.get('b1').status, 'running');
});

test('removed sources cannot leave phantom running jobs in the index', async t => {
  const { project, reader, status } = await fixture(t), file = path.join(project, 'session.jsonl');
  await writeFile(file, jsonl([launch('one'), result('one', 'Command running in background with ID: b1.')]));
  await reader.refresh(status); assert.equal(reader.snapshot().counts.running, 1);
  await rm(file); await reader.refresh(status);
  assert.equal(reader.snapshot().total, 0); assert.match(reader.snapshot().error, /unavailable/);
});

test('explicit structured stalled states are retained and can resume, without guessing from elapsed time', () => {
  const r = createBackgroundReducer('session'), calls = new Map();
  r.consume(launch('tool'), calls); r.consume(result('tool', 'Command running in background with ID: b1.'), calls);
  assert.equal(r.tasks.get('b1').status, 'running');
  r.consume(launch('read', 'TaskOutput', { task_id: 'b1' }), calls);
  r.consume({ ...result('read', ''), toolUseResult: { task: { status: 'stalled' } } }, calls);
  assert.equal(r.tasks.get('b1').status, 'stalled');
  r.consume({ type: 'attachment', sessionId: 'session', timestamp: '2026-11-09T12:01:00.000Z', attachment: { type: 'task_status', taskId: 'b1', taskType: 'local_bash', status: 'running' } }, calls);
  assert.equal(r.tasks.get('b1').status, 'running');
  r.consume(notification('b1', 'stalled'), calls);
  assert.equal(r.tasks.get('b1').status, 'running', 'Older recorded stalls cannot overwrite later running status');
  r.consume({ ...notification('b1', 'stalled'), timestamp: '2026-11-09T12:02:00.000Z' }, calls);
  assert.equal(r.tasks.get('b1').status, 'stalled');
});

test('running and pending Bash records expose unconfirmed execution counts separately from recorded counts', async t => {
  const { project, reader, status } = await fixture(t);
  status.agents[0].tool = 'Bash';
  await writeFile(path.join(project, 'session.jsonl'), jsonl([launch('launched'), result('launched', 'Command running in background with ID: b1.'), launch('pending')]));
  await reader.refresh(status);
  const snapshot = reader.snapshot();
  assert.equal(snapshot.counts.running, 2);
  assert.equal(snapshot.countsBasis, 'last-recorded');
  assert.equal(snapshot.executionCounts.unconfirmed, 2);
  assert.equal(snapshot.executionCounts.running, undefined);
  assert.ok(snapshot.tasks.every(task => task.lastRecordedStatus === 'running' && task.executionState === 'unconfirmed' && task.lastEventAt));
  assert.deepEqual(new Set(snapshot.tasks.map(task => task.observationSource)), new Set(['claude-pending-tool-record', 'claude-transcript-task-lifecycle']));
  assert.equal(snapshot.observedAt, snapshot.lastScanAt);
});

test('one session comparison never counts another session commands or filters agents into command totals', async t => {
  const { project, reader, status } = await fixture(t);
  status.agents.push({ id: 'session2:main', sessionId: 'session2', status: 'working', isSubagent: false });
  await writeFile(path.join(project, 'session.jsonl'), jsonl([launch('one'), result('one', 'Command running in background with ID: b1.')]));
  await writeFile(path.join(project, 'session2.jsonl'), jsonl([launch('two'), result('two', 'Command running in background with ID: b2.')].map(item => ({ ...item, sessionId: 'session2' }))));
  await reader.refresh(status);
  const single = reader.snapshot({ sessionId: 'session' });
  assert.equal(single.sessionId, 'session');
  assert.equal(single.counts.running, 1);
  assert.equal(single.tasks[0].taskId, 'b1');
  assert.equal(reader.snapshot().counts.running, 2);
});
