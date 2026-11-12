import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexBridge, discoverCodexSkills, parseLockOwners, readCodexStatus, readThreadMetadata, reduceCodexEvents, sanitizeCodexRecord } from '../server/codex-bridge.mjs';

const record = (type, timestamp, extra = {}) => ({ type: 'event_msg', timestamp, payload: { type, ...extra } });
const line = value => JSON.stringify(value) + '\n';
const tool = (name, timestamp, callId = 'call-1') => ({ type: 'response_item', timestamp, payload: { type: 'function_call', name, namespace: 'functions', call_id: callId, arguments: 'PRIVATE_ARGUMENTS' } });

test('projects lifecycle and tool names while excluding every content-bearing field', () => {
  const complete = sanitizeCodexRecord(record('task_complete', 2000, { last_agent_message: 'PRIVATE_MESSAGE' }));
  assert.deepEqual(complete, { type: 'task_complete', timestamp: 2000 });
  assert.equal(sanitizeCodexRecord({ type: 'response_item', timestamp: 1000, payload: { type: 'message', content: 'PRIVATE_PROMPT' } }), null);
  assert.equal(sanitizeCodexRecord(record('token_count', 1000, { info: 'PRIVATE_RESULT' })), null);
  const metadata = sanitizeCodexRecord(tool('exec_command', 1000));
  assert.equal(metadata.tool, 'functions.exec_command');
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE'));
  assert.equal(sanitizeCodexRecord(record('task_started', 1e30)), null);
});

test('completion is idle, waits are explicit, and delayed tool events do not revive a completed turn', () => {
  const start = sanitizeCodexRecord(record('task_started', 1000));
  const waiting = sanitizeCodexRecord(record('exec_approval_request', 2000, { command: 'PRIVATE' }));
  const complete = sanitizeCodexRecord(record('task_complete', 3000));
  assert.equal(reduceCodexEvents([start]).status, 'working');
  assert.equal(reduceCodexEvents([start, waiting]).status, 'waiting');
  assert.equal(reduceCodexEvents([start, waiting, complete, sanitizeCodexRecord(tool('exec_command', 4000))]).status, 'idle');
  assert.equal(reduceCodexEvents([start, complete, sanitizeCodexRecord(record('task_started', 5000))]).status, 'working');
  assert.equal(reduceCodexEvents([start, sanitizeCodexRecord(tool('request_user_input', 6000))]).status, 'waiting');
});

test('tool metadata remains after completion and current calls clear without tool outputs', () => {
  const started = sanitizeCodexRecord(tool('exec_command', 1000));
  const finished = sanitizeCodexRecord({ type: 'response_item', timestamp: 2000, payload: { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE_OUTPUT' } });
  const active = reduceCodexEvents([started]);
  assert.equal(active.tool, 'functions.exec_command');
  assert.equal(active.lastToolOutcome, 'running');
  const done = reduceCodexEvents([finished], active);
  assert.equal(done.status, 'working');
  assert.equal(done.tool, null);
  assert.equal(done.lastTool, 'functions.exec_command');
  assert.equal(done.lastToolOutcome, 'succeeded');
  const failed = sanitizeCodexRecord(record('item_completed', 3000, { item: { type: 'CommandExecution', status: 'failed', command: 'PRIVATE_COMMAND', aggregated_output: 'PRIVATE_OUTPUT' } }));
  assert.equal(reduceCodexEvents([failed], done).lastToolOutcome, 'failed');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
});

test('writer lock ownership comes from lsof process/file records and never stale filenames alone', () => {
  const directory = '/tmp/codex/thread-writer-locks';
  const owners = parseLockOwners(`p123\nf32\nn${directory}/root-id.lock\np456\nf33\nn${directory}/child-id.lock\nn/tmp/elsewhere/private.lock\n`, directory);
  assert.equal(owners.get('root-id'), 123);
  assert.equal(owners.get('child-id'), 456);
  assert.equal(owners.size, 2);
  assert.equal(parseLockOwners('', directory).size, 0);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'ai-office-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await mkdir(path.join(home, 'agents', 'skills', 'build-test'), { recursive: true });
  await writeFile(path.join(home, 'agents', 'skills', 'build-test', 'SKILL.md'), '---\nname: Build test\ndescription: >\n  Build and verify\n  a local project.\n---\nPRIVATE_BODY');
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, title TEXT, first_user_message TEXT, preview TEXT)');
  for (const [id, source, nickname, role, agentPath] of [['root-id', 'vscode', null, null, null], ['child-id', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root-id', agent_path: '/root/review' } } }), 'Curie', 'reviewer', '/root/review']]) {
    database.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, path.join(home, 'sessions', `${id}.jsonl`), '/tmp/project', source, nickname, role, agentPath, 3, 3000, 0, 'PRIVATE_TITLE', 'PRIVATE_PROMPT', 'PRIVATE_PREVIEW');
  }
  database.close();
  await writeFile(path.join(home, 'sessions', 'root-id.jsonl'), line(record('task_started', 1000)) + line(tool('exec_command', 2000)));
  await writeFile(path.join(home, 'sessions', 'child-id.jsonl'), line(record('task_started', 1000)) + line(record('task_complete', 3000, { last_agent_message: 'PRIVATE_MESSAGE' })));
  return { codexHome: home, agentsHome: path.join(home, 'agents'), owners: new Map([['root-id', 123], ['child-id', 123]]), cache: new Map() };
}

test('native catalog and status distinguish concurrent main/subagent work using allowlisted metadata', async t => {
  const options = await fixture(t);
  const rows = readThreadMetadata(options.codexHome, ['root-id']);
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
  const status = await readCodexStatus(options);
  assert.equal(status.connected, true);
  assert.equal(status.agents.length, 2);
  assert.equal(status.agents.find(agent => agent.id === 'root-id').status, 'working');
  const child = status.agents.find(agent => agent.id === 'child-id');
  assert.equal(child.status, 'idle');
  assert.equal(child.isSubagent, true);
  assert.equal(child.agentType, 'reviewer');
  assert.equal(child.name, 'Curie');
  assert.equal(child.parentSessionId, 'root-id');
  assert.equal(status.skills[0].description, 'Build and verify a local project.');
  assert.ok(!JSON.stringify(status).includes('PRIVATE'));
  assert.ok(status.agents.every(agent => !Object.hasOwn(agent, 'pid') && !Object.hasOwn(agent, 'rollout_path')));
  options.owners.delete('root-id');
  assert.equal((await readCodexStatus(options)).agents.find(agent => agent.id === 'root-id').status, 'offline');
});

test('incremental reads retain only sanitized state and wait for complete appended records', async t => {
  const options = await fixture(t);
  await readCodexStatus(options);
  const file = path.join(options.codexHome, 'sessions', 'root-id.jsonl');
  const completion = line(record('task_complete', 4000, { last_agent_message: 'PRIVATE_CONTENT' }));
  await appendFile(file, completion.slice(0, -6));
  assert.equal((await readCodexStatus(options)).agents.find(agent => agent.id === 'root-id').status, 'working');
  await appendFile(file, completion.slice(-6));
  assert.equal((await readCodexStatus(options)).agents.find(agent => agent.id === 'root-id').status, 'idle');
  assert.ok(!JSON.stringify([...options.cache.values()]).includes('PRIVATE'));
});

test('rollout paths outside Codex sessions and ancestor symlinks are rejected', async t => {
  const options = await fixture(t);
  const external = path.join(options.codexHome, 'outside');
  await mkdir(external);
  await writeFile(path.join(external, 'private.jsonl'), line(record('task_started', 1000)));
  await symlink(external, path.join(options.codexHome, 'sessions', 'escape'));
  const database = new DatabaseSync(path.join(options.codexHome, 'state_5.sqlite'));
  database.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path.join(options.codexHome, 'sessions', 'escape', 'private.jsonl'), 'root-id');
  database.close();
  const root = (await readCodexStatus(options)).agents.find(agent => agent.id === 'root-id');
  assert.equal(root.observed, false);
  assert.equal(root.status, 'idle');
});

test('skills honor CODEX_HOME and enabled plugins while disabled plugins remain excluded', async t => {
  const options = await fixture(t);
  await mkdir(path.join(options.codexHome, 'skills', 'local'), { recursive: true });
  await writeFile(path.join(options.codexHome, 'skills', 'local', 'SKILL.md'), '---\nname: Local\ndescription: Local skill\n---\n');
  for (const name of ['enabled', 'disabled']) {
    const directory = path.join(options.codexHome, 'plugins', 'cache', 'market', name, '1.0.0', 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Plugin skill\n---\n`);
  }
  await writeFile(path.join(options.codexHome, 'config.toml'), '[plugins."enabled@market"]\nenabled = true\n[plugins."disabled@market"]\nenabled = false\n');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = options.codexHome;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const skills = await discoverCodexSkills({ agentsHome: options.agentsHome });
  assert.equal(skills.length, 3);
  assert.ok(skills.some(skill => skill.source === 'enabled@market'));
  assert.ok(!skills.some(skill => skill.source === 'disabled@market'));
});

test('status endpoint is read-only and enforces loopback and same origin', async t => {
  const options = await fixture(t);
  let middleware;
  codexBridge(options).configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  async function request(extra = {}) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(text) { body = text; } };
    await middleware({ url: '/api/codex/status', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5173' }, ...extra }, response, () => assert.fail('Expected status endpoint'));
    return { status: response.statusCode, body: JSON.parse(body) };
  }
  assert.equal((await request()).status, 200);
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ socket: { remoteAddress: '10.0.0.1' } })).status, 403);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request({ headers: { host: 'evil.example' } })).status, 403);
});


test('held writer locks awaiting catalog insertion remain individually unknown without claiming execution', async t => {
  const options = await fixture(t);
  const missing = new Map([['not-yet-catalogued', 123]]);
  const partial = await readCodexStatus({ ...options, owners: missing });
  assert.equal(partial.metadataAvailable, true);
  assert.equal(partial.connected, true);
  assert.equal(partial.catalogComplete, false);
  assert.equal(partial.sourceHealth.missingThreadRecords, 1);
  assert.equal(partial.sourceHealth.unreadableRollouts, 0);
  assert.equal(partial.agents.length, 1);
  assert.equal(partial.agents[0].status, 'unconfirmed');
  assert.equal(partial.agents[0].executionState, 'unconfirmed');
  assert.equal(partial.agents[0].observed, false);
  assert.equal(partial.agents[0].threadMetadataAvailable, false);
  await rm(path.join(options.codexHome, 'state_5.sqlite'));
  const unavailable = await readCodexStatus(options);
  assert.equal(unavailable.metadataAvailable, false);
  assert.equal(unavailable.connected, false);
  assert.deepEqual(unavailable.agents, []);
});

test('loaded Codex sessions without readable lifecycle are unconfirmed, then recover from actual turn events', async t => {
  const options = await fixture(t);
  const file = path.join(options.codexHome, 'sessions', 'root-id.jsonl');
  await rm(file);
  let status = await readCodexStatus(options);
  let root = status.agents.find(agent => agent.id === 'root-id');
  assert.equal(root.executionState, 'unconfirmed');
  assert.equal(root.lifecycleSourceAvailable, false);
  assert.equal(root.lastEventAt, null);
  assert.equal(root.activityPhase, 'session-detected');
  assert.equal(status.sourceHealth.unreadableRollouts, 1);
  await writeFile(file, line(record('turn_started', 5000)));
  status = await readCodexStatus(options);
  root = status.agents.find(agent => agent.id === 'root-id');
  assert.equal(root.executionState, 'working');
  assert.equal(root.lifecycleSourceAvailable, true);
  assert.equal(root.lastEventAt, '1970-01-01T00:00:05.000Z');
  assert.equal(status.sourceHealth.unreadableRollouts, 0);
});

test('unreadable catalog with no held locks cannot report a healthy empty observation', async t => {
  const options = await fixture(t);
  await rm(path.join(options.codexHome, 'state_5.sqlite'));
  const status = await readCodexStatus({ ...options, owners: new Map() });
  assert.equal(status.metadataAvailable, false);
  assert.equal(status.sourceHealth.threadMetadata, false);
});


test('one newly locked uncatalogued thread does not hide another known running agent', async t => {
  const options = await fixture(t);
  options.owners.set('new-child', 123);
  let status = await readCodexStatus(options);
  const root = status.agents.find(agent => agent.id === 'root-id');
  assert.equal(status.metadataAvailable, true);
  assert.equal(status.connected, true);
  assert.equal(status.catalogComplete, false);
  assert.equal(status.sourceHealth.catalogComplete, false);
  assert.equal(status.sourceHealth.missingThreadRecords, 1);
  assert.equal(root.executionState, 'working');
  assert.equal(root.observed, true);
  assert.equal(root.lifecycleSourceAvailable, true);
  assert.equal(status.agents.find(agent => agent.id === 'new-child').executionState, 'unconfirmed');
  assert.ok(status.agents.every(agent => !Object.hasOwn(agent, 'pid')));
  options.owners.delete('new-child');
  status = await readCodexStatus(options);
  assert.equal(status.catalogComplete, true);
  assert.equal(status.sourceHealth.missingThreadRecords, 0);
  assert.equal(status.agents.some(agent => agent.id === 'new-child'), false);
  assert.equal(status.agents.find(agent => agent.id === 'root-id').executionState, 'working');
});

test('actual writer-lock outage remains unavailable even with readable cached thread activity', async t => {
  const options = await fixture(t);
  await readCodexStatus(options);
  const status = await readCodexStatus({ ...options, owners: undefined });
  assert.equal(status.metadataAvailable, false);
  assert.equal(status.connected, false);
  assert.equal(status.catalogComplete, false);
  assert.equal(status.sourceHealth.writerLocks, false);
  assert.equal(status.sourceHealth.threadMetadata, true);
  assert.ok(status.agents.every(agent => agent.status === 'offline'));
});


test('agents view omits skill catalog without changing native execution evidence or cached default response', async t => {
  const options = await fixture(t);
  let middleware;
  codexBridge(options).configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  async function request(url = '/api/codex/status', extra = {}) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(text) { body = text; } };
    await middleware({ url, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5173' }, ...extra }, response, () => assert.fail('Expected status endpoint'));
    return { status: response.statusCode, body: JSON.parse(body) };
  }
  const full = (await request()).body;
  assert.equal(full.skills.length, 1);
  const compact = await request('/api/codex/status?view=agents');
  assert.equal(compact.status, 200);
  assert.equal(Object.hasOwn(compact.body, 'skills'), false);
  assert.deepEqual(compact.body.agents, full.agents);
  assert.deepEqual(compact.body.sourceHealth, full.sourceHealth);
  for (const key of ['connected', 'metadataAvailable', 'catalogComplete', 'observedAt', 'lastEventAt', 'liveAgentCount']) assert.deepEqual(compact.body[key], full[key], key);
  assert.deepEqual((await request()).body, full, 'projection must not mutate the cached full status');
  assert.deepEqual((await request('/api/codex/status?view=unknown')).body, full);
  assert.deepEqual((await request('/api/codex/status?view=agents-extra')).body, full);
  assert.deepEqual((await request('/api/codex/status?unknown=agents')).body, full);
  assert.equal((await request('/api/codex/status?view=agents', { method: 'POST' })).status, 405);
  assert.equal((await request('/api/codex/status?view=agents', { socket: { remoteAddress: '10.0.0.1' } })).status, 403);
  assert.equal((await request('/api/codex/status?view=agents', { headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } })).status, 403);
});


test('compact view stays limited to status and honors disabled bridge configuration', async () => {
  let middleware;
  codexBridge({ enabled: false }).configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  async function request(url) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(text) { body = JSON.parse(text); } };
    await middleware({ url, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5173' } }, response, () => assert.fail('Expected Codex endpoint'));
    assert.equal(response.statusCode, 200);
    return body;
  }
  const expected = { connected: false, enabled: false, agents: [], skills: [], error: null };
  assert.deepEqual(await request('/api/codex/status'), expected);
  assert.deepEqual(await request('/api/codex/status?view=agents'), { connected: false, enabled: false, agents: [], error: null, totalAgentCount: 0, omittedOfflineCount: 0 });
  assert.deepEqual(await request('/api/codex/workspace?view=agents'), expected);
});
