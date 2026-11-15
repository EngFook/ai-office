import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';
import { createRegisteredProject, readProjectCatalog } from '../server/project-catalog.mjs';
import { mobileRouteAllowed } from '../server/mobile-gateway.mjs';

async function fixture(t, { readOnly = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'office-project-api-'));
  const project = path.join(home, '客户 新项目'); await mkdir(project);
  const store = createTaskStore({ home, researchDir: path.join(home, 'research'), crossReview: false });
  let middleware;
  taskBoardBridge({ store, readOnly, defaultProjectPath: home, enabledProviders: [], getProjectCatalog: () => readProjectCatalog(home), onCreateProject: input => createRegisteredProject(input, { home }), meetingFile: path.join(home, 'none') }).configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(home, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const board = async () => (await fetch(`${base}/api/office/board`)).json();
  return { home, project, store, base, board, post: (input, headers = {}) => fetch(`${base}/api/office/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(input) }) };
}

test('project registration persists any existing non-Git folder and survives a new catalog reader', async t => {
  const f = await fixture(t), initial = await f.board();
  assert.equal(initial.capabilities.projects, true);
  const headers = { 'X-Office-Token': initial.csrfToken }, input = { name: '客户资料', path: f.project };
  const response = await f.post(input, headers); assert.equal(response.status, 201);
  const saved = await response.json(); assert.equal(saved.project.path, await realpath(f.project));
  assert.equal((await f.board()).projectCatalog[0].name, '客户资料');
  assert.equal(JSON.parse(await readFile(path.join(f.home, 'project-catalog.json'), 'utf8'))[0].id, saved.project.id);
  assert.equal((await f.post(input, headers)).status, 200);
  assert.equal(readProjectCatalog(f.home).length, 1);
  assert.deepEqual(await readdir(f.project), [], 'registration must not create Git or other project files');
  assert.equal(f.store.snapshot().tasks.length, 0, 'registration must not dispatch work');
  assert.equal((await f.post({ path: path.join(f.home, 'missing') }, headers)).status, 400);
});

test('project registration requires same-origin CSRF and is disabled for read-only offices', async t => {
  const f = await fixture(t), token = (await f.board()).csrfToken, input = { path: f.project };
  assert.equal((await f.post(input)).status, 403);
  assert.equal((await f.post(input, { 'X-Office-Token': token, Origin: 'https://outside.invalid' })).status, 403);
  assert.equal(readProjectCatalog(f.home).length, 0);
  const readonly = await fixture(t, { readOnly: true }), board = await readonly.board();
  assert.equal(board.capabilities.projects, false);
  assert.equal((await readonly.post({ path: readonly.project }, { 'X-Office-Token': board.csrfToken })).status, 403);
  assert.equal(mobileRouteAllowed('POST', '/api/office/projects'), true);
  assert.equal(mobileRouteAllowed('POST', '/api/office/grok/blocked-tasks/read'), false);
});


test('explicit empty project reaches text-only tasks; omitted folder uses workspace', async t => {
  const f = await fixture(t), token = (await f.board()).csrfToken;
  const post = input => fetch(`${f.base}/api/office/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.base, 'X-Office-Token': token }, body: JSON.stringify(input) });
  const response = await post({ title: 'Summarize supplied text', description: 'Some supplied instructions', provider: 'local-qwen', supportType: 'task-breakdown', projectPath: '' });
  assert.equal(response.status, 201); assert.equal((await response.json()).task.projectPath, '');
  const omitted = await post({ title: 'Default workspace', provider: 'codex' });
  assert.equal(omitted.status, 201); assert.equal((await omitted.json()).task.projectPath, await realpath(f.home));
});
