import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { humanRequestFingerprint } from '../server/human-relay-policy.mjs';
import { meetingScope, blockingKey, meetingBarrierAllows } from '../server/blocked-meeting-policy.mjs';
import { watchFingerprint } from '../server/watch-task-policy.mjs';

test('changing a research source project invalidates approvals, meetings and watch decisions', () => {
  const task = { id: 'fixture', title: 'Compare implementation', description: 'Inspect selected project', provider: 'gemini', kind: 'research', role: 'Helper', projectPath: '/notes', contextProjectPath: '/projects/one', error: 'Dependency missing' };
  const changed = { ...task, contextProjectPath: '/projects/two' };
  for (const fingerprint of [humanRequestFingerprint, meetingScope, blockingKey, watchFingerprint]) assert.notEqual(fingerprint(task), fingerprint(changed));
  const record = { status: 'resolved', resolutions: { fixture: { status: 'split', scope: meetingScope(task) } } };
  assert.equal(meetingBarrierAllows(task, record), true);
  assert.equal(meetingBarrierAllows(changed, record), false);
});

test('legacy tasks retain fingerprint compatibility until a source project is selected', () => {
  const task = { id: 'fixture', title: 'Legacy request', provider: 'codex', projectPath: '/projects/one' };
  const digest = array => createHash('sha256').update(JSON.stringify(array)).digest('hex');
  assert.equal(humanRequestFingerprint(task), digest([task.id, task.title, task.description, task.provider, task.projectPath, task.kind, task.role, task.reviewOf, task.supportType, task.priority, '', '', 0, 0]));
  assert.equal(meetingScope(task), digest([task.title, task.description, task.provider, task.role, task.projectPath]));
  assert.equal(watchFingerprint(task), digest([task.id, task.provider, task.title, task.description, task.projectPath, task.error, task.result]));
});
