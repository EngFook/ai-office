import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskStore } from '../server/task-store.mjs';
import { humanRequestFingerprint } from '../server/human-relay-policy.mjs';

test('unchanged Qwen follow-ups advance check times without invalidating an open task edit or human question', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-follow-up-')));
  const projectPath = path.join(home, 'project'); await mkdir(projectPath);
  let clock = 1000;
  const store = createTaskStore({ home, now: () => clock, crossReview: false });
  t.after(() => { store.close(); return rm(home, { recursive: true, force: true }); });
  let task = store.createTask({ title: 'Fix the supplied issue', provider: 'codex', projectPath });
  task = store.updateTask(task.id, { status: 'blocked' });
  const fields = { owner: 'codex', state: 'waiting_capacity', nextAction: 'Wait for the assigned worker.', nextCheckAt: new Date(301000).toISOString() };
  const first = store.recordResolution(task.id, { ...fields, version: task.version });
  const fingerprint = humanRequestFingerprint(first);
  clock += 300000;
  const second = store.recordResolution(task.id, { ...fields, version: first.version, nextCheckAt: new Date(clock + 300000).toISOString() });
  assert.equal(second.version, first.version);
  assert.notEqual(second.resolution.checkedAt, first.resolution.checkedAt);
  assert.notEqual(second.resolution.nextCheckAt, first.resolution.nextCheckAt);
  assert.equal(humanRequestFingerprint(second), fingerprint);
  const edited = store.updateTask(task.id, { description: 'The user supplied additional scope.' }, { version: first.version });
  assert.equal(edited.description, 'The user supplied additional scope.');
  assert.ok(edited.version > first.version);
});

test('changing the owner, next action, or resolution state still changes the optimistic version', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'office-follow-up-change-')));
  const store = createTaskStore({ home, crossReview: false });
  t.after(() => { store.close(); return rm(home, { recursive: true, force: true }); });
  let task = store.createTask({ title: 'Await diagnosis', provider: 'codex' });
  task = store.updateTask(task.id, { status: 'blocked' });
  let fields = { owner: 'codex', state: 'waiting_capacity', nextAction: 'Wait for diagnosis.', nextCheckAt: new Date().toISOString() };
  task = store.recordResolution(task.id, { ...fields, version: task.version });
  for (const change of [{ owner: 'claude' }, { state: 'following_up' }, { nextAction: 'Verify the recorded fix.' }]) {
    fields = { ...fields, ...change };
    const next = store.recordResolution(task.id, { ...fields, version: task.version });
    assert.equal(next.version, task.version + 1); task = next;
  }
});
