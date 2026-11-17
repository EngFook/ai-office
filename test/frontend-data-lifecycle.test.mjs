import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollingResource } from '../src/polling-resource.js';
import { createUsageDataStore } from '../src/usage-data-store.js';
import { createTaskBoardClient } from '../src/task-board-client.js';

function clock() {
  let time = 1000, id = 0; const tasks = new Map();
  return { now: () => time, setTimer(fn, ms) { tasks.set(++id, { fn, at: time + ms }); return id; }, clearTimer(key) { tasks.delete(key); },
    advance(ms) { const until = time + ms; for (;;) { const next = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= until); if (!next) break; tasks.delete(next[0]); time = next[1].at; next[1].fn(); } time = until; } };
}
function visibility(initial = 'visible') {
  const target = new EventTarget(); target.visibilityState = initial;
  target.show = state => { target.visibilityState = state; target.dispatchEvent(new Event('visibilitychange')); };
  return target;
}
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
function deferredFetch() {
  const requests = [];
  return { requests, fetchImpl: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, finish: (data, status) => resolve(response(data, status)), response: resolve, fail: reject })) };
}
const board = (name = 'current', token = name) => ({ tasks: [{ id: name, status: 'pending' }], roles: [], instructions: [], csrfToken: token });

test('shared usage stops at last subscriber, and a late cancelled read cannot contaminate the new subscription', async () => {
  const timers = clock(), network = deferredFetch(), document = visibility();
  const store = createUsageDataStore({ ...network, ...timers, visibilityTarget: document, focusTarget: null });
  const first = [], second = [];
  const stopA = store.subscribe(value => first.push(value)), stopB = store.subscribe(value => second.push(value));
  assert.equal(network.requests.length, 1);
  stopA(); assert.equal(network.requests[0].options.signal.aborted, false);
  stopB(); assert.equal(network.requests[0].options.signal.aborted, true);
  const stopC = store.subscribe(value => second.push(value));
  assert.equal(network.requests.length, 2);
  network.requests[1].finish({ providers: [], generatedAt: 2 }); await flush();
  network.requests[0].finish({ providers: [], generatedAt: 1 }); await flush();
  assert.equal(store.getSnapshot().data.generatedAt, 2);
  assert.equal(second.some(value => value.data?.generatedAt === 1), false);
  stopC(); timers.advance(300000); await flush(); assert.equal(network.requests.length, 2);
});

test('hidden page does no polling and focus/visibility wake share one immediate refresh', async () => {
  const timers = clock(), network = deferredFetch(), document = visibility('hidden'), window = new EventTarget();
  const store = createPollingResource({ url: '/status', ...network, ...timers, visibilityTarget: document, focusTarget: window });
  const stop = store.subscribe(() => {});
  timers.advance(300000); assert.equal(network.requests.length, 0);
  document.show('visible'); window.dispatchEvent(new Event('focus'));
  assert.equal(network.requests.length, 1);
  network.requests[0].finish({ active: 1 }); await flush();
  document.show('hidden'); timers.advance(300000); assert.equal(network.requests.length, 1);
  document.show('visible'); assert.equal(network.requests.length, 2);
  document.show('hidden'); assert.equal(network.requests[1].options.signal.aborted, true);
  network.requests[1].finish({ active: 99 }); await flush();
  assert.equal(store.getSnapshot().data.active, 1); assert.equal(store.getSnapshot().error, null);
  document.show('visible'); assert.equal(network.requests.length, 3); stop(); await flush();
});

test('a stalled response body times out and retries; invalid usage never replaces last valid data', async () => {
  const timers = clock(), network = deferredFetch();
  const store = createUsageDataStore({ ...network, ...timers, visibilityTarget: null, focusTarget: null });
  const stop = store.subscribe(() => {});
  network.requests[0].finish({ providers: [], generatedAt: 1 }); await flush();
  void store.refresh(); assert.equal(store.getSnapshot().loading, false, 'background polling must not reset readiness to Connecting'); network.requests[1].response({ ok: true, text: () => new Promise(() => {}) });
  timers.advance(12000); await flush();
  assert.equal(network.requests[1].options.signal.aborted, true);
  assert.equal(store.getSnapshot().loading, false); assert.equal(store.getSnapshot().error, 'Usage data unavailable');
  assert.equal(store.getSnapshot().data.generatedAt, 1);
  timers.advance(30000); assert.equal(network.requests.length, 3);
  network.requests[2].finish({ providers: 'malformed' }); await flush();
  assert.equal(store.getSnapshot().data.generatedAt, 1); assert.ok(store.getSnapshot().error);
  const refreshed = store.refresh(); network.requests[3].finish({ providers: [], generatedAt: 4 }); await refreshed;
  assert.equal(store.getSnapshot().data.generatedAt, 4); assert.equal(store.getSnapshot().error, null); stop();
});

test('board readers share a request; mutation confirmation invalidates a stale poll and keeps current CSRF', async () => {
  const timers = clock(), network = deferredFetch(), snapshots = [];
  const client = createTaskBoardClient({ ...network, ...timers, onSnapshot: data => snapshots.push(data) });
  const first = client.refresh(), joined = client.refresh(); assert.equal(network.requests.length, 1);
  network.requests[0].finish(board('before', 'token-before')); await Promise.all([first, joined]);
  const oldPoll = client.refresh({ quiet: true });
  const action = client.mutate('/api/office/tasks', 'POST', { title: 'User request' });
  assert.equal(network.requests[2].options.headers['X-Office-Token'], 'token-before');
  network.requests[2].finish({ id: 'saved' }); await flush();
  assert.equal(network.requests[1].options.signal.aborted, true);
  network.requests[3].finish(board('after', 'token-after')); await action;
  network.requests[1].finish(board('stale', 'token-stale')); await oldPoll; await flush();
  assert.deepEqual(snapshots.map(value => value.tasks[0].id), ['before', 'after']);
  const next = client.mutate('/api/office/settings', 'PATCH', { autoPickup: true });
  assert.equal(network.requests[4].options.headers['X-Office-Token'], 'token-after');
  network.requests[4].finish({ autoPickup: true }); await flush(); network.requests[5].finish(board('confirmed', 'token-after')); await next;
  client.stop();
});

test('an older successful action cannot clear the failure of a newer action', async () => {
  const timers = clock(), network = deferredFetch(), failures = []; let success = 0;
  const client = createTaskBoardClient({ ...network, ...timers, onMutationSuccess: () => success++, onMutationError: error => failures.push(error.message) });
  const initial = client.refresh(); network.requests[0].finish(board()); await initial;
  const oldAction = client.mutate('/first', 'POST', {}), newer = client.mutate('/second', 'POST', {});
  const rejected = assert.rejects(newer, /Version changed/);
  network.requests[2].finish({ error: 'Version changed' }, 409); await flush(); network.requests[3].finish(board('new-version')); await rejected;
  network.requests[1].finish({ id: 'first' }); await flush(); network.requests[4].finish(board()); await oldAction;
  assert.deepEqual(failures, ['Version changed']); assert.equal(success, 0); client.stop();
});

test('unconfirmed mutations time out without resend and retain the saved-versus-unsaved warning', async () => {
  const timers = clock(), network = deferredFetch(), failures = [], pending = [];
  const client = createTaskBoardClient({ ...network, ...timers, onMutationError: error => failures.push(error.message), onPending: value => pending.push(value) });
  const initial = client.refresh(); network.requests[0].finish(board()); await initial;
  const action = client.mutate('/create', 'POST', {}), rejected = assert.rejects(action, /check whether it was saved before retrying/);
  timers.advance(45000); await rejected;
  network.requests[1].finish({ id: 'possibly-saved' }); await flush();
  assert.equal(network.requests.length, 2); assert.equal(failures.length, 1); assert.equal(pending.at(-1), 0); client.stop();
});

test('unmount/remount rejects late reads and invalid board JSON cannot wipe the last good snapshot', async () => {
  const timers = clock(), network = deferredFetch(), snapshots = [], errors = [];
  const client = createTaskBoardClient({ ...network, ...timers, onSnapshot: data => snapshots.push(data), onRefreshError: error => errors.push(error.message) });
  const initial = client.refresh(); client.stop(); client.start();
  const fresh = client.refresh(); network.requests[1].finish(board('new-mount')); await fresh;
  network.requests[0].finish(board('old-mount')); await initial; await flush();
  const invalid = client.refresh(); network.requests[2].finish({ tasks: 'wrong' }); await invalid;
  assert.deepEqual(snapshots.map(value => value.tasks[0].id), ['new-mount']); assert.match(errors[0], /invalid task board/); client.stop();
});


test('a lost write response warns about uncertain completion; it never resends the mutation', async () => {
  const timers = clock(), network = deferredFetch();
  const client = createTaskBoardClient({ ...network, ...timers });
  const initial = client.refresh(); network.requests[0].finish(board()); await initial;
  const write = client.mutate('/create', 'POST', {}), rejected = assert.rejects(write, /check whether it was saved before retrying/);
  network.requests[1].fail(new TypeError('Failed to fetch')); await rejected;
  assert.equal(network.requests.length, 2); client.stop();
});

test('a rejected CSRF token refreshes readiness without replaying the user write', async () => {
  const timers = clock(), network = deferredFetch();
  const client = createTaskBoardClient({ ...network, ...timers });
  const initial = client.refresh(); network.requests[0].finish(board('old', 'old-token')); await initial;
  const write = client.mutate('/create', 'POST', {}), rejected = assert.rejects(write, /Refresh the board/);
  network.requests[1].finish({ error: 'Refresh the board before making changes.' }, 403); await flush();
  assert.equal(network.requests.length, 3); assert.equal(network.requests[2].url, '/api/office/board');
  network.requests[2].finish(board('fresh', 'fresh-token')); await rejected;
  const next = client.mutate('/create', 'POST', {});
  assert.equal(network.requests[3].options.headers['X-Office-Token'], 'fresh-token');
  network.requests[3].finish({ id: 'saved' }); await flush(); network.requests[4].finish(board()); await next;
  assert.equal(network.requests.filter(request => request.url === '/create').length, 2); client.stop();
});
