import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { officeRelay } from '../server/office-relay.mjs';
import { mobileRouteAllowed } from '../server/mobile-gateway.mjs';
import { taskBoardBridge } from '../server/task-board-bridge.mjs';

test('private conversation route is local, same-origin, GET-only and never accesses upstream office or chat', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grok-route-test-')); const httpServer = new EventEmitter();
  t.after(async () => { httpServer.emit('close'); await rm(home, { recursive: true, force: true }); });
  let handler, reads = 0, argumentsSeen;
  officeRelay({ home, fetchImpl: () => assert.fail('Conversation must not fetch any upstream API'), conversationReader: input => { reads++; argumentsSeen = input; return { phase: 'ready', messages: [] }; } }).configureServer({ httpServer, middlewares: { use: value => { handler = value; } } });
  const call = async ({ headers = {}, address = '127.0.0.1', method = 'GET', query = '' } = {}) => {
    const req = Readable.from([]); Object.assign(req, { url: '/api/office/grok/conversation' + query, method, headers: { host: '127.0.0.1:5186', ...headers }, socket: { remoteAddress: address } });
    let payload; const response = { statusCode: 200, setHeader() {}, end(value) { payload = JSON.parse(value); } };
    await handler(req, response, () => assert.fail('Expected route'));
    return { status: response.statusCode, payload };
  };
  assert.equal((await call({ query: '?botId=synthetic&cursor=revision%3A80' })).status, 200); assert.deepEqual(argumentsSeen, { botId: 'synthetic', cursor: 'revision:80' });
  for (const request of [{ address: '192.168.1.20' }, { headers: { origin: 'https://evil.test' } }, { headers: { host: 'evil.test' } }, { headers: { 'sec-fetch-site': 'cross-site' } }]) assert.equal((await call(request)).status, 403);
  assert.equal((await call({ query: '?file=/etc/passwd' })).status, 400);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) assert.equal((await call({ method })).status, 405);
  assert.equal(reads, 1);
  for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) assert.equal(mobileRouteAllowed(method, '/api/office/grok/conversation'), false);
});

test('standard office bridge exposes the same local read-only mirror, including read-only setup mode', async () => {
  let handler, reads = 0;
  taskBoardBridge({ store: {}, readOnly: true, conversationReader: () => { reads++; return { phase: 'ready', messages: [] }; } }).configureServer({ middlewares: { use: value => { handler = value; } } });
  async function call(method = 'GET', origin = 'http://127.0.0.1:5173', query = '') {
    const request = Readable.from([]); Object.assign(request, { method, url: '/api/office/grok/conversation' + query, headers: { host: '127.0.0.1:5173', origin }, socket: { remoteAddress: '127.0.0.1' } });
    const response = { statusCode: 200, setHeader() {}, end() {} };
    await handler(request, response, () => assert.fail('Expected route')); return response.statusCode;
  }
  assert.equal(await call(), 200); assert.equal(await call('GET', 'https://evil.test'), 403); assert.equal(await call('POST'), 405); assert.equal(await call('GET', 'http://127.0.0.1:5173', '?path=/etc/passwd'), 400); assert.equal(reads, 1);
});
