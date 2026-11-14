import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeminiReadiness, probeGeminiReadiness, geminiModelHold, geminiLoginCommand, geminiEnvironment } from '../server/gemini-readiness.mjs';
const now = () => Date.parse('2026-11-10T02:00:00+08:00');

test('only successful actual model metadata verifies Gemini login', () => {
  const result = classifyGeminiReadiness({ success: true, stdout: 'Available models:\ngemini-fixture-medium\ngemini-fixture-high\ngemini-fixture-medium' }, { now });
  assert.equal(result.authState, 'ready'); assert.equal(result.authenticated, true);
  assert.deepEqual(result.modelIds, ['gemini-fixture-medium', 'gemini-fixture-high']);
  for (const value of [{ success: false, stdout: 'gemini-fake' }, { success: true, stdout: '' }, { success: true, stdout: 'Please sign in. gemini-previous' }]) assert.equal(classifyGeminiReadiness(value, { now }).authenticated, false);
});

test('explicit sign-in failures have an actionable command; network and unknown failures do not claim sign-out', () => {
  const auth = classifyGeminiReadiness({ success: false, stderr: 'Error: Please sign in to view available models.' }, { command: '/Apps/My Gemini/agy', now });
  assert.match(auth.reason, /Gemini App and the standalone CLI have separate sign-in sessions/);
  assert.equal(auth.authState, 'needs-login'); assert.equal(auth.needsLogin, true); assert.equal(auth.loginCommand, "'/Apps/My Gemini/agy'");
  for (const result of [{ killed: true }, { code: 'ETIMEDOUT' }, { stderr: 'ECONNRESET Bearer private-value' }, { stderr: 'unknown command models' }, { success: false, stderr: 'private-value' }]) {
    const value = classifyGeminiReadiness(result, { now });
    assert.equal(value.needsLogin, false); assert.equal(value.loginCommand, null); assert.equal(value.authenticated, false);
    assert.equal(JSON.stringify(value).includes('private-value'), false);
  }
  assert.equal(geminiLoginCommand("/Applications/A's app/agy"), "'/Applications/A'\\''s app/agy'");
});

test('probe invokes only models with subscription environment and preserves cancellation', async () => {
  const env = { HOME: '/fixture', PATH: '/bin', GROK_BOT_WEBHOOK_AUTH: 'private', AI_OFFICE_URL: 'private', GEMINI_API_KEY: 'private', GOOGLE_API_KEY: 'private', GOOGLE_APPLICATION_CREDENTIALS: '/private', GOOGLE_GENAI_USE_VERTEXAI: '1', GOOGLE_GENAI_USE_GCA: '1' };
  const safe = geminiEnvironment(env); assert.deepEqual(safe, { HOME: '/fixture', PATH: '/bin' });
  const result = await probeGeminiReadiness({ command: '/fixture/agy', env, now, run: async (command, args, options) => { assert.equal(command, '/fixture/agy'); assert.deepEqual(args, ['models']); assert.deepEqual(options.env, safe); return { success: true, stdout: 'gemini-actual' }; } });
  assert.equal(result.authenticated, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeGeminiReadiness({ signal: controller.signal, run: () => assert.fail('must not execute') }), /abort/i);
  assert.equal((await probeGeminiReadiness({ now, run: async () => { throw Object.assign(new Error('failure'), { code: 'ECONNREFUSED' }); } })).authState, 'unavailable');
});

test('model availability guards exact configured normal and high models before claim', () => {
  const connection = { authenticated: true, modelIds: ['gemini-normal'] };
  const settings = { model: 'gemini-normal', highModel: 'gemini-high' };
  assert.equal(geminiModelHold({}, connection, settings), null);
  assert.match(geminiModelHold({ priority: 'high' }, connection, settings), /not in the verified/);
  assert.equal(geminiModelHold({ priority: 'high' }, { authenticated: false }, settings), null);
  assert.equal(geminiModelHold({}, { authenticated: true, modelIds: [] }, settings), null, 'unknown model discovery does not invent an unsupported status');
});
