// Read-only local usage summary. Only token counts / rate-limit percentages are read
// from CLI session logs; no credential files (auth.json, keys) are ever opened.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { localQwen } from './local-qwen.mjs';

const DAY = 864e5;
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
  return { provider: 'Claude Code', source: '~/.claude/projects/*.jsonl', models: Object.values(models).sort((a, b) => b.week.total - a.week.total),
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
  const win = w => w ? { usedPercent: w.used_percent, remainingPercent: Math.max(0, 100 - w.used_percent), windowMinutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null } : null;
  return { provider: 'Codex', source: '~/.codex/sessions/**/*.jsonl', models: Object.values(models).sort((a, b) => b.week.total - a.week.total),
    limits: limits ? { plan: limits.plan_type || null, primary: win(limits.primary), secondary: win(limits.secondary), credits: limits.credits ? { balance: limits.credits.balance, hasCredits: limits.credits.has_credits, unlimited: limits.credits.unlimited } : null, observedAt: limitsAt } : null,
    limitsNote: limits ? 'Snapshot from the most recent Codex turn; it updates only when Codex runs.' : 'No Codex rate-limit snapshot in the last 7 days.' };
}

export async function readUsage(options = {}) {
  const safe = async (fn, provider) => { try { return await fn(options.home); } catch (e) { return { provider, models: [], limits: null, error: 'unavailable' }; } };
  const providers = [await safe(readClaudeUsage, 'Claude Code'), await safe(readCodexUsage, 'Codex'),
    { provider: 'Gemini', models: [], limits: null, limitsNote: geminiLoggedIn() ? 'Subscription login (Google account via Antigravity agy) · model gemini-4-argon-medium · read-only research. No quota API; no API key or usage billing.' : 'Needs login: run /Applications/Gemini.app/Contents/Helpers/agy in Terminal and sign in.' },
    { ...await (options.qwenClient || localQwen).snapshot(), models: [], limits: null },
    { provider: 'Grok', models: [], limits: null, limitsNote: 'Reported by Grok Bot via scripts/office-board.mjs grok-quota.' }];
  return { generatedAt: Date.now(), providers };
}

// Grok Bot reports its own weekly quota into this file (no API, no credentials).
export const GROK_STALE_MS = 6 * 36e5;
export const grokQuotaFile = (root = process.cwd()) => path.join(root, 'reports', 'grok-quota.json');
export function readGrokQuota(root, now = Date.now()) {
  let d;
  try { d = JSON.parse(fs.readFileSync(grokQuotaFile(root), 'utf8')); } catch { return { value: null, error: 'stale' }; }
  const used = Number(d.usedPercent), at = Number(d.observedAt), reset = Number(d.resetsAt);
  if (!Number.isFinite(used) || !Number.isFinite(at)) return { value: null, error: 'stale' };
  const value = { plan: d.plan || null, observedAt: at, reporter: 'Grok Bot', source: 'reports/grok-quota.json', note: d.note || null,
    windows: [{ name: 'Weekly', usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: Number.isFinite(reset) ? reset : null, absoluteReset: true }] };
  return now - at > GROK_STALE_MS ? { value, error: 'stale' } : { value, error: null };
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
    return structuredClone({ ...last, quota: { ...(options.quotaReader || sharedQuota)(), grok: grok.value, grokError: grok.error } });
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
const run = (bin, args, { input, ms = 90000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { cwd: os.tmpdir(), env: workerEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, ms);
  child.stdout.on('data', d => { out += d; if (input?.done?.(out)) { clearTimeout(timer); child.kill(); resolve(out); } });
  child.on('error', e => { clearTimeout(timer); reject(e); });
  child.on('close', () => { clearTimeout(timer); resolve(out); });
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
    windows.push({ name: `${m[1] === 'session' ? '5-hour session' : 'Weekly'}${m[2] ? ` · ${m[2]}` : ''}`, usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsText: m[4]?.trim() || null });
  }
  return windows;
}
export async function readClaudeQuota(home) {
  const bin = claudeBin(home); if (!bin) throw new Error('Claude CLI not found');
  const raw = await run(bin, ['-p', '/usage', '--output-format', 'json'], { ms: 150000 });
  const result = JSON.parse(raw.slice(raw.indexOf('{'))).result || '';
  const windows = parseClaudeUsage(result);
  if (!windows.length) throw new Error('No quota lines in /usage output');
  return { windows, observedAt: Date.now(), source: 'claude -p /usage' };
}
// Codex app-server `account/rateLimits/read`: official, free, ~1s.
export async function readCodexQuota() {
  const bin = codexBin(); if (!bin) throw new Error('Codex CLI not found');
  const msgs = [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai_office', version: '1.0' } } }, { method: 'initialized' }, { id: 2, method: 'account/rateLimits/read' }].map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const out = await run(bin, ['app-server'], { ms: 20000, input: { text: msgs, keepOpen: true, done: o => /"id":2,/.test(o) && o.trimEnd().endsWith('}') && o.split('\n').some(l => l.startsWith('{"id":2')) } });
  const line = out.split('\n').find(l => l.startsWith('{"id":2')); const r = JSON.parse(line).result;
  const windows = [];
  for (const lim of Object.values(r.rateLimitsByLimitId || { codex: r.rateLimits })) for (const key of ['primary', 'secondary']) { const w = lim?.[key]; if (!w) continue;
    const mins = w.windowDurationMins; windows.push({ name: `${mins === 300 ? '5-hour' : mins === 10080 ? 'Weekly' : `${Math.round(mins / 60)}h`}${lim.limitName || lim.normalModelSlug ? ` · ${lim.limitName || lim.normalModelSlug}` : ''}`, usedPercent: w.usedPercent, remainingPercent: Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }); }
  return { windows, plan: r.rateLimits?.planType || null, credits: r.rateLimits?.credits?.balance ?? null, resetCredits: (r.rateLimitResetCredits?.credits || []).filter(c => c.status === 'available').length, observedAt: Date.now(), source: 'codex app-server account/rateLimits/read' };
}
const AGY = '/Applications/Gemini.app/Contents/Helpers/agy';
// Gemini = Antigravity agy on the user's Google subscription login. API-key env vars are ignored on purpose.
export function geminiLoggedIn(bin = AGY) {
  try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch { return false; }
}
// Kept for compatibility: parses "<model> ... N% used/left" lines if agy ever reports quota.
export function parseGeminiStats(text) {
  const windows = [];
  for (const m of String(text).matchAll(/^\s*([\w.\-]*gemini[\w.\-]*)[^\n%]*?(\d+(?:\.\d+)?)%\s*(used|left|remaining)([^\n]*)/gim)) {
    const n = Number(m[2]), used = /used/i.test(m[3]) ? n : 100 - n;
    const reset = m[4].match(/resets?\s*(?:in|at)?\s*([^)\n]+)/i);
    windows.push({ name: `Daily · ${m[1]}`, usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsText: reset?.[1]?.trim() || null });
  }
  return windows;
}
// agy has no quota endpoint: report subscription-login status instead of a percentage.
export async function readGeminiQuota(bin = AGY) {
  const out = await run(bin, ['models'], { ms: 30000 });
  if (!/gemini-/i.test(out)) throw new Error('Needs login: run agy in Terminal and sign in with your Google account.');
  return { windows: [], status: 'Subscription login', model: 'gemini-4-argon-medium', note: 'Signed in via Antigravity (Google subscription). No quota API.', observedAt: Date.now(), source: 'agy models' };
}

let shared = null;
// One poller per server process, shared by the usage panel and the task router.
export function sharedQuota() { return (shared ||= quotaPoller()); }

export function quotaPoller({ claudeEveryMs = 10 * 60000, codexEveryMs = 60000, geminiEveryMs = 10 * 60000 } = {}) {
  const state = { claude: null, codex: null, gemini: null, claudeError: null, codexError: null, geminiError: null };
  let gBusy = false;
  const pollGemini = () => { if (gBusy) return; if (!geminiLoggedIn()) { state.gemini = null; state.geminiError = 'Antigravity agy CLI not found.'; return; } gBusy = true; readGeminiQuota().then(v => { state.gemini = v; state.geminiError = null; }).catch(e => { state.geminiError = e.message; }).finally(() => { gBusy = false; }); };
  pollGemini(); setInterval(pollGemini, geminiEveryMs).unref();
  let cBusy = false, xBusy = false;
  const pollClaude = () => { if (cBusy) return; cBusy = true; readClaudeQuota().then(v => { state.claude = v; state.claudeError = null; }).catch(e => { state.claudeError = e.message; }).finally(() => { cBusy = false; }); };
  const pollCodex = () => { if (xBusy) return; xBusy = true; readCodexQuota().then(v => { state.codex = v; state.codexError = null; }).catch(e => { state.codexError = e.message; }).finally(() => { xBusy = false; }); };
  pollClaude(); pollCodex(); setInterval(pollClaude, claudeEveryMs).unref(); setInterval(pollCodex, codexEveryMs).unref();
  return state;
}
