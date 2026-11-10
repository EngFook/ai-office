import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlan, parseArgs, runningCount } from '../scripts/merge-when-idle.mjs';

test('running count uses the larger of task status and runtime', () => {
  assert.equal(runningCount({ tasks: [{ status: 'running' }, { status: 'pending' }], runtime: { running: [] } }), 1);
  assert.equal(runningCount({ tasks: [], runtime: { running: [{}, {}] } }), 2);
  assert.throws(() => runningCount({}), /unavailable/);
  assert.throws(() => runningCount({ tasks: [], runtime: { available: false, running: [] } }), /unavailable/);
});

test('merge plan only merges clean live main, preferring fast-forward', () => {
  assert.deepEqual(mergePlan({ liveBranch: 'main', clean: true, isAncestor: true, conflictFree: true }), { ok: true, mode: 'ff-only' });
  assert.deepEqual(mergePlan({ liveBranch: 'main', clean: true, isAncestor: false, conflictFree: true }), { ok: true, mode: 'merge' });
  assert.equal(mergePlan({ liveBranch: 'main', clean: true, isAncestor: false, conflictFree: false }).ok, false);
  assert.equal(mergePlan({ liveBranch: 'main', clean: false, isAncestor: true, conflictFree: true }).ok, false);
  assert.match(mergePlan({ liveBranch: 'pending-acceptance/x', clean: true, isAncestor: true, conflictFree: true }).reason, /not main/);
  assert.match(mergePlan({ liveBranch: null, clean: true, isAncestor: true, conflictFree: true }).reason, /detached/);
});

test('arguments accept a branch and API checks only', () => {
  assert.deepEqual(parseArgs(['start', 'codex/x', '--check', '/api/office/work-reports']), { command: 'start', branch: 'codex/x', checks: ['/api/office/work-reports'] });
  assert.throws(() => parseArgs(['merge', 'x']));
  assert.throws(() => parseArgs(['run', '-x']));
  assert.throws(() => parseArgs(['run', 'a..b']));
  assert.throws(() => parseArgs(['run', 'x', '--check', 'http://evil/api']));
  assert.throws(() => parseArgs(['run', 'x', '--force']));
});


test('idle gate drains watch decisions as well as board workers and rejects malformed decision status', () => {
  assert.equal(runningCount({ tasks: [], runtime: { running: [], watchDecisions: ['codex'] } }), 1);
  assert.equal(runningCount({ tasks: [{ status: 'running' }], runtime: { running: [{}], watchDecisions: ['codex', 'gemini'] } }), 3);
  assert.throws(() => runningCount({ tasks: [], runtime: { running: [], watchDecisions: 'unknown' } }), /unavailable/);
});
