import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, chmod, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGrokWake } from '../server/grok-wake.mjs';
import { humanRequestSpec } from '../server/human-relay-policy.mjs';

const SECRET = 'fixture-private-bearer', URL = 'https://api2.cursor.sh/routines/fixture-private-path/trigger';
const questionFor = id => ({ id, taskId: `task-${id}`, state: 'pending', kind: 'info', question: `Supply the required input for ${id}.` });
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-grok-wake-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ref = { home, at: Date.parse('2026-11-04T12:00:00Z'), calls: [] };
  ref.fetchImpl = async (url, init) => { ref.calls.push({ url, init }); return { ok: true }; };
  ref.options = { home, fetchImpl: ref.fetchImpl, now: () => ref.at, env: {}, ...options };
  ref.wake = createGrokWake(ref.options); t.after(() => ref.wake.stop());
  return ref;
}

test('wake configuration allows only observed HTTPS Grok routine host and never exposes secrets', async t => {
  const f = await fixture(t);
  assert.equal(f.wake.status().configured, false);
  for (const url of ['http://api2.cursor.sh/routine', 'https://other.invalid/routine', 'https://api2.cursor.sh.attacker.invalid/routine', 'https://api2.cursor.sh:8443/routine', 'https://user:secret@api2.cursor.sh/routine', 'https://api2.cursor.sh/', 'https://api2.cursor.sh/routine#secret']) {
    assert.throws(() => f.wake.configure({ url, token: SECRET }), error => !error.message.includes(SECRET) && !error.message.includes(url));
  }
  assert.throws(() => f.wake.configure({ url: URL, token: 'bad\ntoken' }));
  const result = f.wake.configure({ url: URL, token: SECRET });
  assert.equal(result.host, 'api2.cursor.sh'); assert.equal(result.configured, true);
  assert.ok(!JSON.stringify(result).includes(SECRET)); assert.ok(!JSON.stringify(result).includes(URL));
  assert.equal((await stat(path.join(f.home, 'grok-wake.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(f.home, 'grok-wake.json'), 'utf8')).token, SECRET);
  assert.equal(f.calls.length, 0, 'configuration alone does not make a network request');
});

test('accepted wake deduplicates across batches and process restarts without delivery acknowledgement', async t => {
  const f = await fixture(t); f.wake.configure({ url: URL, token: SECRET });
  const question = { id: 'human:first', taskId: 'task:first', state: 'pending', question: 'Exact user approval question.', kind: 'approval' };
  assert.equal((await f.wake.notify([question, { id: 'delivered', state: 'delivered' }])).sent, true);
  assert.equal(question.state, 'pending');
  const call = f.calls[0], body = JSON.parse(call.init.body);
  assert.deepEqual(body.requestIds, ['human:first']);
  assert.deepEqual(body.questions, [{ id: question.id, taskId: question.taskId, kind: question.kind, question: question.question }]);
  assert.equal(call.init.headers.Authorization, `Bearer ${SECRET}`); assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal);
  assert.equal((await f.wake.notify([question])).sent, false);
  await f.wake.notify([questionFor('human:second')]); await f.wake.notify([question]); assert.equal(f.calls.length, 2);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal((await f.wake.notify([question])).sent, false); assert.equal(f.calls.length, 2);
  assert.ok(f.wake.status().lastSentAt); assert.equal((await stat(path.join(f.home, 'grok-wake-state.json'))).mode & 0o777, 0o600);
});

test('failed wakes retry with cooldown and persisted bounded attempt budget; errors redact credentials', async t => {
  let attempts = 0;
  const f = await fixture(t, { retryMs: 100, maxAttempts: 2, fetchImpl: async () => { attempts++; throw new Error(`network ${URL} ${SECRET}`); } });
  f.wake.configure({ url: URL, token: SECRET });
  assert.equal((await f.wake.notify([questionFor('human:x')])).sent, false);
  assert.ok(!f.wake.status().error.includes(SECRET)); assert.ok(!f.wake.status().error.includes(URL));
  await f.wake.notify([questionFor('human:x')]); assert.equal(attempts, 1);
  f.at += 101; await f.wake.notify([questionFor('human:x')]); assert.equal(attempts, 2);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  f.at += 100000; await f.wake.notify([questionFor('human:x')]); assert.equal(attempts, 2);
  f.wake.configure({ url: URL, token: SECRET }); await f.wake.notify([questionFor('human:x')]); assert.equal(attempts, 2, 'identical UI settings retain the bounded failure budget');
  f.wake.configure({ url: URL, token: 'rotated-fixture-token' }); await f.wake.notify([questionFor('human:x')]); assert.equal(attempts, 3);
});

test('single-flight wake and timeout prevent overlapping or unbounded webhook calls', async t => {
  let attempts = 0;
  const f = await fixture(t, { timeoutMs: 20, fetchImpl: async (_url, options) => {
    attempts++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
  } });
  f.wake.configure({ url: URL, token: SECRET });
  const first = f.wake.notify([questionFor('human:x')]), second = f.wake.notify([questionFor('human:x')]);
  assert.equal(first, second); assert.equal((await first).sent, false); assert.equal(attempts, 1);
  f.wake.stop(); assert.equal((await f.wake.notify([questionFor('human:y')])).sent, false); assert.equal(attempts, 1);
});

test('technical review with no authorization requested never creates an approval question', () => {
  const task = { id: 'c3300ce0', title: 'Review fixture', kind: 'review', status: 'blocked', error: 'The agent ended without a structured completion confirmation.', result: 'No permissions changed.',
    resolution: { state: 'needs_user', nextAction: 'The assigned Claude reviewer should finalize the existing review as standalone JSON, without authorizing merge/deploy.' } };
  assert.equal(humanRequestSpec(task), null);
  assert.equal(humanRequestSpec({ ...task, error: 'No additional approval is required.' }), null);
  assert.equal(humanRequestSpec({ ...task, error: 'Waiting for user approval to deploy the tested change.' }).kind, 'approval');
});

test('completed-work commentary is not a request; interactive tool approval is not a missing API key', () => {
  const base = { id: 'fixture', title: 'Fixture', kind: 'task', status: 'blocked', error: 'The agent ended without a structured completion confirmation. Review its result before retrying.' };
  assert.equal(humanRequestSpec({ ...base, result: 'The work is complete and committed. 额度无法查询，否则交用户决定。', resolution: { state: 'following_up', nextAction: 'Qwen 将指派只读排查。' } }), null);
  assert.equal(humanRequestSpec({ ...base, result: 'It would be worth logging the original error. No permissions changed.', resolution: { state: 'needs_user', nextAction: 'The assigned Claude reviewer should finalize the existing review with exactly one standalone JSON completion object, without authorizing merge or deployment.' } }), null);
  const request = humanRequestSpec({ ...base, error: 'The agent reported a blocker. See its result for details.', result: '已通过 Google 订阅登录验证，未用 API key。搜索命令被 agy 无交互权限审批自动拒绝，需交互批准后继续；未修改权限设置。' });
  assert.equal(request.kind, 'approval');
});

test('bridge wake setup is CSRF protected and board/status redact webhook path and bearer', async t => {
  const { createServer } = await import('node:http');
  const { createTaskStore } = await import('../server/task-store.mjs');
  const { taskBoardBridge } = await import('../server/task-board-bridge.mjs');
  const f = await fixture(t), store = createTaskStore({ home: f.home });
  let middleware;
  taskBoardBridge({ store, grokWake: f.wake }).configureServer({ middlewares: { use(value) { middleware = value; } } });
  const server = createServer((req, res) => { middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/office/grok/wake/config`;
  const board = await (await fetch(`${base}/api/office/board`)).json();
  assert.equal(board.grokWake.configured, false);
  const post = (input, token) => fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Office-Token': token } : {}) }, body: JSON.stringify(input) });
  assert.equal((await post({ url: URL, token: SECRET })).status, 403);
  const good = await post({ url: URL, token: SECRET }, board.csrfToken);
  assert.equal(good.status, 200);
  const goodText = await good.text(); assert.ok(!goodText.includes(SECRET)); assert.ok(!goodText.includes(URL));
  const publicBoard = await (await fetch(`${base}/api/office/board`)).text();
  assert.ok(!publicBoard.includes(SECRET)); assert.ok(!publicBoard.includes(URL));
  const bad = await post({ url: `https://private.invalid/${SECRET}`, token: SECRET }, board.csrfToken);
  assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes(SECRET));
  assert.equal(f.calls.length, 0);
});


test('process environment accepts a complete Bearer header and has explicit precedence over private file and JSON', async t => {
  const f = await fixture(t);
  f.wake.configure({ url: URL, token: 'old-json-fixture-token' });
  await writeFile(path.join(f.home, 'grok-webhook.env'), `export GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_AUTH='Bearer file-fixture-token'\n`, { mode: 0o600 });
  f.wake.stop();
  f.wake = createGrokWake({ ...f.options, env: { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_AUTH: `Bearer ${SECRET}` } });
  assert.equal(f.wake.status().source, 'environment');
  assert.equal(f.wake.status().configured, true);
  assert.throws(() => f.wake.configure({ url: URL, token: 'ignored-fixture-token' }), /environment configuration/);
  await f.wake.notify([questionFor('human:env')]);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(!JSON.stringify(f.wake.status()).includes(SECRET));
  assert.ok(!JSON.stringify(f.wake.status()).includes(URL));
  assert.equal(JSON.parse(await readFile(path.join(f.home, 'grok-wake.json'), 'utf8')).token, 'old-json-fixture-token');
});

test('owner-only private environment loads without evaluation and overrides old JSON across restarts', async t => {
  const f = await fixture(t);
  f.wake.configure({ url: URL, token: 'old-json-fixture-token' });
  const file = path.join(f.home, 'grok-webhook.env');
  await writeFile(file, `# Private Grok webhook\nexport GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_AUTH='Bearer ${SECRET}'\n`, { mode: 0o600 });
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal(f.wake.status().source, 'env-file');
  await f.wake.notify([questionFor('human:file')]);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.throws(() => f.wake.configure({ url: URL, token: 'ignored-fixture-token' }), /environment configuration/);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal((await f.wake.notify([questionFor('human:file')])).sent, false, 'success dedup survives environment-backed restart');
  assert.equal(f.calls.length, 1);
});

test('partial or invalid higher-priority environment fails closed instead of using old UI credentials', async t => {
  const f = await fixture(t); f.wake.configure({ url: URL, token: SECRET });
  for (const env of [
    { GROK_BOT_WEBHOOK_URL: URL },
    { GROK_BOT_WEBHOOK_AUTH: `Bearer ${SECRET}` },
    { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_AUTH: SECRET },
    { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_AUTH: `Bearer ${SECRET}\nInjected: bad` },
  ]) {
    f.wake.stop(); f.wake = createGrokWake({ ...f.options, env });
    assert.equal(f.wake.status().configured, false);
    assert.equal(f.wake.status().source, 'environment');
    assert.ok(!JSON.stringify(f.wake.status()).includes(SECRET));
    assert.ok(!JSON.stringify(f.wake.status()).includes(URL));
    assert.equal((await f.wake.notify([questionFor('human:invalid')])).sent, false);
  }
  assert.equal(f.calls.length, 0);
});

test('private environment rejects broad permissions, symlinks, duplicates and shell expressions without exposing values', async t => {
  const f = await fixture(t); f.wake.configure({ url: URL, token: SECRET });
  const file = path.join(f.home, 'grok-webhook.env'), touched = path.join(f.home, 'must-not-exist');
  await writeFile(file, `export GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_AUTH='Bearer ${SECRET}'\n`, { mode: 0o644 });
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal(f.wake.status().configured, false);
  await chmod(file, 0o600);
  for (const source of [
    `export GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_AUTH=$(touch '${touched}')`,
    `export GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_URL='${URL}'\nexport GROK_BOT_WEBHOOK_AUTH='Bearer ${SECRET}'`,
    `export GROK_BOT_WEBHOOK_URL='${URL}'`,
  ]) {
    await writeFile(file, source);
    f.wake.stop(); f.wake = createGrokWake(f.options);
    assert.equal(f.wake.status().configured, false);
    assert.ok(!JSON.stringify(f.wake.status()).includes(SECRET));
  }
  await assert.rejects(access(touched));
  await rm(file); await symlink(path.join(f.home, 'grok-wake.json'), file);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal(f.wake.status().configured, false);
  assert.equal(f.calls.length, 0);
});

test('event payload includes only exact pending question fields and excludes unbound IDs or non-pending records', async t => {
  const f = await fixture(t); f.wake.configure({ url: URL, token: SECRET });
  const question = { ...questionFor('human:content'), question: '请明确批准这项具体请求，或说明缺少的信息。', privateField: SECRET, questionHash: 'obsolete-event-snapshot-hash' };
  const invalid = { ...questionFor('human:invalid'), taskId: '' };
  await f.wake.notify([question, question, invalid, 'human:bare-id', { ...questionFor('human:done'), state: 'answered' }, { ...questionFor('human:delivered'), state: 'delivered' }]);
  assert.equal(f.calls.length, 1);
  const payload = JSON.parse(f.calls[0].init.body);
  assert.deepEqual(payload.requestIds, [question.id]);
  assert.deepEqual(payload.questions, [{ id: question.id, taskId: question.taskId, kind: question.kind, question: question.question }]);
  assert.ok(!f.calls[0].init.body.includes(SECRET));
  assert.equal(Object.hasOwn(payload.questions[0], 'questionHash'), false);
  assert.ok(!f.calls[0].init.body.includes('obsolete-event-snapshot-hash'));
  assert.match(payload.message, /MUST run office-board.mjs pending-questions/);
  assert.match(payload.message, /current questionHash/);
  await f.wake.notify([question]); assert.equal(f.calls.length, 1);
  assert.equal((await f.wake.notify(['human:bare-id', invalid])).sent, false);
  assert.equal(question.state, 'pending', 'accepted transport is never a delivery acknowledgement');
});


test('valid environment rotation resets only failed attempts while same-config restarts and accepted IDs stay deduplicated', async t => {
  const firstToken = 'first-fixture-token', rotatedToken = 'rotated-fixture-token';
  const calls = [];
  const f = await fixture(t, { maxAttempts: 2, retryMs: 100, env: { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_AUTH: `Bearer ${firstToken}` },
    fetchImpl: async (_url, init) => {
      const ids = JSON.parse(init.body).requestIds; calls.push({ auth: init.headers.Authorization, ids });
      return { ok: ids.includes('human:accepted') || init.headers.Authorization === `Bearer ${rotatedToken}` };
    },
  });
  await f.wake.notify([questionFor('human:accepted')]);
  await f.wake.notify([questionFor('human:failed')]);
  f.at += 101; await f.wake.notify([questionFor('human:failed')]);
  assert.equal(calls.length, 3);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  f.at += 101; await f.wake.notify([questionFor('human:failed'), questionFor('human:accepted')]);
  assert.equal(calls.length, 3, 'same environment restart retains exhausted budget');
  f.wake.stop();
  f.options.env = { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_AUTH: `Bearer ${rotatedToken}` };
  f.wake = createGrokWake(f.options);
  assert.equal((await f.wake.notify([questionFor('human:failed'), questionFor('human:accepted')])).sent, true);
  assert.deepEqual(calls.at(-1).ids, ['human:failed'], 'accepted original question is never resent after rotation');
  assert.equal(calls.at(-1).auth, `Bearer ${rotatedToken}`);
  const stored = JSON.parse(await readFile(path.join(f.home, 'grok-wake-state.json'), 'utf8'));
  assert.match(stored.configFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(stored.records['human:failed'].attempts, 1);
  assert.equal((await stat(path.join(f.home, 'grok-wake-state.json'))).mode & 0o777, 0o600);
  const publicStatus = JSON.stringify(f.wake.status());
  for (const privateValue of [stored.configFingerprint, firstToken, rotatedToken, URL]) assert.ok(!publicStatus.includes(privateValue));
  f.wake.stop(); f.wake = createGrokWake(f.options);
  await f.wake.notify([questionFor('human:failed'), questionFor('human:accepted')]);
  assert.equal(calls.length, 4);
});

test('JSON settings cannot change midway through an in-flight event and invalidate its dedup record', async t => {
  let finish;
  const f = await fixture(t, { fetchImpl: async () => new Promise(resolve => { finish = resolve; }) });
  f.wake.configure({ url: URL, token: SECRET });
  const sent = f.wake.notify([questionFor('human:flight')]);
  assert.throws(() => f.wake.configure({ url: URL, token: 'changed-fixture-token' }), /in progress/);
  finish({ ok: true }); await sent;
  f.wake.configure({ url: URL, token: 'changed-fixture-token' });
  assert.equal((await f.wake.notify([questionFor('human:flight')])).sent, false);
});

test('explicit user re-request gets one additional notification without replaying the original question event', async t => {
  const f = await fixture(t); f.wake.configure({ url: URL, token: SECRET });
  const question = questionFor('human:reask');
  await f.wake.notify([question]); assert.equal(f.calls.length, 1);
  await f.wake.notify([question]); assert.equal(f.calls.length, 1);
  const reopened = { ...question, rerequestCount: 1 };
  await f.wake.notify([reopened]); assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.calls[1].init.body).requestIds, [question.id]);
  assert.equal(JSON.parse(f.calls[1].init.body).questions[0].id, question.id);
  await f.wake.notify([reopened]); assert.equal(f.calls.length, 2);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  await f.wake.notify([reopened]); assert.equal(f.calls.length, 2);
});

test('dispatch instructions wake the bot once per revision using a separate journal and truthful delivery status', async t => {
  const f = await fixture(t, { channel: 'instructions', officeUrl: 'http://127.0.0.1:5173', commandInterface: { scriptPath: '/office/scripts/office-board.mjs' } });
  f.wake.configure({ url: URL, token: SECRET });
  const instruction = { id: 'instruction-1', status: 'pending', updatedAt: '2026-11-09T01:00:00Z' };
  assert.equal(f.wake.delivery([instruction])[instruction.id].state, 'queued');
  await f.wake.notify([instruction]);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.event, 'office.instructions.pending'); assert.deepEqual(body.instructionIds, ['instruction-1']);
  assert.match(body.message, /pending-instructions/); assert.match(body.message, /apply-plan/); assert.match(body.message, /never.*impersonat|impersonate/);
  assert.equal(body.officeUrl, 'http://127.0.0.1:5173'); assert.equal(body.questions, undefined);
  assert.equal(f.wake.delivery([instruction])[instruction.id].state, 'accepted');
  assert.equal((await f.wake.notify([instruction])).sent, false);
  f.wake.stop(); f.wake = createGrokWake(f.options);
  await f.wake.notify([instruction]); assert.equal(f.calls.length, 1);
  await f.wake.notify([{ ...instruction, status: 'done' }]); assert.equal(f.calls.length, 1);
  await f.wake.notify([{ ...instruction, updatedAt: '2026-11-09T02:00:00Z' }]); assert.equal(f.calls.length, 2);
  assert.equal((await stat(path.join(f.home, 'grok-dispatch-wake-state.json'))).mode & 0o777, 0o600);
  await assert.rejects(access(path.join(f.home, 'grok-wake-state.json')));
});


test('daily reports use a private independent journal and ID/hash-only wake payload; HTTP acceptance is not delivery', async t => {
  const f = await fixture(t, { channel: 'reports', officeUrl: () => 'http://127.0.0.1:5199', commandInterface: { scriptPath: '/office/scripts/office-board.mjs', commands: ['pending-reports', 'acknowledge-report'] } });
  f.wake.configure({ url: URL, token: SECRET });
  const report = { id: 'qwen-daily:2026-11-12', state: 'pending', status: 'pending', reportHash: 'a'.repeat(64), text: 'Private work report contents stay in the local inbox.', summary: SECRET };
  assert.equal(f.wake.delivery([report])[report.id].state, 'queued');
  assert.equal(f.wake.delivery([report])[report.id].delivered, false);
  assert.equal((await f.wake.notify([report, report])).sent, true);
  assert.equal(f.calls.length, 1);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.event, 'office.daily_reports.pending');
  assert.deepEqual(body.reportIds, [report.id]);
  assert.deepEqual(body.reports, [{ id: report.id, reportHash: report.reportHash }]);
  assert.equal(body.officeUrl, 'http://127.0.0.1:5199');
  assert.equal(body.scriptPath, '/office/scripts/office-board.mjs');
  assert.equal(body.commandInterface.scriptPath, body.scriptPath);
  assert.equal(body.questions, undefined); assert.equal(body.instructions, undefined);
  assert.ok(!f.calls[0].init.body.includes(report.text)); assert.ok(!f.calls[0].init.body.includes(SECRET));
  assert.match(body.message, /MUST run office-board.mjs pending-reports/);
  assert.match(body.message, /Only AFTER actual full-report delivery/);
  assert.match(body.message, /HTTP 2xx.*not delivery/);
  assert.equal(report.state, 'pending'); assert.equal(report.status, 'pending');
  const delivery = f.wake.delivery([report])[report.id];
  assert.equal(delivery.state, 'accepted'); assert.equal(delivery.delivered, false);
  assert.equal(delivery.messageId, undefined); assert.equal(delivery.reportHash, report.reportHash);
  assert.equal((await stat(path.join(f.home, 'grok-report-wake-state.json'))).mode & 0o777, 0o600);
  await assert.rejects(access(path.join(f.home, 'grok-wake-state.json')));
  await assert.rejects(access(path.join(f.home, 'grok-dispatch-wake-state.json')));
  f.wake.stop(); f.wake = createGrokWake(f.options);
  await f.wake.notify([report]); assert.equal(f.calls.length, 1, 'same report never repeats after a restart');
  await f.wake.notify([{ ...report, reportHash: 'b'.repeat(64) }]); assert.equal(f.calls.length, 2, 'a genuinely revised report has a distinct notification');
  await f.wake.notify([{ ...report, state: 'delivered', status: 'delivered', reportHash: 'c'.repeat(64) }]);
  assert.equal(f.calls.length, 2);
});

test('daily-report notification validates pending hash-bound identity and retains a bounded retry budget after restart', async t => {
  const f = await fixture(t, { channel: 'reports', retryMs: 100, maxAttempts: 2, fetchImpl: async () => ({ ok: false }) });
  f.wake.configure({ url: URL, token: SECRET });
  const report = { id: 'r'.repeat(240), state: 'pending', reportHash: 'e'.repeat(64) };
  for (const invalid of [null, report.id, { ...report, reportHash: 'old' }, { ...report, id: '' }, { ...report, status: 'delivered' }, { ...report, state: 'delivered' }]) {
    assert.equal((await f.wake.notify([invalid])).sent, false);
    assert.deepEqual(f.wake.delivery([invalid]), {});
  }
  await f.wake.notify([report]); assert.equal(f.wake.delivery([report])[report.id].state, 'retrying');
  f.at += 101; await f.wake.notify([report]);
  assert.equal(f.wake.delivery([report])[report.id].state, 'failed');
  f.wake.stop(); f.wake = createGrokWake(f.options);
  assert.equal(f.wake.delivery([report])[report.id].attempts, 2, 'compound persisted keys remain bounded for maximum-length report IDs');
  f.at += 101; assert.equal((await f.wake.notify([report])).sent, false);
  assert.equal(f.wake.delivery([report])[report.id].attempts, 2);
  assert.equal(f.wake.delivery([report])[report.id].delivered, false);
  assert.match(f.wake.status().error, /Reports remain pending/);
});


test('stopping a report notifier waits for the aborted transport before its replacement can start', async t => {
  let cleanupComplete = false;
  const f = await fixture(t, { channel: 'reports', fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => setTimeout(() => { cleanupComplete = true; reject(new Error('aborted')); }, 10), { once: true });
  }) });
  f.wake.configure({ url: URL, token: SECRET });
  const report = { id: 'daily:stop', state: 'pending', reportHash: 'd'.repeat(64) };
  const sending = f.wake.notify([report]);
  const stopping = f.wake.stop();
  assert.equal(cleanupComplete, false);
  await stopping;
  assert.equal(cleanupComplete, true); assert.equal((await sending).sent, false);
  assert.equal(f.wake.delivery([report])[report.id].delivered, false);
  assert.equal((await f.wake.notify([report])).sent, false);
});
