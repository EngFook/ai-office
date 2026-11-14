import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { officeServices } from '../server/office-services.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { createGrokWake } from '../server/grok-wake.mjs';
import { validateOfficeConfig } from '../server/office-config.mjs';
import { runOfficeBoardCommand } from '../scripts/office-board.mjs';

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail('The isolated patrol service did not reach its expected state.');
}

test('configured office wakes a real patrol cycle on listening and confirms only actual CLI handling', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-grok-patrol-service-'));
  let server, plugin, stopped = false;
  t.after(async () => {
    if (!stopped) {
      server?.closeAllConnections();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      await plugin?.closeBundle();
    }
    await rm(home, { recursive: true, force: true });
  });
  const configuration = validateOfficeConfig({ mode: 'enabled', dataDir: home, workspace: home, providers: { 'grok-bot': { enabled: true } } });
  const seed = createTaskStore({ home, researchDir: path.join(home, 'research'), crossReview: false });
  let blocked;
  try {
    const task = seed.createTask({ title: 'Isolated blocked build', provider: 'codex', projectPath: home });
    const claim = seed.claimTask({ id: 'fixture-worker', provider: 'codex', projectPath: home }, { taskId: task.id });
    blocked = seed.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'The agent ended without a structured completion confirmation.' });
    seed.updateSettings({ autoPickup: false });
  } finally { seed.close(); }
  await writeFile(path.join(home, 'grok-blocked-patrol-config.json'), JSON.stringify({ version: 1, enabled: true, intervalMs: 600000 }), { mode: 0o600 });
  const wakeConfig = createGrokWake({ home, env: {} });
  wakeConfig.configure({ url: 'https://api2.cursor.sh/fixture-patrol-only', token: 'fixture-patrol-token' });
  await wakeConfig.stop();
  const wakes = [];
  let middleware, modelCalls = 0, stoppedCount = 0, clock = Date.now();
  plugin = officeServices({ configuration, relayIntervalMs: 10, grokPatrol: { now: () => clock },
    runner: { env: {}, probeProviders: async () => ({}), spawnProcess: () => { modelCalls++; throw new Error('The service test must not spawn a model.'); }, quotaReader: () => ({}) },
    grokWake: { env: {}, fetchImpl: async (_url, options) => { wakes.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } },
    onStop: () => { stoppedCount++; },
  });
  server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end('{}'); }));
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { middleware = value; } } });
  assert.equal(wakes.length, 0, 'a patrol must wait for a usable local command URL');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (args, input) => runOfficeBoardCommand({ args, environment: { AI_OFFICE_URL: base }, readInput: async () => input });
  const awaiting = await eventually(async () => { const board = await run(['status']); return board.grokPatrol.phase === 'awaiting_bot' && board; });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].event, 'office.blocked_tasks.pending');
  assert.equal(wakes[0].officeUrl, base);
  assert.ok(wakes[0].commandInterface.commands.includes('blocked-tasks'));
  assert.ok(wakes[0].commandInterface.commands.includes('handle-blocked-task'));
  assert.equal(awaiting.settings.autoPickup, false);
  assert.equal(awaiting.grokPatrol.enabled, true);
  assert.equal(awaiting.grokPatrol.started, true);
  assert.equal(awaiting.grokPatrol.intervalMs, 600000);
  assert.equal(awaiting.grokPatrol.lastHandledAt, null);
  assert.equal(awaiting.grokPatrol.lastReadAt, null);
  assert.equal(Date.parse(awaiting.grokPatrol.nextCheckAt) - Date.parse(awaiting.grokPatrol.lastRequestedAt), 600000);
  assert.equal(awaiting.tasks.find(task => task.id === blocked.id).status, 'blocked');
  const pending = await run(['blocked-tasks']);
  assert.equal(pending.cycleId, wakes[0].cycleIds[0]);
  const current = pending.tasks.find(task => task.id === blocked.id);
  assert.equal(current.version, blocked.version);
  assert.deepEqual(current.allowedActions, ['wait']);
  assert.equal((await run(['status'])).grokPatrol.lastHandledAt, null, 'reading is not handling');
  clock += 1000;
  const reason = 'Auto pickup is paused; retain the existing task until the owner resumes execution.';
  const receipt = await run(['handle-blocked-task', current.id], { source: 'grok-bot', cycleId: pending.cycleId, version: current.version, fingerprint: current.fingerprint, action: 'wait', reason, evidence: 'Observed settings.autoPickup=false and current allowedActions=[wait].' });
  assert.equal(receipt.applied, false);
  const handled = await run(['status']);
  assert.ok(Number.isFinite(Date.parse(handled.grokPatrol.lastReadAt)));
  assert.equal(handled.grokPatrol.lastHandledAt, new Date(clock).toISOString());
  assert.equal(handled.grokPatrol.phase, 'watching');
  assert.equal(handled.grokPatrol.lastResult.reason, reason);
  assert.equal(handled.grokPatrol.lastResult.action, 'wait');
  assert.equal(handled.tasks.find(task => task.id === blocked.id).status, 'blocked');
  assert.equal(handled.tasks.find(task => task.id === blocked.id).version, blocked.version);
  assert.equal(handled.tasks.length, 1, 'a waiting decision must not invent a follow-up task');
  await assert.rejects(run(['handle-blocked-task', current.id], { source: 'grok-bot', cycleId: pending.cycleId, version: current.version, fingerprint: current.fingerprint, action: 'wait', reason, evidence: 'Repeated receipt.' }), /409/);
  await delay(30);
  assert.equal(wakes.length, 1, 'ordinary relay ticks must not repeat the accepted patrol wake');
  assert.equal(modelCalls, 0);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await plugin.closeBundle();
  stopped = true;
  assert.equal(stoppedCount, 1);
  await assert.rejects(readFile(path.join(home, 'grok-blocked-patrol.lock')), { code: 'ENOENT' });
  const saved = JSON.parse(await readFile(path.join(home, 'grok-blocked-patrol.json'), 'utf8'));
  assert.equal(saved.lastHandledAt, handled.grokPatrol.lastHandledAt);
  assert.equal(saved.lastResult.reason, reason);
  assert.equal(wakes.length, 1);
});
