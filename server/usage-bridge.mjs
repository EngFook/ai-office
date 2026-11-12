// Read-only local usage summary. Only token counts / rate-limit percentages are read
// from CLI session logs; no credential files (auth.json, keys) are ever opened.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { localQwen } from './local-qwen.mjs';
import { probeGeminiReadiness } from './gemini-readiness.mjs';

const DAY = 864e5;
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const walk = (dir, since, out = []) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {} }
  }
  return out;
};
const lines = async (file, fn) => {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { if (line.length > 2_000_000) continue; try { fn(JSON.parse(line)); } catch {} }
};
const bucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 });
const add = (b, u) => { b.input += u.input; b.output += u.output; b.cacheRead += u.cacheRead; b.cacheWrite += u.cacheWrite; b.total += u.input + u.output + u.cacheRead + u.cacheWrite; b.messages++; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export async function readClaudeUsage(home = os.homedir()) {
  const now = Date.now(), today = startOfToday(), week = now - 7 * DAY, fiveH = now - 5 * 36e5;
  const files = walk(path.join(home, '.claude', 'projects'), week);
  const models = {}, seen = new Set();
  for (const f of files) await lines(f, d => {
    const u = d?.message?.usage, t = Date.parse(d?.timestamp);
    if (!u || !(t >= week)) return;
    const id = d.message.id || d.uuid; if (id) { if (seen.has(id)) return; seen.add(id); }
    const model = d.message.model || 'unknown'; if (model === '<synthetic>') return;
    const m = models[model] ||= { model, last5h: bucket(), today: bucket(), week: bucket(), lastUsedAt: 0 };
    const x = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
    add(m.week, x); if (t >= today) add(m.today, x); if (t >= fiveH) add(m.last5h, x);
    m.lastUsedAt = Math.max(m.lastUsedAt, t);
  });
  return { provider: 'Claude Code', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: '~/.claude/projects/*.jsonl', models: Object.values(models).sort((a, b) => b.week.total - a.week.total),
    limits: null, limitsNote: 'Claude CLI does not write plan limit % / reset time to local logs (only visible via /usage inside Claude).' };
}

export async function readCodexUsage(home = os.homedir()) {
  const now = Date.now(), today = startOfToday(), week = now - 7 * DAY, fiveH = now - 5 * 36e5;
  const files = walk(path.join(home, '.codex', 'sessions'), week);
  const models = {}; let limits = null, limitsAt = 0;
  for (const f of files) { let model = 'unknown'; await lines(f, d => {
    const p = d?.payload, t = Date.parse(d?.timestamp);
    if (d?.type === 'turn_context' && p?.model) model = p.model;
    if (p?.type !== 'token_count' || !(t >= week)) return;
    if (p.rate_limits && t > limitsAt) { limitsAt = t; limits = p.rate_limits; }
    const u = p.info?.last_token_usage; if (!u) return;
    const m = models[model] ||= { model, last5h: bucket(), today: bucket(), week: bucket(), lastUsedAt: 0 };
    const cached = u.cached_input_tokens || 0;
    const x = { input: Math.max(0, (u.input_tokens || 0) - cached), output: u.output_tokens || 0, cacheRead: cached, cacheWrite: u.cache_write_input_tokens || 0 };
    add(m.week, x); if (t >= today) add(m.today, x); if (t >= fiveH) add(m.last5h, x);
    m.lastUsedAt = Math.max(m.lastUsedAt, t);
  }); }
  const win = w => w && validPercent(w.used_percent) ? { usedPercent: w.used_percent, remainingPercent: 100 - w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null } : null;
  return { provider: 'Codex', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: '~/.codex/sessions/**/*.jsonl', models: Object.values(models).sort((a, b) => b.week.total - a.week.total),
    limits: limits ? { plan: limits.plan_type || null, primary: win(limits.primary), secondary: win(limits.secondary), credits: limits.credits ? { balance: limits.credits.balance, hasCredits: limits.credits.has_credits, unlimited: limits.credits.unlimited } : null, observedAt: limitsAt } : null,
    limitsNote: limits ? 'Snapshot from the most recent Codex turn; it updates only when Codex runs.' : 'No Codex rate-limit snapshot in the last 7 days.' };
}

export async function readUsage(options = {}) {
  const safe = async (fn, provider) => { try { return await fn(options.home); } catch (e) { return { provider, models: [], limits: null, error: 'unavailable' }; } };
  const providers = [await safe(readClaudeUsage, 'Claude Code'), await safe(readCodexUsage, 'Codex'),
    { provider: 'Gemini', models: [], limits: null, limitsNote: geminiCliInstalled() ? 'Gemini CLI is installed; subscription login has not been verified. Check the task board connection. Quota is unavailable.' : 'Antigravity agy CLI was not found. Configure its command in office setup.' },
    { ...await (options.qwenClient || localQwen).snapshot(), models: [], limits: null },
    { provider: 'Grok', models: [], limits: null, limitsNote: 'Reported by Grok Bot via scripts/office-board.mjs grok-quota.' }];
  return { generatedAt: Date.now(), providers };
}

// Grok Bot reports its own weekly quota into this file (no API, no credentials).
export const GROK_STALE_MS = 6 * 36e5;
export const grokQuotaFile = (root = process.cwd()) => path.join(root, 'reports', 'grok-quota.json');
export function readGrokQuota(root, now = Date.now()) {
  const status = (state, reason, observedAt = null, expiresAt = null) => ({
    state, reason, checkedAt: now, observedAt, expiresAt, source: 'reports/grok-quota.json',
  });
  let d;
  try { d = JSON.parse(fs.readFileSync(grokQuotaFile(root), 'utf8')); }
  catch (error) {
    const missing = error.code === 'ENOENT';
    return { value: null, error: 'stale', status: status(missing ? 'missing' : 'invalid', missing
      ? 'No quota report has been received from Grok Bot. Bot connectivity and quota reporting are separate.'
      : 'The Grok Bot quota report could not be read or validated. A new report is required.') };
  }
  const used = d?.usedPercent, at = d?.observedAt, reset = d?.resetsAt;
  if (!validPercent(used) || typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now + 60000) {
    return { value: null, error: 'stale', status: status('invalid', 'The Grok Bot quota report has invalid usage or observation time. A new report is required.') };
  }
  const resetsAt = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset : null;
  const expiresAt = Math.min(at + GROK_STALE_MS, resetsAt || Infinity);
  const value = { plan: d.plan || null, observedAt: at, reporter: 'Grok Bot', source: 'reports/grok-quota.json', note: d.note || null,
    windows: [{ name: 'Weekly', usedPercent: used, remainingPercent: 100 - used, resetsAt, absoluteReset: true }] };
  if (resetsAt !== null && resetsAt <= now) return { value, error: 'stale', status: status('reset-expired',
    'The reported quota reset has passed. The previous balance is historical; Grok Bot must report the new cycle.', at, expiresAt) };
  if (now - at > GROK_STALE_MS) return { value, error: 'stale', status: status('stale',
    'The Grok Bot quota report is more than 6 hours old. The current balance is unknown until a new report arrives.', at, expiresAt) };
  return { value, error: null, status: status('fresh', 'A recent quota report was received from Grok Bot.', at, expiresAt) };
}

function allowed(request) {
  const address = request.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1'].includes(address) && !address.startsWith('::ffff:127.')) return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && (!request.headers.origin || new URL(request.headers.origin).origin === host.origin) && (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']));
  } catch { return false; }
}

// The panel and resident watch use one cache and the existing quota poller.
// This reader never requests a reset, purchases credits or calls a model.
export function createUsageReader(options = {}) {
  let last = null, at = 0, pending = null;
  const clock = options.now || Date.now;
  return async () => {
    if (!last || clock() - at >= 30000) {
      pending ||= (options.readUsage || readUsage)(options).then(value => { last = value; at = clock(); }).finally(() => { pending = null; });
      await pending;
    }
    const grok = (options.readGrokQuota || readGrokQuota)(options.root, clock());
    const quota = { ...(options.quotaReader || sharedQuota)(), grok: grok.value, grokError: grok.error, grokStatus: grok.status || null };
    const providers = (last.providers || []).map(provider => provider.provider !== 'Gemini' ? provider : { ...provider,
      limitsNote: quota.gemini?.status === 'Subscription login' && !quota.geminiError
        ? 'Subscription login verified via agy models. Read-only research; remaining quota is not exposed by this CLI.'
        : quota.geminiError || provider.limitsNote });
    return structuredClone({ ...last, providers, quota });
  };
}

export function usageBridge(options = {}) {
  const reader = options.reader || createUsageReader(options);
  const middleware = async (request, response, next) => {
    if (request.url?.split('?')[0] !== '/api/usage') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!allowed(request)) { response.statusCode = 403; response.end('{"error":"Local same-origin access only"}'); return; }
    if (request.method !== 'GET') { response.statusCode = 405; response.end('{"error":"Read-only endpoint"}'); return; }
    try { response.end(JSON.stringify(await reader())); }
    catch { response.statusCode = 500; response.end('{"error":"Usage temporarily unavailable"}'); }
  };
  return { name: 'ai-office-usage-bridge', configureServer(s) { s.middlewares.use(middleware); }, configurePreviewServer(s) { s.middlewares.use(middleware); } };
}

// ---- Remaining quota via official CLIs (no credential files are read) ----
import { spawn } from 'node:child_process';
import { workerEnvironment } from './worker-environment.mjs';
const run = (bin, args, { input, ms = 90000, signal, env = process.env } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason || new Error('stopped')); return; }
  const child = spawn(bin, args, { cwd: os.tmpdir(), env: workerEnvironment(env), stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  let out = '', settled = false, timer;
  const finish = (error, value) => {
    if (settled) return; settled = true;
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (error) reject(error); else resolve(value);
  };
  const abort = () => { child.kill('SIGKILL'); finish(signal.reason || new Error('stopped')); };
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('timeout')); }, ms);
  child.stdout.on('data', d => {
    out += d;
    if (Buffer.byteLength(out) > 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Quota response too large.')); return; }
    if (input?.done?.(out)) { child.kill(); finish(null, out); }
  });
  child.on('error', error => finish(error));
  child.on('close', () => finish(null, out));
  child.stdin.on('error', error => { child.kill(); finish(error); });
  if (input?.text) child.stdin.write(input.text); if (!input?.keepOpen) child.stdin.end();
});
const firstExisting = list => list.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
function claudeBin(home = os.homedir()) {
  const cands = [path.join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  const cache = path.join(home, 'Library/Application Support/Claude/claude-code');
  try { for (const v of fs.readdirSync(cache).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) for (const b of fs.readdirSync(path.join(cache, v))) cands.push(path.join(cache, v, b, 'claude.app/Contents/MacOS/claude')); } catch {}
  return firstExisting(cands);
}
const codexBin = () => firstExisting(['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']);

// `claude -p /usage` is a local slash command: 0 API tokens, but it takes ~1 min.
export function parseClaudeUsage(text) {
  const windows = [];
  for (const m of text.matchAll(/Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n]+))?/g)) {
    const used = Number(m[3]);
    if (!validPercent(used)) continue;
    windows.push({ name: `${m[1] === 'session' ? '5-hour session' : 'Weekly'}${m[2] ? ` · ${m[2]}` : ''}`, usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsText: m[4]?.trim() || null });
  }
  return windows;
}
export async function readClaudeQuota(home, options = {}) {
  const bin = options.command ? resolveUsageCommand(options.command, options.env) : claudeBin(home); if (!bin) throw new Error('Claude CLI not found');
  const raw = await (options.run || run)(bin, ['-p', '/usage', '--output-format', 'json'], { ms: 150000, signal: options.signal, env: options.env });
  const result = JSON.parse(raw.slice(raw.indexOf('{'))).result || '';
  const windows = parseClaudeUsage(result);
  if (!windows.length) throw new Error('No quota lines in /usage output');
  return { windows, observedAt: Date.now(), source: 'claude -p /usage' };
}
// Codex app-server `account/rateLimits/read`: official, free, ~1s.
export async function readCodexQuota(options = {}) {
  const bin = options.command ? resolveUsageCommand(options.command, options.env) : codexBin(); if (!bin) throw new Error('Codex CLI not found');
  const msgs = [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai_office', version: '1.0' } } }, { method: 'initialized' }, { id: 2, method: 'account/rateLimits/read' }].map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const out = await (options.run || run)(bin, ['app-server'], { ms: 20000, signal: options.signal, env: options.env, input: { text: msgs, keepOpen: true, done: o => /"id":2,/.test(o) && o.trimEnd().endsWith('}') && o.split('\n').some(l => l.startsWith('{"id":2')) } });
  const line = out.split('\n').find(l => l.startsWith('{"id":2')); const r = JSON.parse(line).result;
  const windows = [];
  for (const lim of Object.values(r.rateLimitsByLimitId || { codex: r.rateLimits })) for (const key of ['primary', 'secondary']) { const w = lim?.[key]; if (!w || !validPercent(w.usedPercent)) continue;
    const mins = w.windowDurationMins; windows.push({ name: `${mins === 300 ? '5-hour' : mins === 10080 ? 'Weekly' : `${Math.round(mins / 60)}h`}${lim.limitName || lim.normalModelSlug ? ` · ${lim.limitName || lim.normalModelSlug}` : ''}`, usedPercent: w.usedPercent, remainingPercent: Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }); }
  return { windows, plan: r.rateLimits?.planType || null, credits: r.rateLimits?.credits?.balance ?? null, resetCredits: (r.rateLimitResetCredits?.credits || []).filter(c => c.status === 'available').length, observedAt: Date.now(), source: 'codex app-server account/rateLimits/read' };
}
const AGY = '/Applications/Gemini.app/Contents/Helpers/agy';
// Gemini = Antigravity agy on the user's Google subscription login. API-key env vars are ignored on purpose.
export function geminiCliInstalled(bin = AGY) {
  try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch { return false; }
}
// Kept for compatibility: parses "<model> ... N% used/left" lines if agy ever reports quota.
export function parseGeminiStats(text) {
  const windows = [];
  for (const m of String(text).matchAll(/^\s*([\w.\-]*gemini[\w.\-]*)[^\n%]*?(\d+(?:\.\d+)?)%\s*(used|left|remaining)([^\n]*)/gim)) {
    const n = Number(m[2]), used = /used/i.test(m[3]) ? n : 100 - n;
    if (!validPercent(used)) continue;
    const reset = m[4].match(/resets?\s*(?:in|at)?\s*([^)\n]+)/i);
    windows.push({ name: `Daily · ${m[1]}`, usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsText: reset?.[1]?.trim() || null });
  }
  return windows;
}
// agy has no quota endpoint: report subscription-login status instead of a percentage.
export async function readGeminiQuota(bin = AGY, options = {}) {
  const diagnostic = await probeGeminiReadiness({ command: bin, signal: options.signal, env: options.env, now: options.now,
    ...(options.run ? { run: (command, args, settings) => options.run(command, args, { ms: settings.timeoutMs, signal: settings.signal, env: settings.env }) } : {}) });
  if (!diagnostic.authenticated) {
    const error = new Error(diagnostic.reason); error.geminiReadiness = diagnostic; throw error;
  }
  return { windows: [], status: 'Subscription login', authenticated: true, quotaState: 'unsupported', model: options.model || 'gemini-4-argon-medium', modelIds: diagnostic.modelIds, authState: diagnostic.authState,
    note: 'Subscription login is verified; this CLI does not expose remaining quota.', observedAt: Date.parse(diagnostic.checkedAt), source: 'agy models' };
}


// Expose only the classified CLI diagnostic, never raw CLI output or credentials.
function geminiQuotaStatus(value, diagnostic, checkedAt = Date.now()) {
  const source = diagnostic || (value ? { authenticated: true, needsLogin: false, authState: 'ready', reason: null,
    checkedAt: new Date(value.observedAt || checkedAt).toISOString(), loginCommand: null, modelIds: value.modelIds || [] } : {});
  return { authenticated: source.authenticated === true, needsLogin: source.needsLogin === true,
    authState: ['ready', 'needs-login', 'unknown', 'unavailable'].includes(source.authState) ? source.authState : 'unknown',
    reason: source.reason || null, checkedAt: source.checkedAt || new Date(checkedAt).toISOString(),
    loginCommand: source.loginCommand || null, modelIds: Array.isArray(source.modelIds) ? source.modelIds.slice(0, 100) : [] };
}

let shared = null;
// One poller per server process, shared by the usage panel and the task router.
export function sharedQuota() { return (shared ||= quotaPoller()); }

export function quotaPoller({ claudeEveryMs = 10 * 60000, codexEveryMs = 60000, geminiEveryMs = 60000 } = {}) {
  const state = { claude: null, codex: null, gemini: null, claudeError: null, codexError: null, geminiError: null, geminiStatus: null };
  let gBusy = false;
  const pollGemini = () => {
    if (gBusy) return;
    if (!geminiCliInstalled()) {
      state.gemini = null; state.geminiError = 'Antigravity agy CLI not found.';
      state.geminiStatus = geminiQuotaStatus(null, { authState: 'unavailable', reason: state.geminiError }); return;
    }
    gBusy = true;
    readGeminiQuota().then(value => { state.gemini = value; state.geminiError = null; state.geminiStatus = geminiQuotaStatus(value); })
      .catch(error => { state.gemini = null; state.geminiError = error.geminiReadiness?.reason || 'Gemini connection could not be verified. Check agy and the network.';
        state.geminiStatus = geminiQuotaStatus(null, error.geminiReadiness); })
      .finally(() => { gBusy = false; });
  };
  pollGemini(); setInterval(pollGemini, geminiEveryMs).unref();
  let cBusy = false, xBusy = false;
  const pollClaude = () => { if (cBusy) return; cBusy = true; readClaudeQuota().then(v => { state.claude = v; state.claudeError = null; }).catch(e => { state.claudeError = e.message; }).finally(() => { cBusy = false; }); };
  const pollCodex = () => { if (xBusy) return; xBusy = true; readCodexQuota().then(v => { state.codex = v; state.codexError = null; }).catch(e => { state.codexError = e.message; }).finally(() => { xBusy = false; }); };
  pollClaude(); pollCodex(); setInterval(pollClaude, claudeEveryMs).unref(); setInterval(pollCodex, codexEveryMs).unref();
  return state;
}


// Only used by configured installs. Construction/import does not enumerate logs,
// start a process or create a timer. Legacy helpers above remain independent.
function resolveUsageCommand(command, env = process.env) {
  if (typeof command !== 'string' || !command.trim() || /[\x00\r\n]/.test(command)) return null;
  const candidates = path.isAbsolute(command) ? [command]
    : /[\/\\]/.test(command) ? [] : String(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, command));
  return candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

export function createConfiguredUsage(configuration, qwenClient, options = {}) {
  const enabled = key => configuration?.mode === 'enabled' && configuration?.providers?.[key]?.enabled === true;
  const enabledProviders = () => stopped ? [] : ['claude', 'codex', 'gemini', 'local-qwen', 'grok-bot'].filter(enabled).map(key => key === 'grok-bot' ? 'grok' : key);
  const labels = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', 'local-qwen': 'Local Qwen', 'grok-bot': 'Grok' };
  const clock = options.now || Date.now, home = options.home || os.homedir();
  const environment = options.env || process.env;
  const resolveCommand = options.resolveCommand || resolveUsageCommand;
  const controller = new AbortController();
  const intervals = new Set(), busy = new Set();
  let started = false, stopped = false, last = null, at = 0, pending = null;
  const state = { claude: null, codex: null, gemini: null, grok: null,
    claudeError: null, codexError: null, geminiError: null, grokError: null, grokStatus: null, geminiStatus: null };
  const quotaReaders = {
    claude: settings => (options.readClaudeQuota || readClaudeQuota)(home, settings),
    codex: settings => (options.readCodexQuota || readCodexQuota)(settings),
    gemini: settings => (options.readGeminiQuota || readGeminiQuota)(settings.command, settings),
  };
  const poll = async key => {
    if (stopped || !enabled(key) || busy.has(key)) return;
    busy.add(key);
    try {
      const provider = configuration.providers[key];
      const command = resolveCommand(provider.command, environment);
      if (!command) throw new Error('Configured CLI command was not found.');
      const value = await quotaReaders[key]({ command, model: provider.model, env: environment, signal: controller.signal, now: clock });
      if (!stopped) { state[key] = value; state[`${key}Error`] = null;
        if (key === 'gemini') state.geminiStatus = geminiQuotaStatus(value, null, clock());
      }
    } catch (error) { if (!stopped) {
      if (key === 'gemini') { state.gemini = null; state.geminiStatus = geminiQuotaStatus(null, error.geminiReadiness, clock()); }
      state[`${key}Error`] = key === 'gemini' && error.geminiReadiness?.reason || 'Quota unavailable. Check the configured CLI and subscription login.';
    } }
    finally { busy.delete(key); }
  };
  function start() {
    if (started || stopped) return;
    started = true;
    for (const key of ['claude', 'codex', 'gemini']) {
      if (!enabled(key)) { state[`${key}Error`] = 'Disabled in office settings.'; continue; }
      void poll(key);
      const everyMs = options[`${key}EveryMs`] || (key === 'codex' || key === 'gemini' ? 60000 : 600000);
      const timer = (options.setInterval || setInterval)(() => { void poll(key); }, Math.max(1000, everyMs));
      timer.unref?.(); intervals.add(timer);
    }
  }
  function quotaReader() {
    start();
    if (!stopped && enabled('grok-bot')) {
      const result = (options.readGrokQuota || readGrokQuota)(configuration.dataDir, clock());
      state.grok = result.value; state.grokError = result.error; state.grokStatus = result.status || null;
    }
    const visible = { ...state };
    for (const key of ['claude', 'codex', 'gemini', 'grok']) if (!enabled(key === 'grok' ? 'grok-bot' : key)) { visible[key] = null; visible[`${key}Error`] = 'Disabled in office settings.'; }
    if (!enabled('grok-bot')) visible.grokStatus = null;
    if (!enabled('gemini')) visible.geminiStatus = null;
    return structuredClone(visible);
  }
  async function readProviders() {
    const providers = [];
    for (const [key, label] of Object.entries(labels)) {
      if (!enabled(key) || stopped) continue;
      try {
        if (key === 'claude' || key === 'codex') {
          const reader = key === 'claude' ? options.readClaudeUsage || readClaudeUsage : options.readCodexUsage || readCodexUsage;
          providers.push(await reader(home));
        } else if (key === 'local-qwen') {
          if (!qwenClient?.snapshot) throw new Error('Local Qwen is not configured.');
          providers.push({ ...await qwenClient.snapshot(), models: [], limits: null });
        } else if (key === 'gemini') {
          const model = configuration.providers.gemini.model;
          providers.push({ provider: label, models: [], limits: null,
            limitsNote: state.gemini?.status === 'Subscription login' && !state.geminiError
              ? `Subscription login verified via agy models.${model ? ` Configured model: ${model}.` : ''} No quota API.`
              : 'Subscription login has not been verified. Configure agy and sign in with your Google account.' });
        } else providers.push({ provider: label, models: [], limits: null, limitsNote: 'Quota is reported by Grok Bot into the configured local data directory.' });
      } catch { providers.push({ provider: label, models: [], limits: null, error: 'unavailable' }); }
    }
    return { generatedAt: clock(), providers, enabledProviders: enabledProviders(), ...(providers.length ? {} : { limitsNote: stopped ? 'Usage monitor stopped.' : 'Usage is disabled until execution mode and providers are enabled in office settings.' }) };
  }
  async function reader() {
    start();
    if (stopped) return { generatedAt: clock(), providers: [], enabledProviders: [], quota: structuredClone(state), limitsNote: 'Usage monitor stopped.' };
    if (!last || clock() - at >= 30000) {
      pending ||= readProviders().then(value => { if (!stopped) { last = value; at = clock(); } return value; }).finally(() => { pending = null; });
      await pending;
    }
    if (stopped) return { generatedAt: clock(), providers: [], enabledProviders: [], quota: structuredClone(state), limitsNote: 'Usage monitor stopped.' };
    const providers = (last?.providers || []).filter(item => Object.entries(labels).some(([key, label]) => label === item.provider && enabled(key)));
    return structuredClone({ ...last, providers, enabledProviders: enabledProviders(), ...(!providers.length ? { limitsNote: 'Usage is disabled until execution mode and providers are enabled in office settings.' } : {}), quota: quotaReader() });
  }
  function stop() {
    if (stopped) return;
    stopped = true; for (const timer of intervals) (options.clearInterval || clearInterval)(timer); intervals.clear();
    controller.abort(new Error('Usage monitor stopped.'));
  }
  return { reader, quotaReader, stop };
}
