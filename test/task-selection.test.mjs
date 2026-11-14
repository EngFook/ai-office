import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedForScope } from '../src/task-selection.js';

test('bulk selection drops hidden and newly running cards while preserving the version the user selected', () => {
  const checked = { a: { id: 'a', version: 1 }, b: { id: 'b', version: 2 }, c: { id: 'c', version: 3 } };
  assert.deepEqual(selectedForScope(checked, [{ id: 'a', status: 'blocked', version: 4 }, { id: 'b', status: 'running' }]), [{ id: 'a', version: 1 }]);
  assert.deepEqual(selectedForScope(checked, [{ id: 'b', status: 'running' }]), []);
  const many = Array.from({ length: 110 }, (_, id) => ({ id: String(id), status: 'pending' }));
  assert.equal(selectedForScope(Object.fromEntries(many.map(task => [task.id, task])), many).length, 100);
});
