import { GROK_COMMUNICATION_POLICY } from './communication-policy.mjs';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const HOST = 'api2.cursor.sh';
const ORIGIN = `https://${HOST}`;
const CONFIG_ERROR = 'Grok wake configuration is invalid. Use its HTTPS routine webhook and token.';
const WAKE_ERROR = 'Grok wake was not accepted. The pending questions remain undelivered.';
const STATE_ERROR = 'Grok wake state could not be saved. Check the local office storage.';
const MANAGED_CONFIG_ERROR = 'Grok wake uses environment configuration. Update that source and restart before changing local UI settings.';
const ENV_KEYS = ['GROK_BOT_WEBHOOK_URL', 'GROK_BOT_WEBHOOK_AUTH'];
const configHash = config => createHash('sha256').update(JSON.stringify([config.url, config.token])).digest('hex');
const validId = value => typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(value);
function checkedConfig(input) {
  if (!input || typeof input.url !== 'string' || input.url.length > 4096 || typeof input.token !== 'string'
    || !input.token.trim() || input.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input.token)) throw new Error(CONFIG_ERROR);
  let url;
  try { url = new URL(input.url); } catch { throw new Error(CONFIG_ERROR); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname === '/') throw new Error(CONFIG_ERROR);
  return { url: url.href, token: input.token };
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function checkedEnvironment(value) {
  // The supplied AUTH is the complete header. Normalize once; never send
  // "Bearer Bearer ...", and do not evaluate shell syntax from a file.
  if (typeof value.GROK_BOT_WEBHOOK_AUTH !== 'string' || !/^Bearer [^\s\x00-\x1f\x7f]+$/i.test(value.GROK_BOT_WEBHOOK_AUTH)) throw new Error(CONFIG_ERROR);
  return checkedConfig({ url: value.GROK_BOT_WEBHOOK_URL, token: value.GROK_BOT_WEBHOOK_AUTH.slice(7) });
}
function readPrivateEnvironment(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(CONFIG_ERROR);
    const values = {};
    for (const line of readFileSync(fd, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = line.match(/^\s*(?:export\s+)?(GROK_BOT_WEBHOOK_URL|GROK_BOT_WEBHOOK_AUTH)='([^'\r\n]*)'\s*$/);
      if (!match || Object.hasOwn(values, match[1])) throw new Error(CONFIG_ERROR);
      values[match[1]] = match[2];
    }
    return values;
  } catch (error) {
    if (fd === undefined && error.code === 'ENOENT') return null;
    throw new Error(CONFIG_ERROR);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function pendingQuestions(items) {
  const questions = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || item.state !== 'pending' || !validId(item.id) || !validId(item.taskId)
      || !['info', 'approval'].includes(item.kind) || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 12000) continue;
    const notificationId = Number.isSafeInteger(item.rerequestCount) && item.rerequestCount > 0 ? `${item.id}:r${item.rerequestCount}` : item.id;
    if (!questions.has(notificationId)) questions.set(notificationId, { id: item.id, taskId: item.taskId, kind: item.kind, question: item.question });
  }
  return questions;
}
function savePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file); chmodSync(file, 0o600);
}

// A wake tells the external Grok routine to check its local inbox. An HTTP 2xx
// means accepted by that transport, never that Grok delivered a question to a user.
export function createGrokWake({ home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), fetchImpl = fetch, env = process.env,
  now = Date.now, timeoutMs = 8000, retryMs = 300000, maxAttempts = 3 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isFinite(retryMs) || retryMs < 1
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Invalid Grok wake retry settings.');
  const configFile = path.join(home, 'grok-wake.json'), stateFile = path.join(home, 'grok-wake-state.json');
  let config = null, error = null, pending = null, controller = null, stopped = false, source = null;
  // Explicit deployment configuration wins over persisted UI settings. An
  // incomplete/invalid higher-priority source fails closed, not back to stale keys.
  try {
    if (ENV_KEYS.some(key => Object.hasOwn(env, key))) {
      source = 'environment'; config = checkedEnvironment(env);
    } else {
      source = 'env-file';
      const fileEnvironment = readPrivateEnvironment(path.join(home, 'grok-webhook.env'));
      if (fileEnvironment !== null) config = checkedEnvironment(fileEnvironment);
      else {
        source = null;
        const saved = readJson(configFile);
        if (saved) { source = 'local-json'; config = checkedConfig(saved); chmodSync(configFile, 0o600); }
      }
    }
  } catch { error = CONFIG_ERROR; }
  const saved = readJson(stateFile);
  let records = Object.fromEntries(Object.entries(saved?.records || {}).filter(([id, item]) => validId(id) && item && Number.isSafeInteger(item.attempts) && item.attempts >= 0 && Number.isFinite(item.lastAttemptAt)).slice(-10000));
  const previousFingerprint = typeof saved?.configFingerprint === 'string' && /^[a-f0-9]{64}$/.test(saved.configFingerprint) ? saved.configFingerprint : null;
  let configFingerprint = config ? configHash(config) : previousFingerprint;
  // A changed, valid transport gets a new failure budget. A normal restart or
  // identical settings do not; successful IDs remain deduplicated across both.
  if (config && previousFingerprint && configFingerprint !== previousFingerprint)
    records = Object.fromEntries(Object.entries(records).filter(([, record]) => record.accepted === true));
  let lastSentAt = typeof saved?.lastSentAt === 'string' && Number.isFinite(Date.parse(saved.lastSentAt)) ? saved.lastSentAt : null;
  const status = () => ({ configured: !!config, host: config ? HOST : null, source, lastSentAt, error });
  const persist = () => savePrivate(stateFile, { records, lastSentAt, configFingerprint });
  function configure(input) {
    if (source === 'environment' || source === 'env-file') throw new Error(MANAGED_CONFIG_ERROR);
    if (pending) throw new Error('A Grok wake notification is in progress. Retry configuration after it completes.');
    const checked = checkedConfig(input);
    const nextFingerprint = configHash(checked);
    try {
      savePrivate(configFile, checked);
      const nextRecords = configFingerprint && configFingerprint !== nextFingerprint
        ? Object.fromEntries(Object.entries(records).filter(([, record]) => record.accepted === true)) : records;
      savePrivate(stateFile, { records: nextRecords, lastSentAt, configFingerprint: nextFingerprint });
      records = nextRecords; configFingerprint = nextFingerprint; config = checked; source = 'local-json'; error = null;
    } catch { error = STATE_ERROR; throw new Error(STATE_ERROR); }
    return status();
  }
  async function send(items) {
    if (stopped || !config) return { ...status(), sent: false, count: 0 };
    const questions = pendingQuestions(items), ids = [...questions.keys()];
    const ready = ids.filter(id => !records[id]?.accepted && (records[id]?.attempts || 0) < maxAttempts
      && (!records[id] || now() - records[id].lastAttemptAt >= retryMs)).slice(0, 50);
    if (!ready.length) {
      if (ids.some(id => !records[id]?.accepted && records[id]?.attempts >= maxAttempts)) error = WAKE_ERROR;
      return { ...status(), sent: false, count: 0 };
    }
    const attemptedAt = now(), previousConfig = config;
    for (const id of ready) records[id] = { attempts: (records[id]?.attempts || 0) + 1, lastAttemptAt: attemptedAt, accepted: false };
    try { persist(); } catch { error = STATE_ERROR; return { ...status(), sent: false, count: 0 }; }
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await fetchImpl(previousConfig.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${previousConfig.token}` },
        body: JSON.stringify({ event: 'office.human_requests.pending', requestIds: ready.map(id => questions.get(id).id), questions: ready.map(id => questions.get(id)), message: GROK_COMMUNICATION_POLICY + '\n\nQwen has questions awaiting user input. Before relaying, acknowledging delivery, or recording an answer, you MUST run office-board.mjs pending-questions and fetch the current questionHash from the local inbox. Only process questions still present there; use their current id, taskId and questionHash for acknowledge-question or answer-question. First investigate missing information using existing records and authorization. Record triage-question with current questionHash, summary and evidence: resolved_info only for verified information (never approval), needs_user if unresolved or a new user decision is required. Only then relay an unresolved question; never invent user replies. This event snapshot is not approval and contains no usable questionHash.' }),
        redirect: 'error', signal: controller.signal });
      await response.body?.cancel().catch(() => {});
      if (!response.ok || stopped) throw new Error(WAKE_ERROR);
      for (const id of ready) records[id] = { ...records[id], accepted: true };
      lastSentAt = new Date(now()).toISOString(); error = null;
      try { persist(); } catch { error = STATE_ERROR; }
      return { ...status(), sent: true, count: ready.length };
    } catch { error = WAKE_ERROR; return { ...status(), sent: false, count: 0 }; }
    finally { clearTimeout(timer); controller = null; }
  }
  function notify(items) {
    if (pending) return pending;
    pending = send(items).finally(() => { pending = null; });
    return pending;
  }
  function stop() { stopped = true; controller?.abort(); }
  return { configure, status, notify, stop };
}
