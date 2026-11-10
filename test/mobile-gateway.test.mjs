import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMobileGateway } from '../server/mobile-gateway.mjs';
import { requestId } from '../src/request-id.js';
import { selectedForScope } from '../src/task-selection.js';
import { filterBoardTasks } from '../src/task-board-ui.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-mobile-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>office fixture</h1>');
  await symlink('/etc/hosts', path.join(dir, 'outside'));
  const calls = [];
  const upstream = http.createServer((req, res) => { calls.push({ headers: req.headers, path: req.url }); res.setHeader('Content-Type', 'application/json'); res.statusCode = req.method === 'POST' && req.headers['x-office-token'] !== 'fixture-csrf' ? 403 : 200; res.end(JSON.stringify({ fixture: true })); });
  await listen(upstream);
  let clock = 1000;
  const key = 'fixture-only-access-key-of-32-characters';
  const gateway = createMobileGateway({ host: '127.0.0.1', port: 0, accessKey: key, distDir: dir, upstreamPort: upstream.address().port, now: () => clock });
  await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const login = async value => fetch(base + '/mobile/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: value ?? key }) });
  const session = async () => (await login()).headers.get('set-cookie').split(';')[0];
  return { base, key, calls, login, session, upstream, advance: value => { clock += value; } };
}
test('mobile entry requires authentication for static assets and all office APIs', async t => {
 const f = await fixture(t);
 const landing = await fetch(f.base + '/');
 assert.match(await landing.text(), /手機入口/);
 assert.equal(landing.headers.get('referrer-policy'), 'no-referrer');
 assert.equal((await fetch(f.base + '/api/office/board')).status, 401);
 assert.equal((await f.login('incorrect')).status, 401);
 const session = await f.login();
 const cookieHeader = session.headers.get('set-cookie');
 assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Strict/);
 const cookie = cookieHeader.split(';')[0];
 assert.match(await (await fetch(f.base + '/', { headers: { Cookie: cookie } })).text(), /office fixture/);
 assert.equal((await fetch(f.base + '/api/office/board', { headers: { Cookie: cookie } })).status, 200);
 assert.equal((await fetch(f.base + '/outside', { headers: { Cookie: cookie } })).status, 404);
 assert.equal((await fetch(f.base + '/server/task-store.mjs', { headers: { Cookie: cookie } })).status, 404);
 f.advance(8 * 86400000);
 assert.equal((await fetch(f.base + '/api/office/board', { headers: { Cookie: cookie } })).status, 401);
});
test('authenticated proxy enforces origin and preserves office CSRF without forwarding phone credentials', async t => {
 const f = await fixture(t), cookie = await f.session();
 const post = headers => fetch(f.base + '/api/office/tasks/card-actions', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: '{}' });
 assert.equal((await post({ Origin: 'http://evil.example', 'X-Office-Token': 'fixture-csrf' })).status, 403);
 assert.equal((await post({ 'X-Office-Token': 'fixture-csrf' })).status, 403);
 assert.equal(f.calls.length, 0);
 assert.equal((await post({ Origin: f.base })).status, 403);
 assert.equal((await post({ Origin: f.base, 'X-Office-Token': 'fixture-csrf' })).status, 200);
 assert.equal(f.calls.at(-1).headers.host, `127.0.0.1:${f.upstream.address().port}`);
 assert.equal(f.calls.at(-1).headers.cookie, undefined);
 const wrongHost = await new Promise(resolve => { http.get(f.base + '/api/office/board', { headers: { Cookie: cookie, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); });
 assert.equal(wrongHost, 403);
});
test('pairing rejects cross-origin login and rate limits guessing', async t => {
 const f = await fixture(t);
 assert.equal((await fetch(f.base + '/mobile/login', { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: f.key }) })).status, 403);
 for(let i=0;i<10;i++) assert.equal((await f.login('incorrect')).status, 401);
 assert.equal((await f.login()).status, 429);
 f.advance(61000);
 assert.equal((await f.login()).status, 200);
});
test('mobile operation IDs work without secure-context randomUUID', () => {
 const api = { getRandomValues: value => crypto.getRandomValues(value) };
 const ids = Array.from({ length: 50 }, () => requestId(api));
 assert.equal(new Set(ids).size, 50);
 for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('bulk selection is restricted to the current category and preserves originally selected versions', () => {
 const tasks = [{ id:'todo', status:'pending' }, { id:'blocked', status:'blocked' }, { id:'done', status:'done' }];
 const checked = Object.fromEntries(tasks.map(task => [task.id, { id:task.id,version:1 }]));
 for (const status of ['pending','blocked','done']) {
  const scoped = filterBoardTasks(tasks, { status });
  assert.deepEqual(selectedForScope(checked, scoped), [{ id:scoped[0].id, version:1 }]);
 }
 assert.deepEqual(selectedForScope(checked, []), []);
});

test('phone cannot impersonate a worker or Grok relay, or change credentials', async t => {
 const f = await fixture(t), cookie = await f.session();
 for (const route of ['/tasks/claim-next','/tasks/fixture/claim','/tasks/fixture/finish','/tasks/fixture/heartbeat','/human-requests/fixture/answer','/human-requests/fixture/triage','/human-requests/fixture/acknowledge','/grok/bot/heartbeat','/grok/connect','/grok/wake/config','/instructions/fixture/apply-plan']) {
  const response = await fetch(f.base + '/api/office' + route, { method:'POST', headers:{ Cookie:cookie, Origin:f.base, 'Content-Type':'application/json', 'X-Office-Token':'fixture-csrf' }, body:'{}' });
  assert.equal(response.status,404,route);
 }
 assert.equal(f.calls.length,0);
});
