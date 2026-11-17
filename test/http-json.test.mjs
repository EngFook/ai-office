import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acceptsGzip, sendJson } from '../server/http-json.mjs';
import { createTaskStore } from '../server/task-store.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

function response() {
  return { headers: {}, writes: 0, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, end(body) { this.body = body; this.writes++; } };
}
const getRaw = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject);
  }).on('error', reject);
});
test('compression respects explicit client preferences and exclusions', () => {
  for (const header of [undefined, '', 'br', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=.5, identity;q=1', 'gzip;q=bogus', 'gzip;q=2']) assert.equal(acceptsGzip(header), false, String(header));
  for (const header of ['gzip', 'br, gzip', 'GZIP; Q=1', '*', 'gzip;q=.5, identity;q=.1', 'gzip;q=1,*;q=0']) assert.equal(acceptsGzip(header), true, header);
});
test('gzip preserves complete unicode snapshots, versions, and existing Vary', async () => {
  const value = { tasks: [{ id: '完整', version: 42, history: Array.from({ length: 100 }, (_, n) => ({ n, text: '需要用户批准；保留原始资料。' })) }], csrfToken: 'fixture-token' };
  const res = response(); res.setHeader('Vary', 'Origin');
  await sendJson({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, res, value);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers.vary, 'Origin, Accept-Encoding');
  assert.equal(res.headers['content-length'], res.body.length);
  assert.deepEqual(JSON.parse(gunzipSync(res.body)), value);
  assert.ok(res.body.length < Buffer.byteLength(JSON.stringify(value)) / 2);
});
test('small responses, mutations, errors, and clients without gzip stay plain JSON', async () => {
  for (const [method, status, header, value] of [['GET', 200, 'gzip', { ok: true }], ['POST', 200, 'gzip', { token: 'x'.repeat(3000) }], ['GET', 403, 'gzip', { error: 'x'.repeat(3000) }], ['GET', 200, undefined, { text: 'x'.repeat(3000) }]]) {
    const res = response(); await sendJson({ method, headers: { 'accept-encoding': header } }, res, value, status);
    assert.equal(res.headers['content-encoding'], undefined); assert.equal(res.statusCode, status);
    assert.deepEqual(JSON.parse(res.body), value);
  }
});
test('disconnect during asynchronous compression does not write a late response', async () => {
  const res = response();
  const pending = sendJson({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, res, { text: 'x'.repeat(100000) });
  res.destroyed = true; await pending; assert.equal(res.writes, 0);
});
test('real task-board HTTP response is compressed without dropping task data or mutation guards', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-compression-'));
  const store = createTaskStore({ home });
  const task = store.createTask({ title: 'Compression fixture', description: '完整记录 '.repeat(1000) });
  let handler;
  taskBoardBridge({ store }).configureServer({ middlewares: { use(value) { handler = value; } } });
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const zipped = await getRaw(base + '/api/office/board', { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.status, 200); assert.equal(zipped.headers['content-encoding'], 'gzip');
  const snapshot = JSON.parse(gunzipSync(zipped.body));
  assert.deepEqual(snapshot.tasks.find(value => value.id === task.id), store.snapshot().tasks.find(value => value.id === task.id));
  const plain = await getRaw(base + '/api/office/board');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(plain.body).tasks, snapshot.tasks);
  assert.equal((await fetch(base + '/api/office/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, body: JSON.stringify({ title: 'Not authorized' }) })).status, 403);
  assert.equal(store.snapshot().tasks.length, 1);
});
