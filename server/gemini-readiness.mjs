import { execFile } from 'node:child_process';
import { workerEnvironment } from './worker-environment.mjs';

export const DEFAULT_AGY_PATH = '/Applications/Gemini.app/Contents/Helpers/agy';
const MAX_BYTES = 256 * 1024;
const AUTH_REQUIRED = /please\s+(?:sign|log)\s*in|not\s+(?:signed|logged)\s*in|(?:login|sign.in|authentication)\s+(?:is\s+)?required|unauthenticated|unauthorized|\b401\b/i;
const NETWORK_FAILURE = /ENOTFOUND|ECONN(?:REFUSED|RESET)|EHOSTUNREACH|ETIMEDOUT|network (?:error|unavailable)|fetch failed|connection (?:refused|reset)|unable to connect|certificate/i;
const INCOMPATIBLE = /unknown (?:command|option)|unrecognized (?:command|option)|invalid (?:command|option)|unexpected argument|command not found/i;
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const geminiLoginCommand = (command = DEFAULT_AGY_PATH) => shellQuote(command);
export const geminiLoginReason = (command = DEFAULT_AGY_PATH) => `Needs login: on the office computer, run ${geminiLoginCommand(command)} with no arguments and sign in with your Google account. Gemini App and the standalone CLI have separate sign-in sessions. No API key is required.`;

// This adapter intentionally uses the subscription session. Do not switch it to
// API-key, Vertex, GCA or application-default credentials inherited by the office.
export function geminiEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(workerEnvironment(environment)).filter(([key]) =>
    !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key)));
}

export function classifyGeminiReadiness(result = {}, { command = DEFAULT_AGY_PATH, now = Date.now } = {}) {
  const text = `${String(result.stdout || '').slice(0, MAX_BYTES)}\n${String(result.stderr || '').slice(0, MAX_BYTES)}`;
  const base = { authenticated: false, needsLogin: false, authState: 'unknown', reason: 'Gemini login could not be verified. Check the agy installation and connection; a failed probe is not proof of sign-out.', modelIds: [], checkedAt: new Date(now()).toISOString(), loginCommand: null };
  if (AUTH_REQUIRED.test(text)) return { ...base, authState: 'needs-login', needsLogin: true, loginCommand: geminiLoginCommand(command), reason: geminiLoginReason(command) };
  if (result.timedOut || result.killed || result.code === 'ETIMEDOUT') return { ...base, authState: 'unavailable', reason: 'Gemini connection check timed out. Retry after checking the network; login status remains unconfirmed.' };
  if (NETWORK_FAILURE.test(text) || NETWORK_FAILURE.test(String(result.code || ''))) return { ...base, authState: 'unavailable', reason: 'Gemini connection check failed. Check the network and retry; login status remains unconfirmed.' };
  if (INCOMPATIBLE.test(text)) return { ...base, reason: 'The configured CLI does not support agy models. Select the compatible Antigravity agy command in office setup.' };
  if (result.success === true) {
    const modelIds = [...new Set(String(result.stdout || '').match(/\bgemini-[a-z0-9][a-z0-9._-]{0,150}/gi) || [])].slice(0, 100);
    if (modelIds.length) return { ...base, authState: 'ready', authenticated: true, reason: null, modelIds };
  }
  return base;
}

function runModels(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, { env: options.env, signal: options.signal, timeout: options.timeoutMs, maxBuffer: MAX_BYTES, windowsHide: true }, (error, stdout, stderr) => resolve({ success: !error, stdout, stderr, code: error?.code, killed: error?.killed }));
  });
}

// Read-only public CLI metadata only. No prompt, login, credential-file access,
// browser interaction or automatic account recovery occurs here.
export async function probeGeminiReadiness({ command = DEFAULT_AGY_PATH, env = process.env, signal, run = runModels, check, now = Date.now, timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted();
  if (check) {
    try {
      const result = await check(command);
      if (typeof result === 'boolean') return result
        ? { authenticated: true, needsLogin: false, authState: 'ready', reason: null, modelIds: [], checkedAt: new Date(now()).toISOString(), loginCommand: null }
        : classifyGeminiReadiness({ stdout: 'Please sign in', success: false }, { command, now });
      return classifyGeminiReadiness(result, { command, now });
    } catch { return classifyGeminiReadiness({}, { command, now }); }
  }
  let result;
  try { result = await run(command, ['models'], { env: geminiEnvironment(env), signal, timeoutMs }); }
  catch (error) { result = { success: false, stdout: error.stdout, stderr: error.stderr, code: error.code, killed: error.killed, timedOut: /timeout|timed out/i.test(String(error.message || '')) }; }
  signal?.throwIfAborted();
  return classifyGeminiReadiness(typeof result === 'string' ? { success: true, stdout: result } : result, { command, now });
}

export function geminiModelHold(task, connection, { model, highModel } = {}) {
  const requested = task?.priority === 'high' ? highModel || model : model;
  if (!requested || !connection?.authenticated || !Array.isArray(connection.modelIds) || !connection.modelIds.length || connection.modelIds.includes(requested)) return null;
  return `Configured Gemini model ${requested} is not in the verified agy model list. Select an available model in office setup; the task has not been claimed.`;
}
