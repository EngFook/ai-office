import test from 'node:test';
import assert from 'node:assert/strict';
import { openHumanRequests, humanRelayStateLabel } from '../src/human-relay-ui.js';

test('human relay lists only unanswered live questions and never describes pending as delivered', () => {
  const requests = ['pending', 'delivered', 'answered', 'denied', 'stale'].map((state, i) => ({ id: `request-${i}`, state }));
  assert.deepEqual(openHumanRequests([...requests, null]).map(item => item.state), ['pending', 'delivered']);
  assert.deepEqual(openHumanRequests(null), []);
  assert.match(humanRelayStateLabel('pending'), /尚未确认送达/);
  assert.match(humanRelayStateLabel('pending', false), /delivery not confirmed/);
  assert.match(humanRelayStateLabel('delivered'), /已确认转告/);
  assert.match(humanRelayStateLabel('delivered', false), /confirmed delivery/);
});

test('question actions bind explicit choices, preserve typed conditions and keep re-request separate from approval', async () => {
  const { questionActionPayload, questionErrorMessage } = await import('../src/human-relay-ui.js');
  const approval = { questionHash: 'current', kind: 'approval' }, info = { questionHash: 'info', kind: 'info' };
  const confirmed = questionActionPayload(approval, 'approve', '仅测试环境');
  assert.equal(confirmed.questionHash, 'current'); assert.equal(confirmed.decision, 'approve'); assert.ok(confirmed.userReply.includes('仅测试环境'));
  assert.equal(questionActionPayload(approval, 'deny').decision, 'deny');
  assert.deepEqual(questionActionPayload(approval, 'rerequest'), { questionHash: 'current' });
  assert.throws(() => questionActionPayload(info, 'approve'));
  assert.throws(() => questionActionPayload(info, 'provide_info', ''));
  assert.equal(questionActionPayload(info, 'restored').decision, 'provide_info');
  assert.throws(() => questionActionPayload(info, 'provide_info', 'Some info', '/tmp/project'));
  assert.equal(questionActionPayload(info, 'provide_info', 'Use /tmp/project', '/tmp/project').projectPath, '/tmp/project');
  assert.match(questionErrorMessage('Question binding does not match.'), /问题已更新/);
});
