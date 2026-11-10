import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTaskStore, reviewTaskFor } from '../server/task-store.mjs';
import { createTaskRunner, routeTask, weeklyRemaining, geminiAuthenticated, taskPrompt, probeTaskProviders, geminiModelFor } from '../server/task-runner.mjs';
import { parseGeminiStats } from '../server/usage-bridge.mjs';
import { createSharedLayout, WORKSTATION_COUNTS } from '../src/shared-layout.js';

async function fixture(t, extra = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-gemini-')));
  const projectPath = path.join(home, 'project'), researchDir = path.join(home, 'research');
  await mkdir(projectPath);
  const store = createTaskStore({ home, researchDir, ...extra });
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  return { home, projectPath, researchDir, store };
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.pid = 999999; child.exitCode = null; child.signalCode = null;
  child.stdinText = ''; child.stdin.on('data', d => { child.stdinText += d; });
  child.event = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.close = (code = 0) => { child.exitCode = code; child.stdout.end(); setImmediate(() => child.emit('close', code)); };
  return child;
}
const ready = path => ({ available: true, authenticated: true, label: path, reason: null, path: `/bin/${path}` });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('Gemini tasks are research tasks locked to the notes folder, never the product repo', async t => {
  const { store, projectPath, researchDir } = await fixture(t);
  const task = store.createTask({ title: 'Research: Flutter version', provider: 'gemini', projectPath });
  assert.equal(task.kind, 'research');
  assert.equal(task.projectPath, researchDir);
  assert.notEqual(task.projectPath, projectPath);
});

test('finished Claude work queues a Codex review, Codex work a Claude review, never self review', async t => {
  const { store, projectPath } = await fixture(t);
  for (const [author, reviewer] of [['claude', 'codex'], ['codex', 'claude']]) {
    const task = store.createTask({ title: `Feature by ${author}`, provider: author, projectPath });
    const claim = store.claimTask({ id: `w-${author}`, provider: author, roles: ['any'], projectPath }, { taskId: task.id });
    store.finishTask(task.id, claim.claimToken, { status: 'done', result: 'Implemented.' });
    if (author === 'claude') {
      assert.equal(store.snapshot().tasks.some(item => item.id === `${task.id}:prereview` || item.provider === 'gemini'), false, 'Gemini does research only: no pre-review');
    }
    const review = store.snapshot().tasks.find(item => item.reviewOf === task.id);
    assert.doesNotMatch(review.description, /Gemini pre-review/);
    assert.equal(review.provider, reviewer);
    assert.equal(review.kind, 'review');
    assert.equal(review.priority, author === 'claude' ? 'normal' : 'high');
    assert.match(review.description, /Do NOT rewrite/);
    // A finished review never spawns another review.
    const reviewClaim = store.claimTask({ id: `r-${reviewer}`, provider: reviewer, roles: ['any'], projectPath }, { taskId: review.id });
    store.finishTask(review.id, reviewClaim.claimToken, { status: 'done', result: 'APPROVED' });
    assert.equal(store.snapshot().tasks.filter(item => item.reviewOf === review.id).length, 0);
  }
  assert.equal(reviewTaskFor({ status: 'blocked', kind: 'task', assignee: { provider: 'claude' }, projectPath }), null);
});

test('quota routing: Codex has no limit until exhausted, Claude keeps the 20% rule, never self-reviews', () => {
  const quota = { codex: { windows: [{ name: '5-hour', remainingPercent: 90 }, { name: 'Weekly', remainingPercent: 11 }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 53 }, { name: 'Weekly · Fable', remainingPercent: 84 }] } };
  assert.equal(weeklyRemaining(quota, 'codex'), 11);
  assert.equal(weeklyRemaining(quota, 'claude'), 53);
  assert.deepEqual(routeTask({ provider: 'any', priority: 'normal' }, quota).eligible, ['codex', 'claude']);
  assert.deepEqual(routeTask({ provider: 'codex', priority: 'normal' }, quota), { eligible: ['codex'] }, 'low Codex still works');
  assert.deepEqual(routeTask({ provider: 'codex', priority: 'normal', kind: 'review' }, quota).eligible, ['codex'], 'low Codex still reviews');
  const out = { codex: { windows: [{ name: 'Weekly', remainingPercent: 0 }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 53 }] } };
  assert.deepEqual(routeTask({ provider: 'any', priority: 'normal' }, out).eligible, ['claude']);
  assert.deepEqual(routeTask({ provider: 'codex', priority: 'normal' }, out), { eligible: ['claude'], reroute: 'claude' });
  assert.deepEqual(routeTask({ provider: 'codex', priority: 'high', kind: 'review' }, out).eligible, [], 'exhausted Codex review waits, never self-reviewed by Claude');
  assert.deepEqual(routeTask({ provider: 'any', priority: 'normal' }, null).eligible, ['codex', 'claude']);
  const bothLow = { codex: { windows: [{ name: 'Weekly', remainingPercent: 0 }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 10 }] } };
  assert.equal(routeTask({ provider: 'claude', priority: 'low' }, bothLow).eligible.length, 0);
});

test('runner reroutes normal work away from an exhausted Codex', async t => {
  const { store, projectPath } = await fixture(t);
  store.createTask({ title: 'Normal work', provider: 'codex', projectPath });
  const spawned = [];
  const runner = createTaskRunner({ store, probeProviders: async () => ({ codex: ready('codex'), claude: ready('claude'), gemini: { available: true, authenticated: false, path: '/bin/gemini', needsLogin: true } }),
    spawnProcess: (file) => { const child = fakeChild(); spawned.push({ file, child }); return child; }, pollIntervalMs: 100000,
    quotaReader: () => ({ codex: { windows: [{ name: 'Weekly', remainingPercent: 0 }] } }) });
  t.after(() => runner.stop());
  await runner.start();
  assert.equal(spawned[0].file, '/bin/claude');
  assert.equal(store.snapshot().tasks[0].assignee.provider, 'claude');
  assert.equal(runner.status().providers.gemini.needsLogin, true);
  assert.match(spawned[0].child.stdinText, /Research first/);
  assert.match(runner.status().active.label, /实际同时工作: 1 写代码 \+ 0 审查 \+ 0 研究/);
});

test('Gemini research runs read-only alongside coding work and the runner saves the note', async t => {
  const { store, projectPath, researchDir } = await fixture(t);
  store.createTask({ title: 'Code it', provider: 'claude', projectPath });
  const research = store.createTask({ title: 'Research: Riverpod 3 changes', provider: 'gemini', description: 'What changed?' });
  const spawned = [];
  const runner = createTaskRunner({ store, probeProviders: async () => ({ codex: ready('codex'), claude: ready('claude'), gemini: ready('gemini') }),
    spawnProcess: (file, args, options) => { const child = fakeChild(); spawned.push({ file, args, options, child }); return child; }, pollIntervalMs: 100000 });
  t.after(() => runner.stop());
  await runner.start();
  assert.equal(spawned.length, 2, 'research does not wait for the coding lock');
  const gemini = spawned.find(item => item.file === '/bin/gemini');
  assert.equal(gemini.options.cwd, researchDir);
  assert.ok(!gemini.args.includes('--yolo') && !gemini.args.includes('-y'));
  assert.equal(gemini.args[gemini.args.indexOf('--mode') + 1], 'plan', 'agy runs read-only plan mode');
  assert.equal(gemini.args[gemini.args.indexOf('--model') + 1], 'gemini-4-argon-medium');
  assert.equal(gemini.args[gemini.args.indexOf('--output-format') + 1], 'json');
  assert.ok(!gemini.args.includes('--dangerously-skip-permissions'));
  assert.ok(!gemini.args.includes('--disable-slash-commands'), 'that flag silently disables plan mode');
  assert.ok(!gemini.args.join(' ').includes(projectPath));
  assert.ok(!Object.keys(gemini.options.env).some(k => /GEMINI_API_KEY|GOOGLE_API_KEY/.test(k)));
  assert.match(gemini.args[gemini.args.indexOf('-p') + 1], /read-only/);
  assert.equal(runner.status().active.research, 1);
  gemini.child.event({ conversation_id: 'gem-1', status: 'SUCCESS', response: '## Answer\nRiverpod 3 adds X. [src](https://example.com)', usage: { total_tokens: 10 } });
  gemini.child.close();
  await settle();
  const done = store.snapshot().tasks.find(task => task.id === research.id);
  assert.equal(done.status, 'done');
  const files = await readdir(researchDir);
  assert.equal(files.length, 1);
  assert.match(await readFile(path.join(researchDir, files[0]), 'utf8'), /Riverpod 3 adds X/);
  assert.equal(store.snapshot().tasks.filter(task => task.reviewOf === research.id).length, 0, 'research is not cross reviewed');
});

test('Gemini (agy) login uses the subscription sign-in check, never API keys', async t => {
  assert.equal(await geminiAuthenticated({ geminiPath: '/x/agy', check: async () => false }), false);
  assert.equal(await geminiAuthenticated({ geminiPath: '/x/agy', check: async () => true }), true);
  const probe = await probeTaskProviders({ env: { PATH: '', GEMINI_API_KEY: 'ignored' }, geminiPath: process.execPath, geminiCheck: async () => false, codexPath: '/nonexistent', claudePath: '/nonexistent' });
  assert.equal(probe.gemini.needsLogin, true);
  assert.match(probe.gemini.reason, /Needs login/);
  assert.equal(geminiModelFor({ priority: 'high' }), 'gemini-4-argon-high');
  assert.equal(geminiModelFor({ priority: 'normal' }), 'gemini-4-argon-medium');
  assert.match(taskPrompt({ provider: 'gemini', title: 'x', description: 'y' }), /research/);
});

test('Gemini stats parsing and the 4-desk research room keep the approved floor intact', () => {
  assert.deepEqual(parseGeminiStats('gemini-2.5-pro   12 reqs   80% left (resets in 5h)').map(w => w.remainingPercent), [80]);
  const layout = createSharedLayout([]);
  assert.equal(WORKSTATION_COUNTS.gemini, 4);
  assert.equal(layout.desks.filter(desk => desk.zone === 'gemini').length, 4);
  assert.equal(layout.desks.filter(desk => desk.zone === 'claude').length, 20);
  assert.equal(layout.desks.filter(desk => desk.zone === 'codex').length, 6);
  assert.equal(layout.desks.filter(desk => desk.zone === 'reviewers').length, 4);
  assert.equal(layout.zones.find(zone => zone.id === 'gemini').department, 'Gemini Research');
});

import { codexTier, isBalance } from '../server/division-policy.mjs';
test('approved division: Codex owns balance (no quota limit until exhausted), Gemini never does balance or reviews', () => {
  const q = left => ({ codex: { windows: [{ name: 'Weekly', remainingPercent: left }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 52 }] } });
  assert.equal(codexTier(11), 'low'); assert.equal(codexTier(4), 'critical'); assert.equal(codexTier(null), 'normal');
  assert.ok(isBalance({ title: 'Tune enemy balance' }));
  assert.deepEqual(routeTask({ provider: 'claude', title: 'Balance pass on drop rate' }, q(60)), { eligible: ['codex'], reroute: 'codex' });
  assert.deepEqual(routeTask({ provider: 'codex', title: 'Balance pass', priority: 'normal' }, q(4)).eligible, ['codex'], 'low Codex still does balance');
  assert.deepEqual(routeTask({ provider: 'codex', title: 'Balance pass', priority: 'high' }, q(0)).eligible, [], 'balance waits, never rerouted to Claude');
  assert.deepEqual(routeTask({ provider: 'gemini', title: 'Research: balance numbers' }, q(60)).eligible, []);
  assert.deepEqual(routeTask({ provider: 'gemini', title: 'Pre-review: x' }, q(60)).eligible, [], 'Gemini never pre-reviews');
  assert.deepEqual(routeTask({ provider: 'gemini', kind: 'review', title: 'Review: x' }, q(60)).eligible, [], 'Gemini never reviews');
  assert.deepEqual(routeTask({ provider: 'gemini', title: 'Research: Flutter 4 changes' }, q(60)).eligible, ['gemini']);
  const ordinary = { provider: 'codex', kind: 'review', priority: 'normal', title: 'Review: new dialog', description: 'Risk: ordinary' };
  for (const r of [60, 11, 4]) assert.deepEqual(routeTask(ordinary, q(r)).eligible, ['codex'], `codex ${r}%`);
  assert.deepEqual(routeTask(ordinary, q(0)).eligible, []);
  assert.match(routeTask(ordinary, q(0)).reason, /exhausted/);
  assert.deepEqual(routeTask({ provider: 'codex', title: 'Fix crash', priority: 'high' }, q(0)), { eligible: ['claude'], reroute: 'claude' });
});

test('regression 945aa16c: explicit Claude UI task mentioning "Balance" in its description stays on Claude even when Codex is low', () => {
  const q = left => ({ codex: { windows: [{ name: 'Weekly', remainingPercent: left }] }, claude: { windows: [{ name: 'Weekly', remainingPercent: 70 }] } });
  const ui = { provider: 'claude', priority: 'high', title: 'UI redesign U1–U8 + renames R1–R23 (approved)',
    description: 'R2 = Codex Review & Balance / Codex 审查与平衡; update difficulty-free labels; do not change routing.' };
  for (const r of [60, 11, 4]) assert.deepEqual(routeTask(ui, q(r)), { eligible: ['claude'] }, `codex ${r}%`);
  assert.ok(!isBalance({ title: 'Rename to Codex Review & Balance' }));
  assert.ok(isBalance({ title: 'Loot tweaks', description: 'Type: balance' }));
});


test('snapshot regression: exhausted independent reviews never reroute to either author', () => {
  for (const reviewer of ['codex', 'claude']) {
    const other = reviewer === 'codex' ? 'claude' : 'codex';
    const quota = { [reviewer]: { windows: [{ name: 'Weekly', remainingPercent: 0 }] }, [other]: { windows: [{ name: 'Weekly', remainingPercent: 100 }] } };
    for (const priority of ['normal', 'high']) {
      const result = routeTask({ kind: 'review', provider: reviewer, priority, reviewOf: 'fixture-author-task' }, quota);
      assert.deepEqual(result.eligible, []);
      assert.equal(result.reroute, undefined);
      assert.match(result.reason, /exhausted/);
    }
  }
});
