import test from 'node:test';
import assert from 'node:assert/strict';
import { compactNativeStatus } from '../server/native-status-view.mjs';
import { createNativeStatusReader } from '../server/native-status-reader.mjs';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('native reader pins the exact loopback status endpoint and preserves authoritative execution evidence', async () => {
  for (const [baseUrl, provider] of [['http://127.0.0.1:5186/', 'claude'], ['http://localhost:5186', 'codex'], ['http://[::1]:5186', 'claude']]) {
    const state = { connected: true, agents: [{ id: 'one', observed: true, status: 'working', executionState: 'working' }], sourceHealth: { lifecycle: true } };
    let calls = 0;
    const read = createNativeStatusReader({ baseUrl, provider, fetchImpl: async (url, options) => {
      calls++; assert.equal(url, `${new URL(baseUrl).origin}/api/${provider}/status?view=agents`);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.method, 'GET');
      assert.equal(options.headers.Accept, 'application/json'); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false); return json(state);
    } });
    assert.deepEqual(await read(), state); assert.equal(calls, 1);
  }
});

test('remote hosts, credentials, paths, query strings, fragments and unsupported providers are rejected before fetching', () => {
  const fetchImpl = () => assert.fail('invalid source must never fetch');
  for (const baseUrl of ['https://example.com', 'http://localhost.example.com', 'http://127.0.0.1@elsewhere.test', 'http://user:secret@127.0.0.1:5186', 'http://127.0.0.1:5186/api', 'http://127.0.0.1:5186/?auth=secret', 'http://127.0.0.1:5186/#secret', 'file:///tmp/status', 'not a URL']) {
    assert.throws(() => createNativeStatusReader({ baseUrl, provider: 'claude', fetchImpl }), /loopback/);
  }
  assert.throws(() => createNativeStatusReader({ baseUrl: 'http://localhost:5186', provider: '../grok', fetchImpl }), /provider/);
});

test('network, HTTP and malformed source failures remain unavailable without fallback or private error leakage', async () => {
  for (const fetchImpl of [async () => { throw new Error('PRIVATE_TOKEN'); }, async () => new Response('PRIVATE_BODY', { status: 500 }), async () => new Response('{broken'),
    ...[null, [], {}, { agents: null }, { agents: ['bad'] }, { agents: [null] }, { agents: [[]] }].map(value => async () => json(value))]) {
    const read = createNativeStatusReader({ baseUrl: 'http://localhost:5186', provider: 'codex', fetchImpl });
    await assert.rejects(read(), error => { assert.equal(error.message, 'Current codex status source is unavailable.'); return true; });
  }
});

test('response budget applies to declared and chunked bodies and cancels rejected streams', async () => {
  let declaredCancelled = false;
  const declared = createNativeStatusReader({ baseUrl: 'http://localhost:5186', provider: 'claude', fetchImpl: async () => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { headers: { 'Content-Length': String(3 * 1024 * 1024) } }) });
  await assert.rejects(declared(), /unavailable/); assert.equal(declaredCancelled, true);
  let chunkedCancelled = false;
  const chunked = createNativeStatusReader({ baseUrl: 'http://localhost:5186', provider: 'claude', fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { chunkedCancelled = true; },
  })) });
  await assert.rejects(chunked(), /unavailable/); assert.equal(chunkedCancelled, true);
});


test('compact native view removes huge skill catalogs while preserving every execution evidence field', async () => {
  const agents = Array.from({ length: 150 }, (_, id) => ({ id: String(id), observed: true, status: id % 2 ? 'working' : 'waiting', executionState: id % 2 ? 'working' : 'waiting' }));
  const full = { agents, observedAt: '2026-11-12T14:00:00Z', connected: true, metadataAvailable: true, executionCounts: { working: 75, waiting: 75 }, sourceHealth: { lifecycle: { available: true } }, sourceErrors: [], coverage: 'Actual native evidence', skills: [{ body: 'x'.repeat(4 * 1024 * 1024) }], topicSkillCount: 1000, unrelated: 'omit' };
  const projected = compactNativeStatus(full);
  assert.equal(projected.agents, agents); assert.equal(projected.sourceHealth, full.sourceHealth);
  assert.equal(projected.skills, undefined); assert.equal(projected.topicSkillCount, undefined); assert.equal(projected.unrelated, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 2 * 1024 * 1024);
  const read = createNativeStatusReader({ baseUrl: 'http://127.0.0.1:5186/', provider: 'claude', fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('view'), 'agents'); return json(projected);
  } });
  assert.deepEqual(await read(), projected);
});


test('compact view bounds 6000 offline agents but never truncates 100 running or uncertain agents', async () => {
  const epoch = Date.parse('2026-11-12T00:00:00Z');
  const offline = Array.from({ length: 6000 }, (_, i) => ({ id: `ended-${i}`, name: 'historical metadata '.repeat(35), status: 'offline', observed: true, executionState: 'offline', updatedAt: new Date(epoch + i * 1000).toISOString() }));
  const running = Array.from({ length: 100 }, (_, i) => ({ id: `running-${i}`, status: 'working', observed: true, executionState: 'working' }));
  const others = ['waiting', 'unconfirmed', 'failed', 'idle'].map(status => ({ id: status, status, executionState: status }));
  const full = { agents: [...offline, ...running, ...others], connected: true, executionCounts: { working: 100, waiting: 1, unconfirmed: 1, failed: 1, idle: 1 }, sourceHealth: { lifecycle: { available: true } }, metadataAvailable: true };
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 2 * 1024 * 1024);
  const projected = compactNativeStatus(full);
  assert.equal(projected.totalAgentCount, 6104); assert.equal(projected.omittedOfflineCount, 5980);
  assert.equal(projected.agents.length, 124);
  assert.deepEqual(projected.agents.filter(agent => agent.status !== 'offline'), [...running, ...others]);
  assert.deepEqual(projected.agents.filter(agent => agent.status === 'offline').map(agent => agent.id), Array.from({ length: 20 }, (_, i) => `ended-${5999 - i}`));
  assert.deepEqual(projected.executionCounts, full.executionCounts); assert.equal(projected.sourceHealth, full.sourceHealth);
  assert.equal(full.agents.length, 6104); assert.equal(full.agents[0], offline[0]);
  const bytes = Buffer.byteLength(JSON.stringify(projected)); assert.ok(bytes < 2 * 1024 * 1024);
  const read = createNativeStatusReader({ baseUrl: 'http://127.0.0.1:5186', provider: 'claude', fetchImpl: async () => json(projected) });
  const actual = await read(); assert.equal(actual.agents.filter(agent => agent.status === 'working').length, 100); assert.equal(actual.omittedOfflineCount, 5980);
});
