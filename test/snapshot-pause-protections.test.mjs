import test from 'node:test';
import assert from 'node:assert/strict';
import { resolutionPaused } from '../server/resolution-policy.mjs';

test('all ten historical user pauses also hold review and recovery cards', () => {
  for (const prefix of ['254f2a15', '6be29085', 'e7fa33c3', '847fec28', '2d278b15', '01de6905', '720668dc', '12e8a2d5', 'd7e12489', '8da3ec84']) {
    for (const key of ['id', 'reviewOf', 'resolutionOf']) assert.equal(resolutionPaused({ [key]: `${prefix}-fixture` }), true);
  }
  assert.equal(resolutionPaused({ id: 'ordinary-fixture' }), false);
});
