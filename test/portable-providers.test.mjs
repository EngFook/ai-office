import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTaskRunner, probeTaskProviders, routeTask, geminiModelFor, taskPrompt } from '../server/task-runner.mjs';
import { createLocalQwen } from '../server/local-qwen.mjs';
import { createTaskStore } from '../server/task-store.mjs';

async function directory(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'portable providers ')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const providers = { codex: { enabled: true, model: 'configured-model', concurrency: 1 }, claude: { enabled: false }, gemini: { enabled: false }, 'local-qwen': { enabled: false } };

test('explicit disabled providers never probe CLI login or Ollama, even with discoverable commands', async t => {
  const dir = await directory(t), marker = path.join(dir, 'called');
  const command = path.join(dir, 'fake-cli');
  await writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`, { mode: 0o700 });
  let qwenCalls = 0, geminiCalls = 0;
  const result = await probeTaskProviders({ providers: {}, codexPath: command, claudePath: command, geminiPath: command, qwenClient: { probe() { qwenCalls++; } }, geminiCheck() { geminiCalls++; } });
  assert.equal(qwenCalls, 0); assert.equal(geminiCalls, 0);
  assert.ok(Object.values(result).every(value => !value.available && !value.authenticated));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('configured CLI command is found on supplied PATH and uses subscription login without API keys', async t => {
  const dir = await directory(t), command = path.join(dir, 'my-codex');
  await writeFile(command, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'login status') process.exit(1);\n`, { mode: 0o700 });
  const result = await probeTaskProviders({ providers: { codex: { enabled: true, command: 'my-codex' } }, env: { PATH: dir } });
  assert.equal(result.codex.path, command); assert.equal(result.codex.authenticated, true);
  assert.equal(result.claude.available, false);
});

test('disabled author and independent reviewer stay queued; any work uses enabled coders only', () => {
  assert.deepEqual(routeTask({ provider: 'any' }, {}, providers).eligible, ['codex']);
  assert.deepEqual(routeTask({ provider: 'claude' }, {}, providers).eligible, []);
  assert.deepEqual(routeTask({ provider: 'claude', kind: 'review' }, {}, providers).eligible, []);
  assert.deepEqual(routeTask({ provider: 'grok-bot' }, {}, providers).eligible, []);
  assert.equal(geminiModelFor({ priority: 'high' }, { model: 'my-model' }), 'my-model');
  assert.equal(geminiModelFor({ priority: 'high' }, { model: 'my-model', highModel: 'large-model' }), 'large-model');
  assert.ok(!taskPrompt({ provider: 'codex' }, providers).includes('Request a lookup by creating a Gemini'));
});

test('runner enforces configured model, concurrency and disabled-provider filter even with injected auth', async t => {
  const dir = await directory(t);
  const store = createTaskStore({ home: path.join(dir, 'board'), researchDir: path.join(dir, 'research') });
  store.updateSettings({ autoPickup: true });
  for (let i = 0; i < 3; i++) { await mkdir(path.join(dir, `project${i}`)); store.createTask({ title: `ordinary task ${i}`, provider: i === 2 ? 'claude' : 'codex', projectPath: path.join(dir, `project${i}`) }); }
  const calls = [];
  const runner = createTaskRunner({ store, providers,
    probeProviders: async () => ({ codex: { available: true, authenticated: true, path: '/fake/codex' }, claude: { available: true, authenticated: true, path: '/fake/claude' } }),
    projectValidator: async value => ({ valid: true, canonical: value, projectPath: value }),
    spawnProcess(binary, args, options) { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); calls.push({ binary, args, options, child }); return child; },
    terminate(child) { child.emit('close', 143); },
  });
  t.after(async () => { await runner.stop(); store.close(); });
  await runner.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/fake/codex');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'configured-model');
  assert.equal(calls[0].options.shell, false);
  assert.equal(runner.status().providers.claude.authenticated, false);
  assert.ok(runner.status().pending.some(value => /disabled/.test(value.reason)));
});

test('portable Ollama uses configured loopback endpoint/model and private ledger; disabled client makes no requests', async t => {
  const dir = await directory(t), usageFile = path.join(dir, 'usage.json'), calls = [];
  const client = createLocalQwen({ baseUrl: 'http://127.0.0.1:12345', model: 'qwen-custom:7b', timeZone: 'UTC', usageFile,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ done: true, message: { content: 'Check the supplied log.' }, eval_count: 4, prompt_eval_count: 6 })); },
  });
  await client.run({ provider: 'local-qwen', title: 'Log triage', description: 'EACCES', supportType: 'log-triage' });
  assert.equal(calls[0].url, 'http://127.0.0.1:12345/api/chat');
  assert.equal(JSON.parse(calls[0].init.body).model, 'qwen-custom:7b');
  assert.ok((await readFile(usageFile, 'utf8')).includes('"input":6'));
  const disabled = createLocalQwen({ enabled: false, usageFile, fetchImpl: () => assert.fail('disabled client must not fetch') });
  assert.equal((await disabled.probe()).disabled, true);
  await assert.rejects(disabled.run({}), /disabled/);
  await assert.rejects(disabled.discussBlocked({}), /disabled/);
  for (const baseUrl of ['http://example.com:11434', 'http://127.0.0.1.evil.test', 'http://user:pass@localhost:11434', 'http://localhost:11434/other', 'file:///tmp/model']) assert.throws(() => createLocalQwen({ baseUrl }), /loopback/);
});

test('configured routing honors explicit assignments and has no implicit game-specific ownership', () => {
  const config = { claude: { enabled: true }, codex: { enabled: true }, gemini: { enabled: true }, 'local-qwen': { enabled: true } };
  const task = { title: 'Balance the puzzle difficulty', provider: 'claude' };
  assert.deepEqual(routeTask(task, {}, config).eligible, ['claude']);
  assert.deepEqual(routeTask({ ...task, provider: 'any' }, {}, config).eligible, ['claude', 'codex']);
  assert.deepEqual(routeTask({ ...task, provider: 'any' }, {}, config, { workProviders: ['claude'] }).eligible, ['claude']);
  assert.deepEqual(routeTask({ ...task, provider: 'any' }, {}, config, { workProviders: ['claude'], balanceProvider: 'codex' }).eligible, ['codex']);
  assert.deepEqual(routeTask(task, {}, config, { balanceProvider: 'codex' }).eligible, ['claude']);
  assert.deepEqual(routeTask({ provider: 'gemini', title: 'Research: puzzle difficulty', kind: 'research' }, {}, config).eligible, ['gemini']);
  const research = taskPrompt({ provider: 'gemini', kind: 'research', title: 'Puzzle difficulty' }, config);
  assert.doesNotMatch(research, /game balance is owned by Codex/);
  assert.match(research, /assigned research scope/);
  assert.match(taskPrompt(task, config), /configured independent reviewer/);
  assert.deepEqual(routeTask({ provider: 'any', kind: 'research' }, {}, config).eligible, ['gemini']);
  assert.deepEqual(routeTask({ provider: 'gemini', kind: 'review' }, {}, config).eligible, []);
  assert.deepEqual(routeTask({ provider: 'local-qwen', title: 'Implement feature' }, {}, config).eligible, []);
  assert.deepEqual(routeTask({ provider: 'any' }, {}, config, { workProviders: ['gemini', 'local-qwen', 'codex'] }).eligible, ['codex']);
});

test('independent reviewer exhaustion never falls back to its author through routing or recovery', async () => {
  const { quotaRerouteTargets } = await import('../server/resolution-policy.mjs');
  const config = { claude: { enabled: true }, codex: { enabled: true } };
  for (const provider of ['claude', 'codex']) {
    const alternate = provider === 'claude' ? 'codex' : 'claude';
    const quota = { [provider]: { observedAt: Date.now(), windows: [{ name: 'Weekly', remainingPercent: 0 }] }, [alternate]: { observedAt: Date.now(), windows: [{ name: 'Weekly', remainingPercent: 50 }] } };
    const reviews = [
      { id: 'formal', provider, status: 'pending', kind: 'review', priority: 'high' },
      { id: 'linked', provider, status: 'blocked', kind: 'task', reviewOf: 'original' },
      { id: 'title', provider, status: 'pending', title: 'Review: original' },
      { id: 'original:review', provider, status: 'pending' },
    ];
    for (const task of reviews) {
      assert.deepEqual(routeTask(task, quota, config).eligible, []);
      assert.deepEqual(routeTask(task, quota).eligible, []);
    }
    const ordinary = { id: 'ordinary', provider, status: 'pending', title: 'Ordinary work' };
    assert.deepEqual(quotaRerouteTargets([...reviews, ordinary], quota).map(task => task.id), ['ordinary']);
    assert.deepEqual(routeTask(ordinary, quota, config).eligible, [], 'explicit assignment must not silently change');
    assert.deepEqual(routeTask({ ...ordinary, provider: 'any' }, quota, config).eligible, [alternate]);
  }
  assert.deepEqual(routeTask({ provider: 'any', kind: 'review' }, {}, config).eligible, []);
});
