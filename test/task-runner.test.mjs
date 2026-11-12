import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskStore } from '../server/task-store.mjs';
import { createTaskRunner, geminiAuthenticated } from '../server/task-runner.mjs';

const authenticated = { codex: { available: true, authenticated: true, path: '/mock/codex' }, claude: { available: true, authenticated: true, path: '/mock/claude' } };

test('configured offices keep CLI permission boundaries instead of bypassing approvals and sandbox', async t => {
  const f=await fixture(t,{runner:{providers:{claude:{enabled:true},codex:{enabled:true}}}});
  f.store.createTask({title:'Codex configured task',provider:'codex',projectPath:f.project});
  f.store.createTask({title:'Claude configured task',provider:'claude',projectPath:f.secondProject});
  await f.runner.start();
  assert.equal(f.calls.length,2);
  for(const call of f.calls)assert.equal(call.args.some(arg=>arg.startsWith('--dangerously-')),false);
  const codex=f.calls.find(call=>call.binary==='/mock/codex').args;
  assert.equal(codex[codex.indexOf('--sandbox')+1],'workspace-write');
  assert.ok(codex.includes('approval_policy="never"'));
  const claude=f.calls.find(call=>call.binary==='/mock/claude').args;
  assert.equal(claude[claude.indexOf('--permission-mode')+1],'dontAsk');
});

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "office task runner's ")));
  const project = path.join(directory, 'project');
  const secondProject = path.join(directory, 'second-project');
  await mkdir(project); await mkdir(secondProject);
  const store = createTaskStore({ home: path.join(directory, 'board'), researchDir: path.join(directory, 'research') });
  store.updateSettings({ autoPickup: true });
  const calls = [], signals = [];
  const spawnProcess = (binary, args, launchOptions) => {
    const child = new EventEmitter();
    child.pid = 100000 + calls.length;
    child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.prompt = '';
    child.stdin = new Writable({ write(chunk, encoding, done) { child.prompt += chunk.toString(); done(); } });
    child.event = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.close = (code = 0) => { child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    calls.push({ binary, args, options: launchOptions, child });
    return child;
  };
  const terminate = (child, signal) => {
    signals.push({ pid: child.pid, signal });
    if (!options.ignoreSignals) child.close(143);
  };
  const runner = createTaskRunner({ store, spawnProcess, terminate, probeProviders: async () => options.providers || authenticated, pollIntervalMs: 10000, heartbeatMs: 10, taskTimeoutMs: 10000, killGraceMs: 5, env: { PATH: '/mock', XAI_API_KEY: 'never-pass-xai', GROK_API_KEY: 'never-pass-grok', GROK_BOT_WEBHOOK_URL: 'https://api2.cursor.sh/fixture-private-hook', GROK_BOT_WEBHOOK_AUTH: 'Bearer fixture-only-webhook-token', AI_OFFICE_CREDENTIALS_FILE: '/private/office', CODEX_TEST_VALUE: 'keep' }, ...options.runner });
  t.after(async () => { await runner.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, project, secondProject, store, runner, calls, signals };
}

test('real store claims launch bounded CLI work without shell interpolation, private logs or credentials', async t => {
  const { project, store, runner, calls } = await fixture(t);
  const task = store.createTask({ title: 'Fix $(touch should-not-run)', description: 'Complete the assigned change.', projectPath: project, provider: 'codex' });
  await runner.start();
  assert.equal(calls.length, 1);
  const { child, args, options } = calls[0];
  assert.deepEqual(args, ['exec', '--json', '-c', 'agents.enabled=true', '-c', 'agents.max_concurrent_threads_per_session=2', '-c', 'model_reasoning_effort="high"', '--dangerously-bypass-approvals-and-sandbox', '-C', project, '-']);
  assert.equal(options.shell, false);
  assert.equal(options.cwd, project);
  assert.equal(options.detached, process.platform !== 'win32');
  assert.ok(child.prompt.includes(task.title));
  assert.ok(child.prompt.includes('"status":"done" or "blocked"'));
  assert.equal(options.env.XAI_API_KEY, undefined);
  assert.equal(options.env.GROK_API_KEY, undefined);
  assert.equal(options.env.GROK_BOT_WEBHOOK_URL, undefined);
  assert.equal(options.env.GROK_BOT_WEBHOOK_AUTH, undefined);
  assert.equal(options.env.AI_OFFICE_CREDENTIALS_FILE, undefined);
  assert.equal(options.env.CODEX_TEST_VALUE, 'keep');
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'running');
  const initial = runner.status();
  assert.equal(initial.running[0].workerId, store.snapshot().tasks.find(task => task.kind !== 'review').assignee.id);
  assert.equal(initial.agents.length, 0, 'a spawned process is not a fabricated agent identity');
  assert.equal(initial.providers.codex.path, undefined);
  child.event({ type: 'thread.started', thread_id: 'native-session-123' });
  child.event({ type: 'item.completed', item: { type: 'command_execution', command: 'private-command', aggregated_output: 'private-output' } });
  child.stderr.write('private-auth-provider-diagnostic');
  assert.equal(runner.status().agents[0].id, 'native-session-123');
  assert.equal(runner.status().running[0].sessionId, 'native-session-123');
  assert.equal(runner.status().running[0].pid, undefined);
  assert.ok(!JSON.stringify(runner.status()).includes('private-command'));
  assert.ok(!JSON.stringify(runner.status()).includes('private-output'));
  assert.ok(!JSON.stringify(runner.status()).includes('private-auth-provider-diagnostic'));
  child.event({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'done', summary: 'Implemented the change and verified the result.' }) } });
  child.event({ type: 'turn.completed', usage: { private: 'discarded' } });
  child.close();
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'done');
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').result, 'Implemented the change and verified the result.');
  assert.equal(runner.status().running.length, 0);
  assert.ok(!JSON.stringify(store.snapshot()).includes('private-output'));
});

test('pickup requires an authenticated provider and a supplied existing absolute project folder', async t => {
  const providers = { ...authenticated, claude: { available: true, authenticated: false, path: '/mock/claude', reason: 'Sign in to Claude Code.' } };
  const { directory, project, store, runner, calls } = await fixture(t, { providers });
  const missing = store.createTask({ title: 'No project yet' });
  const invalid = store.createTask({ title: 'Missing folder', projectPath: path.join(directory, 'missing') });
  const unauthenticated = store.createTask({ title: 'Claude task', projectPath: project, provider: 'claude' });
  await runner.start();
  assert.equal(calls.length, 0);
  assert.ok(store.snapshot().tasks.every(task => task.status === 'pending'));
  const pending = runner.status().pending;
  assert.match(pending.find(item => item.taskId === missing.id).reason, /project folder/);
  assert.match(pending.find(item => item.taskId === invalid.id).reason, /does not exist/);
  assert.match(pending.find(item => item.taskId === unauthenticated.id).reason, /authenticated/);
  assert.equal(runner.status().agents.length, 0);
});

test('watchdog progress timestamp advances on output while runner heartbeats alone do not mask a stall', async t => {
  let clock = Date.parse('2026-11-03T02:00:00+08:00');
  const { project, store, runner, calls } = await fixture(t, { runner: { now: () => clock } });
  store.createTask({ title: 'Progress fixture', projectPath: project, provider: 'codex' });
  let heartbeats = 0; const heartbeat = store.heartbeat;
  store.heartbeat = (...args) => { heartbeats++; return heartbeat(...args); };
  await runner.start();
  assert.equal(runner.status().running[0].lastProgressAt, new Date(clock).toISOString());
  clock += 1800000; await delay(25); assert.ok(heartbeats >= 1);
  assert.notEqual(runner.status().running[0].lastProgressAt, new Date(clock).toISOString());
  calls[0].child.event({ type: 'item.started', item: { type: 'command_execution' } });
  assert.equal(runner.status().running[0].lastProgressAt, new Date(clock).toISOString());
});

test('only one task runs per provider and per project, with durable heartbeats', async t => {
  const { project, secondProject, store, runner, calls } = await fixture(t);
  const first = store.createTask({ title: 'First', projectPath: project, provider: 'codex', priority: 'high' });
  store.createTask({ title: 'Same project', projectPath: project, provider: 'claude' });
  store.createTask({ title: 'Other project', projectPath: secondProject, provider: 'claude' });
  store.createTask({ title: 'Codex already busy', projectPath: secondProject, provider: 'codex' });
  let heartbeats = 0;
  const original = store.heartbeat;
  store.heartbeat = (...args) => { heartbeats++; return original(...args); };
  await runner.start();
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map(call => call.options.cwd)).size, 2);
  assert.equal(store.snapshot().tasks.find(task => task.id === first.id).status, 'running');
  assert.equal(store.snapshot().tasks.filter(task => task.status === 'running').length, 2);
  await delay(35);
  assert.ok(heartbeats >= 2);
  assert.equal(runner.status().running.length, 2);
});

test('Claude result events expose native identity and require confirmed task completion', async t => {
  const { project, store, runner, calls } = await fixture(t);
  store.createTask({ title: 'Claude work', projectPath: project, provider: 'claude' });
  await runner.start();
  const { args, child } = calls[0];
  assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
  child.event({ type: 'system', subtype: 'init', session_id: 'claude-session-123' });
  assert.equal(runner.status().agents[0].id, 'claude-session-123:main');
  child.event({ type: 'result', subtype: 'success', session_id: 'claude-session-123', result: JSON.stringify({ status: 'blocked', summary: 'A required edit was not approved.' }) });
  child.close();
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'blocked');
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').result, 'A required edit was not approved.');
});

test('CLI failures and missing completion confirmations block work with safe errors', async t => {
  const { project, store, runner, calls } = await fixture(t);
  store.createTask({ title: 'Failed run', projectPath: project, provider: 'codex' });
  await runner.start();
  calls[0].child.event({ type: 'error', message: 'secret-provider-response' });
  calls[0].child.close(1);
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'blocked');
  assert.ok(!store.snapshot().tasks.find(task => task.kind !== 'review').error.includes('secret'));
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').result, '');
  const second = store.createTask({ title: 'Unconfirmed run', projectPath: project, provider: 'codex' });
  await runner.kick();
  const child = calls.at(-1).child;
  child.event({ type: 'item.completed', item: { type: 'agent_message', text: 'A final response without task completion status.' } });
  child.event({ type: 'turn.completed' });
  child.close();
  assert.equal(store.snapshot().tasks.find(task => task.id === second.id).status, 'blocked');
  assert.match(store.snapshot().tasks.find(task => task.id === second.id).error, /structured completion/);
});

test('timeout stops only owned process groups, blocks the claim, and never retries automatically', async t => {
  const { project, store, runner, calls, signals } = await fixture(t, { ignoreSignals: true, runner: { taskTimeoutMs: 15 } });
  store.createTask({ title: 'Time limited work', projectPath: project, provider: 'codex' });
  await runner.start();
  await delay(45);
  assert.deepEqual(signals.map(item => item.signal), ['SIGTERM', 'SIGKILL']);
  assert.ok(signals.every(item => item.pid === calls[0].child.pid));
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'blocked');
  await runner.kick();
  assert.equal(calls.length, 1);
});

test('stop blocks interrupted tasks durably and disabled pickup keeps pending tasks untouched', async t => {
  const { project, store, runner, calls } = await fixture(t);
  store.createTask({ title: 'Explicit task', projectPath: project, provider: 'codex' });
  store.updateSettings({ autoPickup: false });
  await runner.start();
  assert.equal(calls.length, 0);
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'pending');
  store.updateSettings({ autoPickup: true });
  await runner.kick();
  assert.equal(calls.length, 1);
  await runner.stop();
  assert.equal(store.snapshot().tasks.find(task => task.kind !== 'review').status, 'blocked');
  assert.match(store.snapshot().tasks.find(task => task.kind !== 'review').error, /will not restart automatically/);
  await runner.start();
  assert.equal(calls.length, 1);
});

test('Claude runs up to 3 tasks in parallel, each in its own project folder; Codex runs up to 2', async t => {
  const { directory, project, secondProject, store, runner, calls } = await fixture(t);
  const third = path.join(directory, 'third'), fourth = path.join(directory, 'fourth');
  await mkdir(third); await mkdir(fourth);
  for (const [title, folder] of [['C1', project], ['C2', secondProject], ['C3', third], ['C4', fourth], ['C-same', project]]) store.createTask({ title, projectPath: folder, provider: 'claude' });
  await runner.start();
  const claude = calls.filter(call => call.binary === '/mock/claude');
  assert.equal(claude.length, 3);
  assert.equal(new Set(claude.map(call => call.options.cwd)).size, 3);
  const pending = runner.status().pending.map(item => item.reason);
  assert.ok(pending.some(reason => /finish/.test(reason)));
});

test('maxConcurrentFor clamps bad limits to 1', async () => {
  const { maxConcurrentFor, PROVIDER_CONCURRENCY } = await import('../server/task-runner.mjs');
  assert.equal(PROVIDER_CONCURRENCY.claude, 3);
  assert.equal(maxConcurrentFor('codex'), 2);
  assert.equal(maxConcurrentFor('claude', { claude: 0 }), 1);
  assert.equal(maxConcurrentFor('claude', { claude: 99 }), 8);
});

test('text-only Qwen human reply reaches real local prompt and completes without project filesystem access', async t => {
  const { createLocalQwen } = await import('../server/local-qwen.mjs');
  let qwenClient, prompt, received;
  const started = new Promise(resolve => { received = resolve; });
  const f = await fixture(t, { providers: { 'local-qwen': { available: true, authenticated: true } }, runner: {
    qwenClient: { run: (...args) => qwenClient.run(...args) },
    projectValidator: async () => { assert.fail('Text-only support must not validate or read a project directory.'); },
  } });
  qwenClient = createLocalQwen({ usageFile: path.join(f.directory, 'local-usage.json'), fetchImpl: async (_url, options) => {
    prompt = JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content);
    received();
    return new Response(JSON.stringify({ done: true, message: { content: 'Preliminary fixture startup triage.' }, prompt_eval_count: 12, eval_count: 6, eval_duration: 1000000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const task = f.store.createTask({ title: 'Log triage', provider: 'local-qwen', supportType: 'log-triage', description: 'Source log: startup timed out.', projectPath: '' });
  const claim = f.store.claimTask({ id: 'prior-local', provider: 'local-qwen', roles: ['Helper'] }, { taskId: task.id });
  f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Please provide the missing startup context.' });
  const question = f.store.syncHumanRequests().find(item => item.taskId === task.id);
  f.store.acknowledgeHumanRequest(question.id, { source: 'grok-bot', questionHash: question.questionHash, messageId: 'grok-prompt-delivery' });
  const userReply = 'The fixture was starting in an offline test environment.';
  f.store.answerHumanRequest(question.id, { source: 'grok-bot', replyAuthor: 'user', questionHash: question.questionHash, userMessageId: 'grok-local-info', userReply, decision: 'provide_info' });
  await f.runner.start(); await started;
  for (let i = 0; i < 20 && f.store.snapshot().tasks.find(item => item.id === task.id).status !== 'done'; i++) await delay(5);
  const completed = f.store.snapshot().tasks.find(item => item.id === task.id);
  assert.equal(completed.status, 'done'); assert.equal(completed.projectPath, '');
  assert.equal(prompt.sourceText, task.description); assert.equal(prompt.userClarification.reply, userReply);
  assert.equal(f.calls.length, 0);
});


test('Grok webhook credentials never reach Claude, Codex or Gemini worker processes', async t => {
  const { project, secondProject, store, runner, calls } = await fixture(t, { providers: { ...authenticated, gemini: { available: true, authenticated: true, path: '/mock/gemini' } } });
  store.createTask({ title: 'Claude fixture', provider: 'claude', projectPath: project });
  store.createTask({ title: 'Codex fixture', provider: 'codex', projectPath: secondProject });
  store.createTask({ title: 'Gemini fixture', provider: 'gemini' });
  await runner.start();
  assert.equal(calls.length, 3);
  for (const { options } of calls) {
    assert.equal(options.env.GROK_BOT_WEBHOOK_URL, undefined);
    assert.equal(options.env.GROK_BOT_WEBHOOK_AUTH, undefined);
    assert.equal(options.env.CODEX_TEST_VALUE, 'keep');
  }
});

test('Gemini subscription login probe strips office webhook environment before invoking the CLI', async t => {
  const { directory } = await fixture(t);
  const bin = path.join(directory, 'fake-agy');
  await writeFile(bin, '#!/bin/sh\nif [ -z "$GROK_BOT_WEBHOOK_URL" ] && [ -z "$GROK_BOT_WEBHOOK_AUTH" ]; then echo gemini-fixture; fi\n', { mode: 0o700 });
  assert.equal(await geminiAuthenticated({ geminiPath: bin, env: { PATH: '/usr/bin:/bin', GROK_BOT_WEBHOOK_URL: 'fixture-secret-url', GROK_BOT_WEBHOOK_AUTH: 'Bearer fixture-token' } }), true);
});
